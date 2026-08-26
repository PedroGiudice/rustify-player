#!/usr/bin/env python3
"""Exporta os artefatos da biblioteca pro Rustify Android — um trilho, seis
artefatos (CMR-190/CMR-191/CMR-194/CMR-212):

  manifest.json   track_id ↔ rel_path + metadata + like (CMR-220) + cover
  vectors.bin     vetores mert 768d f32 L2-normalizados por track_id
  taste.json      snapshot de gosto (réplica de derive_behavioral_signals)
  stations.json   stations do desktop + pool precomputado por station
  sync-token      Bearer do sync de eventos (CMR-194)
  covers/         uma capa por ÁLBUM-KEY do desktop (`<sha1>.jpg`, paridade
                  com o cache do desktop), direto no STAGING da cmr-auto;
                  cover.jpg por pasta continua como fallback (tracks sem
                  cover_path, manifest/APK antigos)

O track_id no desktop é hash do PATH ABSOLUTO da cmr-auto (types.rs
path_to_id) — o celular não consegue derivá-lo dos arquivos transcodados.
track_id sai como STRING em todo JSON: valores u64 > 2^53 corrompem em JS
Number. No vectors.bin o id é u64 little-endian cru.

A derivação de gosto e os pools são DESKTOP-side por decisão de arquitetura
(CMR-190): o celular consome artefatos, não deriva sinal. A lógica de
taste.json replica `derive_behavioral_signals` + `behavioral_signals` de
crates/library-indexer/src/qdrant_client.rs — AQUELE arquivo é a fonte da
verdade; mudou lá, muda aqui.

Uso (na VM; túnel idempotente pro Qdrant da cmr-auto é pré-requisito):
  ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
  python3 scripts/android/export_manifest.py --out-dir /tmp/rustify-export
  # com entrega no staging do phone-sync (scp + conversão de capas via ssh):
  python3 scripts/android/export_manifest.py --deploy

Depois do deploy, o rail existente leva tudo ao S24:
  ssh cmr-auto@100.102.249.9 '~/phone_push_retry.sh'   # adb push --sync
e no app: lib_rescan (ou reabrir).
"""

import argparse
import json
import math
import struct
import subprocess
import sys
import time
import urllib.request

QDRANT = "http://127.0.0.1:16333"
COLLECTION = "rustify_tracks"
EVENTS = "play_events"
ENRICHMENTS = "track_enrichments"
MUSIC_ROOT = "/home/cmr-auto/Music/"
CMR_AUTO = "cmr-auto@100.102.249.9"
STATIONS_DIR = "/home/cmr-auto/.local/share/rustify-player/stations"
COVER_CACHE = "/home/cmr-auto/.cache/rustify-player"
STAGING = "/home/cmr-auto/.cache/phone-sync/Music"
# data_dir REAL do desktop (desktop.rs) — não confundir com o dir de logs
# do plugin (~/.local/share/dev.cmr.rustifyplayer/).
SYNC_TOKEN = "/home/cmr-auto/.local/share/rustify-player/sync-token"
FIELDS = [
    "path", "title", "artist", "album_title", "duration_ms",
    "track_number", "disc_number", "genre", "album_year", "cover_path",
    "dominant_color",
]

# ── Constantes do sinal v3 — espelho de qdrant_client.rs (fonte da verdade) ──
SIGNAL_SCHEMA = 3
HALF_LIFE_DAYS = 14.0
POSITIVE_MIN_LISTEN_PCT = 0.30
POSITIVE_RAMP_SPAN = 0.50
NEGATIVE_WEIGHT_FLOOR = -0.6
QUALIFY_FLOOR = 0.55
NEGATIVE_NET_THRESHOLD = -0.30
FULL_ATTENTION_MS = 90_000.0
PASSIVE_ORIGINS = {"autoplay", "station", "playlist"}
PASSIVE_WEIGHT = 0.6
MAX_BEHAVIORAL_POSITIVES = 25
MAX_TOTAL_POSITIVES = 35
MAX_NEGATIVES = 40

