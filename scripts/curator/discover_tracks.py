#!/usr/bin/env python3
"""music-curator: descoberta no nível de FAIXA (pipeline unificado).

Sobe o pipeline de descoberta de ARTISTA (discover.py) para FAIXA, atacando o
ponto cego apontado pelo usuário: hoje a escolha de qual track sugerir é feita
pelo knowledge do modelo (enviesado pro hit). Aqui o sinal de faixa vem de
DADOS, e DUAS fontes enchem UM pool único (não listas separadas):

  A) similar-recordings (ListenBrainz) das faixas mais TOCADAS e das faixas-seed
     diversas por MERT (768d) → co-listening de faixa, cobre nichos do acervo
  B) top-recordings-for-artist dos artistas do grafo, fora do topo → variedade
     que o co-listening (hit-pesado) não traz

Cada faixa do pool é rotulada por TIER (hit/mid/deep) pela sua POPULARIDADE
ABSOLUTA (/1/popularity/recording, batch) comparada às demais faixas DO POOL.
Isso evita resolver o artista por nome (ambíguo: "Kanye West" tem homônimos que
o MusicBrainz não desempata por popularidade) — o que corrompia o tier.

A composição final é ESTRATIFICADA: --mode mix (default) mistura os tiers; deep
pesa o fundo; hit o topo. Hit não é defeito — só não pode ser a regra.

Filtro de biblioteca COLLAB-AWARE (is_owned): casa por título + artista
sobreposto, então 'family ties' creditado a 'Baby Keem & Kendrick Lamar' bate
com o acervo que tem só 'Baby Keem' — e não reentra no pool.

Reusa a infra de discover.py (http, Qdrant, perfil, MBID cache, similar-artists).

Uso:
    python3 scripts/curator/discover_tracks.py --out /tmp/pool.json            # mix
    python3 scripts/curator/discover_tracks.py --mode deep --out /tmp/dc.json  # deep cuts
    python3 scripts/curator/discover_tracks.py --mode hit  --pool-size 40
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse

import discover as D  # reusa http_json, qdrant_*, norm_name, load_profile, etc.

# ── Endpoints recording-level (validados via curl, 2026-06) ──────────────────
LB_SIMILAR_REC = "https://labs.api.listenbrainz.org/similar-recordings/json"
LB_REC_SEARCH = "https://labs.api.listenbrainz.org/recording-search/json"
LB_REC_ALGO = "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30"
# popularidade vive no CORE api (rate limit 30/IP/10s):
LB_TOP_FOR_ARTIST = "https://api.listenbrainz.org/1/popularity/top-recordings-for-artist"
LB_POP_RECORDING = "https://api.listenbrainz.org/1/popularity/recording"  # batch POST

TOP_TRACK_SEEDS = 12     # faixas-seed por plays + por diversidade MERT
REL_ARTISTS = 30         # artistas do grafo varridos pra cauda (fonte B)
TAIL_SKIP_TOP = 0.30     # pula o top 30% da discografia do artista (hits DELE)
TAIL_FLOOR = 200         # listen minimo de candidato de cauda (corta bootleg/lixo)
PER_ARTIST_TAIL = 4      # candidatos de cauda por artista (fonte B)
POP_BATCH = 50           # recording_mbids por chamada de /popularity/recording

# Pesos de composição por tier. Default = mix (hit não é a regra, mas é um tier).
TIER_WEIGHTS = {
    "mix":  {"hit": 0.30, "mid": 0.40, "deep": 0.30},
    "deep": {"hit": 0.10, "mid": 0.30, "deep": 0.60},
    "hit":  {"hit": 0.55, "mid": 0.35, "deep": 0.10},
}


# ── Funcoes puras: filtro de biblioteca (collab-aware) + tier ────────────────
# Separadores de artist credit. ListenBrainz credita a collab inteira
# ('Baby Keem & Kendrick Lamar'); o acervo guarda so o principal ('Baby Keem').
# Casar exato falha -> split + sobreposicao. Mesmo principio do 'J. Cole'==
# 'J Cole', agora no nivel de faixa.
_CREDIT_SPLIT = re.compile(
    r"\s*[,&/+]\s*|\s+(?:feat|ft|vs|with)\.?\s+", re.I)


def split_credit(credit):
    """Quebra um artist credit em artistas individuais (lista limpa, sem vazios)."""
    if not credit:
        return []
    return [p.strip() for p in _CREDIT_SPLIT.split(credit) if p.strip()]


def build_library_index(rows):
    """rows: iteravel de (artist, title) -> {norm_title: set(norm_artist)}.
    Splita credit de collab no proprio acervo tambem (cobre os dois lados)."""
    idx = {}
    for artist, title in rows:
        if not artist or not title:
            continue
        t = D.norm_name(title)
        if not t:
            continue
        bucket = idx.setdefault(t, set())
        for a in split_credit(artist):
            na = D.norm_name(a)
            if na:
                bucket.add(na)
    return idx


def is_owned(title, credit, lib_index):
    """True se a faixa (titulo + QUALQUER artista do credit) ja esta no acervo.
    'family ties' do credit 'Baby Keem & Kendrick Lamar' bate com
    {family ties: {baby keem}}: titulo normalizado + artista sobreposto."""
    owners = lib_index.get(D.norm_name(title))
    if not owners:
        return False
    return any(D.norm_name(a) in owners for a in split_credit(credit))


def label_tier(listen_count, pool_listens):
    """hit/mid/deep pela posicao percentil do listen_count entre os listens do
    POOL (popularidade absoluta de cada faixa candidata). pct=0 -> mais popular
    do pool; pct alto -> faixa obscura entre as candidatas."""
    if not pool_listens:
        return "unknown"
    above = sum(1 for x in pool_listens if x > listen_count)
    pct = above / len(pool_listens)
    if pct <= 0.25:
        return "hit"
    if pct >= 0.60:
        return "deep"
    return "mid"


# ── API recording-level ──────────────────────────────────────────────────────
def lb_recording_search(artist, title):
    """Resolve 'artista titulo' -> recording_mbid (melhor match). None se nada."""
    qs = urllib.parse.urlencode({"query": f"{artist} {title}"})
    try:
        data = D.http_json(f"{LB_REC_SEARCH}?{qs}")
    except Exception:  # noqa: BLE001
        return None
    finally:
        time.sleep(0.25)
    if isinstance(data, list) and data:
        return data[0].get("recording_mbid")
    return None


def similar_recordings(rec_mbid):
    qs = urllib.parse.urlencode({"recording_mbids": rec_mbid, "algorithm": LB_REC_ALGO})
    try:
        data = D.http_json(f"{LB_SIMILAR_REC}?{qs}")
    except Exception:  # noqa: BLE001
        return []
    finally:
        time.sleep(0.25)
    return data if isinstance(data, list) else []


def top_recordings_for_artist(artist_mbid):
    """Recordings do artista ordenadas por popularidade (desc). Core API."""
    try:
        data = D.http_json(f"{LB_TOP_FOR_ARTIST}/{artist_mbid}")
    except Exception:  # noqa: BLE001
        return []
    finally:
        time.sleep(0.4)  # core API 30/IP/10s
    return data if isinstance(data, list) else []


def recording_popularity(mbids):
    """Listen absoluto por recording via /1/popularity/recording (batch POST).
    Resolve o tier SEM precisar do artist_mbid (que e ambiguo por homonimo).
    Retorna {recording_mbid: total_listen_count}."""
    out = {}
    for i in range(0, len(mbids), POP_BATCH):
        chunk = mbids[i:i + POP_BATCH]
        try:
            data = D.http_json(LB_POP_RECORDING,
                               data={"recording_mbids": chunk}, method="POST")
        except Exception:  # noqa: BLE001
            data = None
        if isinstance(data, list):
            for r in data:
                m = r.get("recording_mbid")
                if m:
                    out[m] = r.get("total_listen_count") or 0
        time.sleep(0.4)
    return out


# ── Perfil no nível de faixa ─────────────────────────────────────────────────
def load_top_tracks(n, with_mert=False):
    """Top faixas amadas (por play qualificado). Junk filtrado.
    Retorna [{track_id,title,artist,plays,mert?}]. Faixa sem MERT entra mesmo
    assim (so nao serve de seed-MERT); with_mert hidrata o vetor quando existe."""
    pos = D._scroll_events(positive=True)
    pos_q = D._qualify_tracks(pos)[:max(n * 3, 40)]
    ids = [tid for tid, _ in pos_q]
    if not ids:
        return []
    payloads = {}
    for pt in D.qdrant_get_points("rustify_tracks", ids):
        payloads[int(pt["id"])] = pt.get("payload") or {}

    vectors = {}
    if with_mert:
        body = {"ids": ids, "with_vector": ["mert"], "with_payload": False}
        res = D.http_json(f"{D.QDRANT}/collections/rustify_tracks/points",
                          data=body, method="POST")["result"]
        for pt in res:
            v = pt.get("vector") or {}
            mv = v.get("mert") if isinstance(v, dict) else None
            if mv:
                vectors[int(pt["id"])] = mv

    out = []
    for tid, cnt in pos_q:
        pl = payloads.get(tid) or {}
        title = pl.get("title")
        artist = pl.get("artist_exact") or pl.get("artist")
        if not title or not artist or D._is_junk_artist(artist):
            continue
        rec = {"track_id": tid, "title": title, "artist": artist, "plays": cnt}
        if with_mert and tid in vectors:
            rec["mert"] = vectors[tid]
        out.append(rec)
    return out


# ── MERT: farthest-point sampling (diversidade acústica, sem sklearn) ─────────
def _cos_dist(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return 1.0 - dot / (na * nb)


def farthest_point_seeds(tracks, k):
    """Escolhe k faixas que cobrem o espaco MERT (greedy farthest-point).
    Ignora faixas sem vetor MERT. Começa pela mais tocada (tracks ja vem desc)."""
    pool = [t for t in tracks if t.get("mert")]
    if len(pool) <= k:
        return pool
    chosen = [pool[0]]
    while len(chosen) < k:
        best, best_d = None, -1.0
        for t in pool:
            if t in chosen:
                continue
            d = min(_cos_dist(t["mert"], c["mert"]) for c in chosen)
            if d > best_d:
                best, best_d = t, d
        if best is None:
            break
        chosen.append(best)
    return chosen


# ── Biblioteca (collab-aware) ────────────────────────────────────────────────
def library_index():
    """Varre rustify_tracks -> {norm_title: set(norm_artist)} via build_library_index."""
    rows = []
    offset = None
    for _ in range(40):  # ate ~20k tracks
        body = {"limit": 500, "with_payload": ["artist_exact", "artist", "title"]}
        if offset is not None:
            body["offset"] = offset
        res = D.qdrant_scroll("rustify_tracks", body)["result"]
        for p in res["points"]:
            pl = p.get("payload") or {}
            a = pl.get("artist_exact") or pl.get("artist")
            t = pl.get("title")
            if a and t:
                rows.append((a, t))
        offset = res.get("next_page_offset")
        if offset is None:
            break
    return build_library_index(rows)


# ── Fonte A: co-listening de faixa (similar-recordings) ──────────────────────
def seed_recordings():
    """Seeds de faixa: top-tracks por plays + faixas diversas por MERT. Dedup."""
    top = load_top_tracks(40, with_mert=True)
    if not top:
        return []
    by_plays = top[:TOP_TRACK_SEEDS]
    by_mert = farthest_point_seeds(top, TOP_TRACK_SEEDS)
    seen, seeds = set(), []
    for s in by_plays + by_mert:
        if s["track_id"] in seen:
            continue
        seen.add(s["track_id"])
        seeds.append(s)
    return seeds


def collect_similar(seeds, lib_index):
    """Roda similar-recordings por seed e agrega cross-seed (normalizado por seed).
    Filtra owned + junk. Retorna dict {recording_mbid: cand} (sem tier ainda)."""
    per_seed = []
    for s in seeds:
        rec_mbid = lb_recording_search(s["artist"], s["title"])
        if not rec_mbid:
            continue
        sims = similar_recordings(rec_mbid)
        if sims:
            per_seed.append(sims)

    cand = {}
    for recs in per_seed:
        maxs = max((r.get("score") or 0) for r in recs) or 1
        seen = set()  # dedup intra-seed (LB pode repetir mbid e inflar overlap)
        for r in recs:
            mbid = r.get("recording_mbid")
            name = r.get("recording_name") or ""
            artist = r.get("artist_credit_name") or ""
            if not mbid or not name or not artist or mbid in seen:
                continue
            seen.add(mbid)
            if D._is_junk_artist(artist) or is_owned(name, artist, lib_index):
                continue
            norm = (r.get("score") or 0) / maxs
            c = cand.setdefault(mbid, {
                "recording_mbid": mbid, "recording_name": name, "artist": artist,
                "release_name": r.get("release_name"), "release_mbid": r.get("release_mbid"),
                "caa_id": r.get("caa_id"), "sources": ["trackgraph"],
                "sim_score": 0.0, "overlap": 0, "raw_max": 0,
            })
            c["sim_score"] += norm
            c["overlap"] += 1
            c["raw_max"] = max(c["raw_max"], r.get("score") or 0)
    return cand


# ── Fonte B: cauda dos artistas do grafo (variedade) ─────────────────────────
def relevant_artists(top_seeds):
    """Artistas do grafo: seeds do perfil + similares. [(artist_mbid, name)].
    Os similares trazem artist_mbid confiavel (ListenBrainz); os seeds passam por
    resolve_mbid (por nome, pode pegar homonimo — limitacao conhecida)."""
    seeds, _ = D.load_profile(top_seeds)
    cache = D._load_cache()
    rel = {}
    for s in seeds:
        mbid = D.resolve_mbid(s["name"], cache)
        if mbid:
            rel.setdefault(mbid, s["name"])
        for sim in (D.similar_artists(mbid) if mbid else [])[:6]:
            if sim.get("artist_mbid"):
                rel.setdefault(sim["artist_mbid"], sim.get("name", "?"))
    D._save_cache(cache)
    return list(rel.items())[:REL_ARTISTS]


def tail_picks(recs, skip_top_pct, floor, k):
    """Dos recs (desc por listen), retorna ate k faixas da CAUDA do artista:
    fora do top skip_top_pct da discografia DELE (que sao os hits dele), acima do
    floor de listen, dedup por titulo. Pular top-N fixo nao bastava — artista
    grande tem 15+ hits, e 'Kanye - Stronger' vazava como 'cauda'."""
    n = len(recs)
    if n == 0:
        return []
    out, seen = [], set()
    for i, r in enumerate(recs):
        if i / n < skip_top_pct:
            continue
        if (r.get("total_listen_count") or 0) < floor:
            continue
        nm = r.get("recording_name") or ""
        if not nm:
            continue
        tk = D.norm_name(nm)
        if tk in seen:
            continue
        seen.add(tk)
        out.append(r)
        if len(out) >= k:
            break
    return out


def collect_tail_candidates(rel, lib_index):
    """De cada artista do grafo, pega faixas da CAUDA dele (tail_picks: fora do
    top, acima do floor), nao-owned. Traz variedade que o co-listening
    (hit-pesado) nao da. Tier e atribuido depois, por popularidade no pool."""
    tail = {}
    for ambid, aname in rel:
        if D._is_junk_artist(aname):
            continue
        recs = top_recordings_for_artist(ambid)
        picks = tail_picks(recs, TAIL_SKIP_TOP, TAIL_FLOOR, PER_ARTIST_TAIL * 2)
        added = 0
        for r in picks:
            if added >= PER_ARTIST_TAIL:
                break
            nm = r.get("recording_name") or ""
            mbid = r.get("recording_mbid")
            if not mbid or mbid in tail or is_owned(nm, aname, lib_index):
                continue
            tail[mbid] = {
                "recording_mbid": mbid, "recording_name": nm, "artist": aname,
                "release_name": r.get("release_name"), "release_mbid": r.get("release_mbid"),
                "caa_id": r.get("caa_id"), "sources": ["popularity"],
                "sim_score": 0.0, "overlap": 0, "raw_max": 0,
            }
            added += 1
    return tail


# ── Merge + tier por popularidade do pool ────────────────────────────────────
def merge_pool(cand_a, tail_b):
    """Une as fontes por recording_mbid, somando sources. Tier vem depois."""
    pool = {k: dict(v) for k, v in cand_a.items()}
    for mbid, c in tail_b.items():
        if mbid in pool:
            for s in c.get("sources", []):
                if s not in pool[mbid]["sources"]:
                    pool[mbid]["sources"].append(s)
        else:
            pool[mbid] = dict(c)
    return pool


def assign_tiers(pool):
    """Rotula cada faixa do pool por TIER, comparando sua popularidade absoluta
    (/popularity/recording, batch) com a das demais faixas DO POOL. Sem resolver
    artista — o que era a fonte do ruido (homonimo de 'Kanye West')."""
    mbids = list(pool.keys())
    pop = recording_popularity(mbids)
    listens = [pop.get(m, 0) for m in mbids]
    for m, c in pool.items():
        lc = pop.get(m, 0)
        c["listen_count"] = lc
        c["tier"] = label_tier(lc, listens)


# ── Composição estratificada ─────────────────────────────────────────────────
def _rank_key(c):
    return (c.get("overlap", 0), round(c.get("sim_score", 0.0), 4),
            c.get("listen_count") or 0)


SOURCE_B_SHARE = 0.25    # fracao reservada a fonte B (cauda) por seleção de tier


def _take(bucket, n):
    """Pega n do bucket (ja ordenado por _rank_key) reservando SOURCE_B_SHARE pra
    fonte B (sources contendo 'popularity'). B tem overlap 0 e seria sempre
    soterrada por A senao — a cauda existe pra trazer variedade lateral."""
    if n <= 0:
        return []
    b = [c for c in bucket if "popularity" in c.get("sources", [])]
    a = [c for c in bucket if "popularity" not in c.get("sources", [])]
    nb = min(len(b), round(n * SOURCE_B_SHARE))
    picked = b[:nb] + a[:n - nb]
    return sorted(picked, key=_rank_key, reverse=True)


def compose(pool, mode, size):
    """Monta a saida estratificada por tier conforme TIER_WEIGHTS[mode]. Dentro
    de cada tier rankeia por sinal (overlap, sim_score, listen), reservando uma
    cota pra fonte B (cauda). Hit e HARD-CAPPED na cota nos modos mix/deep (so o
    modo hit infla hit no fallback) — senao, com a fonte A hit-pesada, o fallback
    recriava o vies de hit."""
    weights = TIER_WEIGHTS.get(mode, TIER_WEIGHTS["mix"])
    buckets = {"hit": [], "mid": [], "deep": [], "unknown": []}
    for c in pool.values():
        buckets.setdefault(c.get("tier") or "unknown", []).append(c)
    for t in buckets:
        buckets[t].sort(key=_rank_key, reverse=True)

    quota = {t: round(size * w) for t, w in weights.items()}
    out, chosen = [], set()
    for tier in ("hit", "mid", "deep"):
        for c in _take(buckets.get(tier, []), quota.get(tier, 0)):
            out.append(c)
            chosen.add(c["recording_mbid"])
    if len(out) < size:
        fill = ["mid", "deep", "unknown"] + (["hit"] if mode == "hit" else [])
        extra = [c for tier in fill for c in buckets.get(tier, [])
                 if c["recording_mbid"] not in chosen]
        extra.sort(key=_rank_key, reverse=True)
        out.extend(extra[:size - len(out)])
    return out[:size]


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Descoberta de faixas (pool unificado + tier)")
    ap.add_argument("--mode", choices=["mix", "deep", "hit"], default="mix",
                    help="composicao por tier (default mix: hit nao e a regra)")
    ap.add_argument("--pool-size", type=int, default=60)
    ap.add_argument("--top-seeds", type=int, default=8, help="artistas-seed do perfil (fonte B)")
    ap.add_argument("--out", type=str, default="")
    ap.add_argument("--check", action="store_true",
                    help="modo verificacao anti-duplicata: le [{artist,title}] de stdin "
                         "(JSON) e reporta owned=true/false. Use como filtro FINAL nas "
                         "sugestoes editoriais (curveball, eixo de artista) que nao passaram "
                         "pelo is_owned do pool.")
    args = ap.parse_args()

    if args.check:
        pairs = json.load(sys.stdin)
        idx = library_index()
        report = [{"artist": p.get("artist", ""), "title": p.get("title", ""),
                   "owned": is_owned(p.get("title", ""), p.get("artist", ""), idx)}
                  for p in pairs]
        print(json.dumps(report, ensure_ascii=False, indent=2))
        owned_n = sum(1 for r in report if r["owned"])
        print(f"check: {owned_n}/{len(report)} ja no acervo (remover essas)", file=sys.stderr)
        return

    lib_index = library_index()

    # Fonte B: cauda dos artistas do grafo.
    rel = relevant_artists(args.top_seeds)
    tail_b = collect_tail_candidates(rel, lib_index)

    # Fonte A: co-listening de faixa.
    seeds = seed_recordings()
    cand_a = collect_similar(seeds, lib_index)

    pool = merge_pool(cand_a, tail_b)
    assign_tiers(pool)

    final = compose(pool, args.mode, args.pool_size)
    tier_dist = {}
    for c in final:
        tier_dist[c.get("tier", "unknown")] = tier_dist.get(c.get("tier", "unknown"), 0) + 1

    result = {
        "meta": {
            "level": "recording", "mode": args.mode,
            "qdrant": D.QDRANT, "library_titles": len(lib_index),
            "rel_artists": len(rel), "track_seeds": len(seeds),
            "pool_total": len(pool), "candidates_final": len(final),
            "tier_distribution": tier_dist,
        },
        "candidates": [
            {"recording_name": c["recording_name"], "artist": c["artist"],
             "tier": c.get("tier"), "listen_count": c.get("listen_count"),
             "sources": c["sources"], "overlap": c["overlap"],
             "sim_score": round(c.get("sim_score", 0.0), 4),
             "recording_mbid": c["recording_mbid"],
             "release_name": c.get("release_name"), "release_mbid": c.get("release_mbid")}
            for c in final
        ],
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"ok [{args.mode}]: {len(final)} faixas (tiers {tier_dist}) -> {args.out}",
              file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