# Vocabulários canônicos anotados em track_enrichments (qdrant_client.rs).
# Só a camada de passthrough do MoodFilters::parse é replicada — as stations
# reais usam tokens canônicos; token fora do vocabulário gera WARNING.
MOOD_VOCAB = {
    "aggressive", "anxious", "bittersweet", "chill", "confident", "dark",
    "dreamy", "driving", "energetic", "ethereal", "focus", "groovy",
    "intense", "melancholic", "nostalgic", "peaceful", "playful", "raw",
    "rebellious", "romantic", "sensual", "social", "triumphant", "uplifting",
}
ACTIVITY_VOCAB = {
    "chill", "cleaning", "commute", "cooking", "driving", "focus", "gaming",
    "meditation", "party", "romance", "sleep", "social", "study", "workout",
}

SEED_POOL_CAP = 150
MOOD_POOL_CAP = 300


def qpost(base_url: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)["result"]


def scroll_all(base_url: str, with_vector) -> list[dict]:
    points, offset = [], None
    while True:
        body = {"limit": 200, "with_payload": FIELDS, "with_vector": with_vector}
        if offset is not None:
            body["offset"] = offset
        result = qpost(base_url, f"/collections/{COLLECTION}/points/scroll", body)
        points.extend(result["points"])
        offset = result.get("next_page_offset")
        if offset is None:
            return points


def to_int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


# ─────────────────────────────────────────────────────────────────────────────
# manifest.json
# ─────────────────────────────────────────────────────────────────────────────

def fetch_like_state(base_url: str) -> dict[str, tuple[int | None, int | None]]:
    """Estado do like por track_id (string) a partir de track_enrichments:
    `(liked_at, like_updated_at)`. Scroll PAGINADO (o recent_likes acima cabe
    em uma página porque só quer o top-10; aqui é o acervo inteiro). Entram
    pontos com like OU com carimbo — a descurtida (liked_at null +
    like_updated_at) precisa viajar para o LWW do aparelho não ressuscitar um
    like antigo. Ids que não são u64 (fora do acervo) ficam de fora."""
    state: dict[str, tuple[int | None, int | None]] = {}
    offset = None
    while True:
        body = {
            "limit": 500,
            "with_payload": {"include": ["liked_at", "like_updated_at"]},
            "with_vector": False,
        }
        if offset is not None:
            body["offset"] = offset
        result = qpost(base_url, f"/collections/{ENRICHMENTS}/points/scroll", body)
        for p in result["points"]:
            tid = p.get("id")
            if not isinstance(tid, int):
                continue
            pl = p.get("payload") or {}
            liked_at = to_int(pl.get("liked_at")) or None
            updated_at = to_int(pl.get("like_updated_at")) or None
            if liked_at is None and updated_at is None:
                continue
            state[str(tid)] = (liked_at, updated_at)
        offset = result.get("next_page_offset")
        if offset is None:
            return state


def cover_rel(cover_path: str | None) -> str | None:
    """`covers/<sha1>.webp` (cache do desktop, cover.rs) → `covers/<sha1>.jpg`,
    relativo a `.rustify/` no aparelho — o nome que deploy_covers produz.
    None sem cover_path."""
    if not cover_path:
        return None
    stem = cover_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return f"covers/{stem}.jpg"


def build_manifest(points: list[dict], like_state: dict | None = None) -> dict:
    tracks, skipped = [], 0
    like_state = like_state or {}
    for p in points:
        pl = p["payload"]
        path = pl.get("path") or ""
        if not path.startswith(MUSIC_ROOT):
            skipped += 1
            continue
        liked_at, like_updated_at = like_state.get(str(p["id"]), (None, None))
        tracks.append({
            # point id do Qdrant É o track_id (u64) — string, ver docstring.
            "track_id": str(p["id"]),
            "rel_path": path[len(MUSIC_ROOT):],
            "title": pl.get("title") or "",
            "artist": pl.get("artist") or "",
            "album": pl.get("album_title") or "",
            "duration_ms": to_int(pl.get("duration_ms")),
            "track_number": to_int(pl.get("track_number")),
            "disc_number": to_int(pl.get("disc_number"), 1),
            "genre": pl.get("genre") or "",
            # payload heterogêneo no Qdrant: "1995" (str) e 2025 (int) coexistem
            "album_year": to_int(pl.get("album_year")) or None,
            # hex "#rrggbb" do cover.rs (ink/accent adaptativos no aparelho)
            "dominant_color": pl.get("dominant_color") or None,
            # Estado do like (CMR-220): verdade do desktop na hora do export;
            # o aparelho aplica LWW contra o override local por like_updated_at.
            "liked_at": liked_at,
            "like_updated_at": like_updated_at,
            # Capa por álbum-key (CMR-212): o aparelho usa se o arquivo existir
            # em .rustify/covers/, senão cai pro cover.jpg da pasta.
            "cover": cover_rel(pl.get("cover_path")),
        })
    tracks.sort(key=lambda t: t["rel_path"])
    if skipped:
        print(f"manifest: {skipped} tracks fora do root ignoradas")
    return {
        "schema": 1,
        "generated_at": int(time.time()),
        "source_device": "cmr-auto",
        "music_root": MUSIC_ROOT.rstrip("/"),
        "track_count": len(tracks),
        "tracks": tracks,
    }


# ─────────────────────────────────────────────────────────────────────────────
# vectors.bin — magic "RSTFVEC1" + u32 dim + u32 count + count×(u64 id, dim×f32)
# tudo little-endian; vetores L2-normalizados (similaridade no device = dot)
# ─────────────────────────────────────────────────────────────────────────────

def build_vectors_bin(points: list[dict]) -> bytes:
    records = []
    dim = None
    for p in points:
        vec = (p.get("vector") or {}).get("mert")
        if not vec:
            continue
        if dim is None:
            dim = len(vec)
        elif len(vec) != dim:
            print(f"vectors: dim inconsistente em {p['id']} ({len(vec)} != {dim}) — pulada")
            continue
        norm = math.sqrt(sum(x * x for x in vec))
        if norm <= 0:
            continue
        records.append((int(p["id"]), [x / norm for x in vec]))
    records.sort(key=lambda r: r[0])
    dim = dim or 0
    out = bytearray()
    out += b"RSTFVEC1"
    out += struct.pack("<II", dim, len(records))
    for tid, vec in records:
        out += struct.pack("<Q", tid)
        out += struct.pack(f"<{dim}f", *vec)
    print(f"vectors.bin: {len(records)} vetores {dim}d ({len(out) / 1e6:.1f}MB)")
    return bytes(out)


# ─────────────────────────────────────────────────────────────────────────────
# taste.json — réplica de behavioral_signals (I/O) + derive_behavioral_signals
# ─────────────────────────────────────────────────────────────────────────────

def scroll_play_events(base_url: str, filt: dict, limit: int) -> list[dict]:
    body = {
        "filter": filt,
        "limit": limit,
        "with_payload": True,
        "with_vector": False,
        "order_by": {"key": "started_at", "direction": "desc"},
    }
    result = qpost(base_url, f"/collections/{EVENTS}/points/scroll", body)
    return [p["payload"] for p in result["points"] if p.get("payload")]


def recent_likes(base_url: str, limit: int) -> list[int]:
    body = {
        "filter": {"must": [{"key": "liked_at", "range": {"gt": 0}}]},
        "limit": 1000,
        "with_payload": {"include": ["liked_at"]},
        "with_vector": False,
    }
    result = qpost(base_url, f"/collections/{ENRICHMENTS}/points/scroll", body)
    likes = [
        (p["id"], p["payload"]["liked_at"])
        for p in result["points"]
        if isinstance(p.get("id"), int) and p.get("payload", {}).get("liked_at")
    ]
    likes.sort(key=lambda x: -x[1])
    return [tid for tid, _ in likes[:limit]]


def derive_behavioral_signals(pos_payloads, neg_payloads, liked_recent, now):
    """Réplica 1:1 da função pura de qdrant_client.rs (sinal v3)."""
    acc = {}  # tid -> [net, raw_pos, last_at]
    for p in list(pos_payloads) + list(neg_payloads):
        tid = p.get("track_id")
        if not isinstance(tid, int):
            continue
        started = p.get("started_at") or 0
        age_days = max(now - started, 0) / 86_400.0
        decay = 0.5 ** (age_days / HALF_LIFE_DAYS)
        lp = p.get("listen_pct") or 0.0
        w = (lp - POSITIVE_MIN_LISTEN_PCT) / POSITIVE_RAMP_SPAN
        w = max(NEGATIVE_WEIGHT_FLOOR, min(1.0, w))
        e = acc.setdefault(tid, [0.0, 0.0, -(2**62)])
        if w > 0.0:
            listened_ms = p.get("end_position_ms")
            if listened_ms is None:
                dur = p.get("duration_ms")
                listened_ms = dur * lp if dur is not None else math.inf
            attention = min(listened_ms / FULL_ATTENTION_MS, 1.0)
            origin_w = PASSIVE_WEIGHT if p.get("origin") in PASSIVE_ORIGINS else 1.0
            w = w * attention * origin_w
            e[0] += w * decay
            e[1] += w
        else:
            e[0] += w * decay
        e[2] = max(e[2], started)

    qualified = [
        (tid, a[0], a[2]) for tid, a in acc.items()
        if a[1] >= QUALIFY_FLOOR and a[0] > 0.0
    ]
    qualified.sort(key=lambda x: (-x[1], -x[2], x[0]))
    qualified = qualified[:MAX_BEHAVIORAL_POSITIVES]
    positives = [(tid, net) for tid, net, _ in qualified]

    negs = [
        (tid, a[0], a[2]) for tid, a in acc.items()
        if a[0] <= NEGATIVE_NET_THRESHOLD
    ]
    negs.sort(key=lambda x: (x[1], -x[2], x[0]))
    negatives = [(tid, net) for tid, net, _ in negs[:MAX_NEGATIVES]]

    pos_seen = {tid for tid, _ in positives}
    neg_set = {tid for tid, _ in negatives}
    for tid in liked_recent:
        if len(positives) >= MAX_TOTAL_POSITIVES:
            break
        if tid not in neg_set and tid not in pos_seen:
            pos_seen.add(tid)
            positives.append((tid, None))  # like explícito, sem saldo derivado

    return positives, negatives


def build_taste(base_url: str) -> tuple[dict, list[int], list[int]]:
    event_type = {"key": "event_type", "match": {"any": ["track_ended", "track_skipped"]}}
    not_album_seq = [{"key": "origin", "match": {"value": "album_seq"}}]
    pos_payloads = scroll_play_events(base_url, {
        "must": [event_type, {"key": "listen_pct", "range": {"gte": POSITIVE_MIN_LISTEN_PCT}}],
        "must_not": not_album_seq,
    }, 300)
    neg_payloads = scroll_play_events(base_url, {
        "must": [event_type, {"key": "listen_pct", "range": {"lt": POSITIVE_MIN_LISTEN_PCT}}],
        "must_not": not_album_seq,
    }, 300)
    liked = recent_likes(base_url, 10)
    now = int(time.time())
    positives, negatives = derive_behavioral_signals(pos_payloads, neg_payloads, liked, now)
    taste = {
        "schema": 1,
        "generated_at": now,
        "signal_schema": SIGNAL_SCHEMA,
        "positives": [{"track_id": str(t), "weight": w} for t, w in positives],
        "negatives": [{"track_id": str(t), "weight": w} for t, w in negatives],
    }
    print(f"taste.json: {len(positives)} positives, {len(negatives)} negatives "
          f"(eventos: {len(pos_payloads)}+{len(neg_payloads)}, likes: {len(liked)})")
    return taste, [t for t, _ in positives], [t for t, _ in negatives]


# ─────────────────────────────────────────────────────────────────────────────
# stations.json — defs do desktop (via ssh) + pool precomputado por station
# ─────────────────────────────────────────────────────────────────────────────

def fetch_station_defs() -> list[dict]:
    reader = (
        "import json, glob\n"
        f"files = sorted(glob.glob({STATIONS_DIR!r} + '/*.json'))\n"
        "out = []\n"
        "for f in files:\n"
        "    try:\n"
        "        out.append(json.load(open(f)))\n"
        "    except Exception as e:\n"
        "        print(f'skip {f}: {e}', file=__import__('sys').stderr)\n"
        "print(json.dumps(out))\n"
    )
    proc = subprocess.run(
        ["ssh", CMR_AUTO, "python3", "-"],
        input=reader, capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        print(f"stations: ssh falhou ({proc.stderr.strip()}) — stations.json vazio")
        return []
    if proc.stderr.strip():
        print(f"stations: {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        print(f"stations: resposta ilegível ({e}) — stations.json vazio")
        return []


def recommend(base_url: str, positive: list[int], negative: list[int], limit: int) -> list[int]:
    body = {
        "positive": positive,
        "strategy": "best_score",
        "using": "mert",
        "limit": limit,
        "with_payload": False,
        "with_vector": False,
    }
    if negative:
        body["negative"] = negative
    result = qpost(base_url, f"/collections/{COLLECTION}/points/recommend", body)
    return [p["id"] for p in result]


def seed_pool(base_url: str, seeds: list[int], negatives: list[int]) -> list[int]:
    """Mistura as vizinhanças de cada seed (paridade com generate_station_batch:
    per-seed recommend em mert, interleave, dedup)."""
    seeds = list(dict.fromkeys(seeds))
    if not seeds:
        return []
    per_seed = max(SEED_POOL_CAP // len(seeds), 15)
    neighborhoods = []
    for sid in seeds:
        try:
            neighborhoods.append(recommend(base_url, [sid], negatives, per_seed))
        except Exception as e:
            print(f"stations: recommend do seed {sid} falhou: {e}")
            neighborhoods.append([])
    pool, seen = [], set(seeds)
    for layer in range(per_seed):
        for hood in neighborhoods:
            if layer < len(hood) and hood[layer] not in seen:
                seen.add(hood[layer])
                pool.append(hood[layer])
    return pool[:SEED_POOL_CAP]


def mood_pool(base_url: str, query: str) -> list[int]:
    """Passthrough canônico do MoodFilters::parse (mood checado primeiro —
    resolve os tokens ambíguos a favor de mood, igual ao desktop)."""
    must = []
    for tok in query.lower().split():
        if tok in MOOD_VOCAB:
            must.append({"key": "mood_tags", "match": {"value": tok}})
        elif tok in ACTIVITY_VOCAB:
            must.append({"key": "activity_tags", "match": {"value": tok}})
        else:
            print(f"stations: token '{tok}' fora do vocabulário canônico — IGNORADO "
                  f"(aliases do MoodFilters::parse não são replicados aqui)")
    if not must:
        return []
    result = qpost(base_url, f"/collections/{ENRICHMENTS}/points/scroll", {
        "filter": {"must": must},
        "limit": MOOD_POOL_CAP,
        "with_payload": False,
        "with_vector": False,
    })
    return [p["id"] for p in result["points"]]


def build_stations(base_url: str, negatives: list[int]) -> dict:
    defs = fetch_station_defs()
    stations = []
    for d in defs:
        kind = d.get("kind")
        seeds = [int(s) for s in d.get("seed_track_ids") or []]
        if kind == "seed":
            pool = seed_pool(base_url, seeds, negatives)
        elif kind == "mood":
            pool = mood_pool(base_url, d.get("query") or "")
        else:
            print(f"stations: kind desconhecido '{kind}' em {d.get('id')} — pulada")
            continue
        stations.append({
            "id": d.get("id"),
            "name": d.get("name"),
            "icon": d.get("icon") or "",
            "tone": d.get("tone") or "",
            "desc": d.get("desc") or "",
            "kind": kind,
            "query": d.get("query"),
            "seed_track_ids": [str(s) for s in seeds],
            "pool": [str(t) for t in pool],
        })
        print(f"stations: {d.get('name')!r} ({kind}) pool={len(pool)}")
    return {"schema": 1, "generated_at": int(time.time()), "stations": stations}


# ─────────────────────────────────────────────────────────────────────────────
# covers — (a) uma capa por álbum-key em .rustify/covers/<sha1>.jpg (CMR-212)
#          (b) cover.jpg por pasta de álbum (fallback)
# ambas convertidas do cache webp do desktop direto NO STAGING da cmr-auto
# ─────────────────────────────────────────────────────────────────────────────

def cover_jobs(points: list[dict]) -> tuple[dict[str, str], dict[str, str]]:
    """Dois mapas a partir do `cover_path` do Qdrant (pura, testada):
    `dir_cover`  pasta relativa → cover do cache da PRIMEIRA track vista
                 (setdefault) — o cover.jpg de fallback da pasta;
    `distinct`   `<sha1>.jpg` → cover do cache — uma conversão por álbum-key,
                 o que o desktop mostra (pasta com 2+ álbuns deixa de perder
                 capa)."""
    dir_cover: dict[str, str] = {}
    distinct: dict[str, str] = {}
    for p in points:
        pl = p["payload"]
        path, cover = pl.get("path") or "", pl.get("cover_path")
        if not cover or not path.startswith(MUSIC_ROOT):
            continue
        rel_dir = path[len(MUSIC_ROOT):].rsplit("/", 1)[0]
        dir_cover.setdefault(rel_dir, cover)
        distinct.setdefault(cover_rel(cover).rsplit("/", 1)[-1], cover)
    return dir_cover, distinct


def deploy_covers(points: list[dict]) -> None:
    """Converte (webp→jpg via ffmpeg, mesmo 600px do cache — sem resize) direto
    no staging do phone-sync, na cmr-auto: as capas distintas em
    `.rustify/covers/<sha1>.jpg` e o cover.jpg de cada pasta. Idempotente:
    pula destino já existente (contadores separados por trilho)."""
    dir_cover, distinct = cover_jobs(points)
    job = json.dumps({"dirs": dir_cover, "distinct": distinct})
    script = f"""
import json, subprocess, sys
from pathlib import Path
mapping = json.load(sys.stdin)
staging = Path({STAGING!r})
cache = Path({COVER_CACHE!r})

def convert(src, dst):
    r = subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error",
                        "-i", str(src), "-q:v", "3", str(dst)],
                       capture_output=True)
    if r.returncode != 0:
        dst.unlink(missing_ok=True)
    return r.returncode == 0

# (a) capas distintas por álbum-key → .rustify/covers/<sha1>.jpg
covers_dir = staging / ".rustify" / "covers"
covers_dir.mkdir(parents=True, exist_ok=True)
done = skipped = missing = failed = 0
for name, cover in mapping["distinct"].items():
    dst = covers_dir / name
    if dst.exists():
        skipped += 1
        continue
    src = cache / cover
    if not src.exists():
        missing += 1
        continue
    if convert(src, dst):
        done += 1
    else:
        failed += 1
print(f"covers/: {{done}} convertidas, {{skipped}} já existiam, "
      f"{{missing}} sem origem, {{failed}} falhas ({{len(mapping['distinct'])}} distintas)")

# (b) cover.jpg por pasta (fallback dos tracks sem cover_path e de manifest/APK antigos)
done = skipped = missing = failed = 0
for rel_dir, cover in mapping["dirs"].items():
    dst_dir = staging / rel_dir
    if not dst_dir.is_dir():
        missing += 1
        continue
    dst = dst_dir / "cover.jpg"
    if dst.exists():
        skipped += 1
        continue
    src = cache / cover
    if not src.exists():
        missing += 1
        continue
    if convert(src, dst):
        done += 1
    else:
        failed += 1
print(f"cover.jpg por pasta: {{done}} convertidas, {{skipped}} já existiam, "
      f"{{missing}} sem origem/pasta, {{failed}} falhas")
"""
    # ssh com script + dados: script e JSON vão como arquivos temp no destino.
    subprocess.run(["ssh", CMR_AUTO, "cat > /tmp/covers-job.py"],
                   input=script, text=True, check=True, timeout=30)
    subprocess.run(["ssh", CMR_AUTO, "cat > /tmp/covers-map.json"],
                   input=job, text=True, check=True, timeout=60)
    # Teto: ~565 distintas + ~600 pastas a ~0.3s/ffmpeg num run frio.
    proc = subprocess.run(
        ["ssh", CMR_AUTO, "python3 /tmp/covers-job.py < /tmp/covers-map.json"],
        capture_output=True, text=True, timeout=900,
    )
    print(proc.stdout.strip() or proc.stderr.strip())


def deploy_artifacts(out_dir: str) -> None:
    subprocess.run(["ssh", CMR_AUTO, f"mkdir -p {STAGING}/.rustify"], check=True, timeout=30)
    # Token Bearer do sync (CMR-194): garante um na cmr-auto (fonte da verdade,
    # mesmo arquivo que o receptor desktop lê) e leva a cópia no trilho — 5º
    # artefato que o phone_push_retry.sh empurra pro aparelho (o 6º, covers/,
    # nasce na própria cmr-auto em deploy_covers).
    subprocess.run(
        ["ssh", CMR_AUTO,
         f"test -f {SYNC_TOKEN} || (umask 077 && mkdir -p $(dirname {SYNC_TOKEN}) "
         f"&& openssl rand -hex 32 > {SYNC_TOKEN})"],
        check=True, timeout=30,
    )
    subprocess.run(
        ["scp", "-q", f"{CMR_AUTO}:{SYNC_TOKEN}", f"{out_dir}/sync-token"],
        check=True, timeout=30,
    )
    for name in ("manifest.json", "vectors.bin", "taste.json", "stations.json",
                 "sync-token"):
        subprocess.run(
            ["scp", "-q", f"{out_dir}/{name}", f"{CMR_AUTO}:{STAGING}/.rustify/{name}"],
            check=True, timeout=120,
        )
    print(f"deploy: 5 artefatos → {CMR_AUTO}:{STAGING}/.rustify/ "
          f"(6º = covers/, convertido a seguir)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant", default=QDRANT)
    ap.add_argument("--out-dir", default="/tmp/rustify-export")
    ap.add_argument("--deploy", action="store_true",
                    help="scp artefatos pro staging do phone-sync + capas via ssh")
    ap.add_argument("--skip-covers", action="store_true",
                    help="não converte capas (covers/ por álbum-key nem cover.jpg por pasta)")
    args = ap.parse_args()

    import os
    os.makedirs(args.out_dir, exist_ok=True)

    points = scroll_all(args.qdrant, with_vector=["mert"])
    print(f"scroll: {len(points)} pontos")

    like_state = fetch_like_state(args.qdrant)
    print(f"likes: {sum(1 for l, _ in like_state.values() if l)} curtidas, "
          f"{len(like_state)} pontos com estado")
    manifest = build_manifest(points, like_state)
    with open(f"{args.out_dir}/manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    print(f"manifest.json: {manifest['track_count']} tracks")

    vectors = build_vectors_bin(points)
    with open(f"{args.out_dir}/vectors.bin", "wb") as f:
        f.write(vectors)

    taste, _, negative_ids = build_taste(args.qdrant)
    with open(f"{args.out_dir}/taste.json", "w", encoding="utf-8") as f:
        json.dump(taste, f, ensure_ascii=False, separators=(",", ":"))

    stations = build_stations(args.qdrant, negative_ids)
    with open(f"{args.out_dir}/stations.json", "w", encoding="utf-8") as f:
        json.dump(stations, f, ensure_ascii=False, separators=(",", ":"))
    print(f"stations.json: {len(stations['stations'])} stations")

    if args.deploy:
        deploy_artifacts(args.out_dir)
        if args.skip_covers:
            print("covers: puladas (--skip-covers) — nem covers/ nem cover.jpg por pasta")
        else:
            deploy_covers(points)
    return 0


if __name__ == "__main__":
    sys.exit(main())
