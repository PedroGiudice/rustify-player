#!/usr/bin/env python3
"""music-curator: motor de candidatos de descoberta via grafo de similaridade.

Pipeline deterministico que o subagente `music-curator` roda ANTES de curar:

    perfil de escuta (Qdrant play_events)
      -> seeds (artistas mais ouvidos, ponderados por plays qualificados)
      -> MBID (MusicBrainz, com cache)
      -> similar-artists (ListenBrainz Labs, collaborative filtering)
      -> agregacao cross-seed normalizada
      -> filtro contra a biblioteca atual
      -> candidatos rankeados (JSON no stdout / --out)

Separa o trabalho DETERMINISTICO (onde jq corrompe u64 e o LLM erra) do
trabalho EDITORIAL do subagente (curar, justificar, validar album/ano,
montar query slskd). O subagente le este JSON e cura por cima.

Roda na VM; o Qdrant da cmr-auto escuta SO em 127.0.0.1 (hardening
2026-07-17) — abrir o tunel SSH antes de rodar:
  ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9

Uso:
    python3 scripts/curator/discover.py                       # perfil automatico
    python3 scripts/curator/discover.py --out /tmp/cand.json
    python3 scripts/curator/discover.py --top-seeds 8 --pool-size 80
    python3 scripts/curator/discover.py --seeds "Tim Maia,Jorge Ben Jor"  # override

Gotchas embutidos (validados empiricamente, 2026-06, curl real):
  - track_id e u64 > i64::MAX: Python int nativo preserva; jq numerico CORROMPE.
  - payloads de rustify_tracks tem control chars literais: json.loads(strict=False).
  - ListenBrainz exige sufixo /json + param `algorithm` (enum fechado, 400 se invalido).
  - resolver MBID pelo maior score e armadilha ("J. Cole" -> "Nat King Cole"); match exato.
  - MusicBrainz: 1 req/s, User-Agent com contato obrigatorio.
  - score do ListenBrainz NAO e normalizado entre seeds (Kendrick ~9k, Biggie ~3k):
    normalizar por max do proprio seed antes de agregar cross-seed.
  - sinal forte = aparecer em MULTIPLOS seeds (mata ruido pop single-seed).
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# ── Config ──────────────────────────────────────────────────────────────────
# 16333 = tunel SSH local -> cmr-auto:6333 (bind loopback desde 2026-07-17).
QDRANT = os.environ.get("CURATOR_QDRANT", "http://127.0.0.1:16333")
MB_BASE = "https://musicbrainz.org/ws/2"
LB_SIMILAR = "https://labs.api.listenbrainz.org/similar-artists/json"
# Enum fechado do ListenBrainz; days_7500 = ~20 anos de janela, filter on, 100 results.
LB_ALGO = "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30"
MB_UA = "rustify-player-curator/1.0 ( pedrogr1707@gmail.com )"
CACHE_DIR = os.path.expanduser("~/.cache/rustify-curator")
MBID_CACHE = os.path.join(CACHE_DIR, "mbid.json")

# Piso de score bruto (max sobre todos os candidatos) abaixo do qual o grafo de
# co-listening e esparso demais pra confiar no ranking (tipico de rap BR / nicho).
# Calibrado: OutKast topo ~4800, Tom Ze ~630, rap BR ~120. <800 => baixa confianca.
SIGNAL_FLOOR = 800

POSITIVE_SCROLL = 500   # janela de eventos positivos
NEGATIVE_SCROLL = 200   # janela de eventos negativos
NEG_HYDRATE_CAP = 40    # quantas top-tracks negativas hidratar
# Acervo grande do artista (>= isto) => ja conhece/tem; sai do pool. Abaixo disso
# fica como candidato marcado (library_tracks) p/ modo album/deep cut. Caso Travis:
# tem singles/features mas nao o album inteiro -> deve continuar sugerivel.
LIB_FULL = 6


# ── HTTP ────────────────────────────────────────────────────────────────────
def http_json(url, data=None, headers=None, method=None, retries=3):
    """GET/POST JSON com retry/backoff. strict=False tolera control chars no payload."""
    h = {"User-Agent": MB_UA, "Accept": "application/json"}
    if data is not None:
        h["Content-Type"] = "application/json"
    if headers:
        h.update(headers)
    body = json.dumps(data).encode() if data is not None else None
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=h, method=method)
            with urllib.request.urlopen(req, timeout=45) as r:
                raw = r.read().decode("utf-8", "replace")
            return json.loads(raw, strict=False)
        except Exception as e:  # noqa: BLE001 — rede instavel, backoff e seguir
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"http_json falhou apos {retries} tentativas: {url} :: {last}")


def qdrant_scroll(collection, body):
    return http_json(f"{QDRANT}/collections/{collection}/points/scroll", data=body, method="POST")


def qdrant_get_points(collection, ids):
    """Hidrata multiplos pontos por id (u64) numa request. Preserva precisao via int nativo."""
    body = {"ids": ids, "with_payload": True}
    return http_json(f"{QDRANT}/collections/{collection}/points", data=body, method="POST")["result"]


# ── Normalizacao de nomes (dedup contra biblioteca) ──────────────────────────
def norm_name(s):
    """Normaliza nome de artista pra chave de comparacao. Remove pontuacao que
    varia entre grafias ('J. Cole' == 'J Cole') pra evitar chave dupla que
    quebraria o gate de negatives e o filtro de biblioteca."""
    if not s:
        return ""
    s = s.lower().strip()
    s = re.sub(r"[‘’“”]", "'", s)
    s = s.replace(".", "").replace(",", "")   # 'J. Cole' == 'J Cole'
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ── Perfil de escuta (replica behavioral_signals) ────────────────────────────
def _scroll_events(positive):
    if positive:
        flt = {
            "must": [
                {"key": "event_type", "match": {"any": ["track_ended", "track_skipped"]}},
                {"key": "listen_pct", "range": {"gte": 0.9}},
            ],
            "must_not": [{"key": "origin", "match": {"value": "album_seq"}}],
        }
        limit = POSITIVE_SCROLL
    else:
        flt = {
            "must": [
                {"key": "event_type", "match": {"any": ["track_ended", "track_skipped"]}},
                {"key": "listen_pct", "range": {"lt": 0.15}},
            ],
            "must_not": [{"key": "origin", "match": {"value": "album_seq"}}],
        }
        limit = NEGATIVE_SCROLL
    body = {
        "filter": flt,
        "limit": limit,
        "order_by": {"key": "started_at", "direction": "desc"},
        "with_payload": True,
    }
    return qdrant_scroll("play_events", body)["result"]["points"]


def _qualify_tracks(points):
    """Agrupa eventos por track_id (u64). Qualifica: count>=2 OU algum listen_pct>=0.999."""
    agg = {}
    for p in points:
        pl = p.get("payload") or {}
        tid = pl.get("track_id")
        if tid is None:
            continue
        rec = agg.setdefault(int(tid), {"count": 0, "max_pct": 0.0})
        rec["count"] += 1
        rec["max_pct"] = max(rec["max_pct"], float(pl.get("listen_pct") or 0.0))
    qualified = [(tid, r["count"]) for tid, r in agg.items()
                 if r["count"] >= 2 or r["max_pct"] >= 0.999]
    qualified.sort(key=lambda x: x[1], reverse=True)
    return qualified


def _artist_of(track_id, hydrated):
    pl = (hydrated.get(track_id) or {})
    return pl.get("artist_exact") or pl.get("artist") or ""


def _is_junk_artist(name):
    """Metadata suja que nao deve virar seed (ex: funk BR com artist = URL do ripper)."""
    n = name.lower().strip()
    return (not n or "http" in n or "www." in n or "/" in n
            or n.endswith((".com", ".net", ".br", ".org"))
            or n in ("unknown", "various artists", "va", "n/a"))


def load_profile(top_seeds):
    """Retorna (seeds, negatives). seeds = [{name, plays}] desc por plays.
    negatives = artista com >=2 TRACKS DISTINTAS skipadas hard (a janela ja
    filtra listen_pct<0.15) E SEM nenhuma presenca positiva — um favorito
    ocasionalmente pulado NUNCA vira negative (gate `k not in plays`)."""
    pos = _scroll_events(positive=True)
    neg = _scroll_events(positive=False)

    pos_q = _qualify_tracks(pos)                 # todas qualificadas (perfil completo)
    # Negativos: tracks DISTINTAS na janela de skip hard (cada uma = rejeicao;
    # nao reaproveita _qualify_tracks, cuja regra count>=2 e de positivo).
    neg_track_ids = list({int((p.get("payload") or {}).get("track_id"))
                          for p in neg
                          if (p.get("payload") or {}).get("track_id") is not None})[:NEG_HYDRATE_CAP]

    ids = [tid for tid, _ in pos_q] + neg_track_ids
    hydrated = {}
    if ids:
        for pt in qdrant_get_points("rustify_tracks", ids):
            hydrated[int(pt["id"])] = pt.get("payload") or {}

    # Plays + nome de exibicao por artista (chaveado por nome normalizado).
    plays, disp = {}, {}
    for tid, cnt in pos_q:
        a = _artist_of(tid, hydrated)
        if a:
            k = norm_name(a)
            plays[k] = plays.get(k, 0) + cnt
            disp.setdefault(k, a)
    ranked = sorted(plays.items(), key=lambda x: x[1], reverse=True)
    seeds = [{"name": disp[k], "plays": c} for k, c in ranked
             if not _is_junk_artist(disp[k])][:top_seeds]

    # Rejeicao genuina: >=2 tracks distintas skipadas e zero presenca positiva.
    neg_tracks_per_artist = {}
    for tid in neg_track_ids:
        a = _artist_of(tid, hydrated)
        if a:
            k = norm_name(a)
            neg_tracks_per_artist[k] = neg_tracks_per_artist.get(k, 0) + 1
    negatives = {k for k, c in neg_tracks_per_artist.items() if c >= 2 and k not in plays}
    return seeds, negatives


def library_counts():
    """Dict {nome_normalizado: n_tracks} de toda a biblioteca."""
    counts = {}
    offset = None
    complete = False
    for _ in range(40):  # ate ~20k tracks
        body = {"limit": 500, "with_payload": ["artist_exact", "artist"]}
        if offset is not None:
            body["offset"] = offset
        res = qdrant_scroll("rustify_tracks", body)["result"]
        for p in res["points"]:
            pl = p.get("payload") or {}
            a = pl.get("artist_exact") or pl.get("artist")
            if a:
                k = norm_name(a)
                counts[k] = counts.get(k, 0) + 1
        offset = res.get("next_page_offset")
        if offset is None:
            complete = True
            break
    if not complete:
        print("WARN: library_counts truncou (acervo > ~20k tracks); filtro de "
              "biblioteca incompleto, artistas nao varridos podem reentrar no pool",
              file=sys.stderr)
    return counts


# ── MusicBrainz: resolucao de MBID com cache e match exato ───────────────────
def _load_cache():
    try:
        with open(MBID_CACHE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def _save_cache(cache):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = MBID_CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, MBID_CACHE)


def _mb_search(name):
    """Lista de artistas (vazia = not found conclusivo) ou None em erro de rede.
    A distincao importa: not-found e cacheavel; erro de rede NAO (re-tentar depois)."""
    q = urllib.parse.quote(f'artist:"{name}"')
    url = f"{MB_BASE}/artist/?query={q}&fmt=json&limit=8"
    try:
        data = http_json(url, headers={"User-Agent": MB_UA})
    except Exception:  # noqa: BLE001 — rede caiu apos retries; sinaliza p/ NAO cachear
        return None
    finally:
        time.sleep(1.1)  # rate limit MusicBrainz
    return data.get("artists") or []


def resolve_mbid(name, cache):
    """MBID por MATCH EXATO de nome (evita 'J. Cole' -> 'Nat King Cole').
    Fallback pra collab: tenta o artista principal isolado ('Astrix & Captain
    Hook' -> 'Astrix'). So cacheia resolucao CONCLUSIVA: erro de rede nao grava
    null permanente (senao um timeout transitorio perderia o seed pra sempre)."""
    key = norm_name(name)
    if key in cache:
        return cache[key]
    tries = [name]
    parts = re.split(r"\s+(?:&|feat\.?|ft\.?|vs\.?|/)\s+", name, flags=re.I)
    if len(parts) > 1 and parts[0].strip():
        tries.append(parts[0].strip())  # artista principal de uma collab
    mbid, net_error = None, False
    for i, cand in enumerate(tries):
        arts = _mb_search(cand)
        if arts is None:           # erro de rede: inconclusivo, nao cacheia
            net_error = True
            break
        ck = norm_name(cand)
        exact = [a for a in arts if norm_name(a.get("name", "")) == ck]
        # nome completo: aceita melhor score se nao houver exato; split: exige exato.
        pick = (max(exact, key=lambda a: a.get("score", 0)) if exact
                else (arts[0] if arts and i == 0 else None))
        if pick:
            mbid = pick.get("id")
            break
    if not net_error:              # so persiste quando MB respondeu (achou ou nao)
        cache[key] = mbid
    return mbid


# ── ListenBrainz: similar-artists ────────────────────────────────────────────
def similar_artists(mbid):
    qs = urllib.parse.urlencode({"artist_mbids": mbid, "algorithm": LB_ALGO})
    try:
        data = http_json(f"{LB_SIMILAR}?{qs}")
    except Exception:  # noqa: BLE001
        return []
    finally:
        time.sleep(0.25)  # labs host sem rate-limit publicado: serializar com folga
    return data if isinstance(data, list) else []


# ── Agregacao cross-seed ─────────────────────────────────────────────────────
def aggregate(seeds_resolved, lib_counts, negatives, lib_full):
    """Normaliza score por seed, pondera por sqrt(plays), soma cross-seed.
    Remove seeds, rejeitados e artistas com acervo grande (>=lib_full).
    MANTEM parciais (library_tracks 1..lib_full-1) marcados pra modo album."""
    seed_keys = {norm_name(s["name"]) for s in seeds_resolved}
    cand = {}
    for s in seeds_resolved:
        sims = s.get("similar") or []
        if not sims:
            continue
        max_score = max((x.get("score") or 0) for x in sims) or 1
        weight = math.sqrt(max(s["plays"], 1))
        seen = set()  # dedup intra-seed: LB pode repetir um mbid e inflar overlap
        for x in sims:
            mbid = x.get("artist_mbid")
            name = x.get("name") or ""
            nk = norm_name(name)
            if not mbid or not nk:
                continue
            if mbid in seen:
                continue
            seen.add(mbid)
            if nk in seed_keys or nk in negatives:
                continue
            libn = lib_counts.get(nk, 0)
            if libn >= lib_full:        # ja tem acervo grande -> conhece, fora do pool
                continue
            norm = (x.get("score") or 0) / max_score
            c = cand.setdefault(mbid, {
                "name": name, "mbid": mbid, "type": x.get("type"),
                "comment": x.get("comment") or "", "agg_score": 0.0,
                "overlap": 0, "per_seed": {}, "raw_max": 0, "library_tracks": libn,
            })
            c["agg_score"] += norm * weight
            c["overlap"] += 1
            c["per_seed"][s["name"]] = round(norm, 3)
            c["raw_max"] = max(c["raw_max"], x.get("score") or 0)
    out = sorted(cand.values(), key=lambda c: c["agg_score"], reverse=True)
    for c in out:
        c["agg_score"] = round(c["agg_score"], 4)
    return out


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Motor de candidatos do music-curator")
    ap.add_argument("--top-seeds", type=int, default=8, help="quantos artistas-seed usar")
    ap.add_argument("--pool-size", "--per-seed", type=int, default=60, dest="pool_size",
                    help="total de candidatos no JSON final (cap global, NAO por seed)")
    ap.add_argument("--seeds", type=str, default="", help="override: nomes separados por virgula")
    ap.add_argument("--lib-full", type=int, default=LIB_FULL,
                    help=f"acervo (>= isto) que tira o artista do pool (default {LIB_FULL})")
    ap.add_argument("--out", type=str, default="", help="arquivo de saida (default stdout)")
    args = ap.parse_args()

    cache = _load_cache()
    lib_counts = library_counts()

    if args.seeds.strip():
        seeds = [{"name": n.strip(), "plays": 1} for n in args.seeds.split(",") if n.strip()]
        negatives = set()
    else:
        seeds, negatives = load_profile(args.top_seeds)

    if not seeds:
        json.dump({"error": "perfil vazio: nenhum seed qualificado em play_events",
                   "hint": "usuario com poucos eventos; rodar com --seeds explicito"},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
        return

    for s in seeds:
        s["mbid"] = resolve_mbid(s["name"], cache)
        s["similar"] = similar_artists(s["mbid"]) if s["mbid"] else []
        s["similar_returned"] = len(s["similar"])
    _save_cache(cache)

    candidates = aggregate(seeds, lib_counts, negatives, args.lib_full)
    top_raw = max((c["raw_max"] for c in candidates), default=0)

    result = {
        "meta": {
            "generated_for": "rustify-player music-curator",
            "qdrant": QDRANT,
            "algorithm": LB_ALGO,
            "seeds_used": len([s for s in seeds if s["mbid"]]),
            "library_artists": len(lib_counts),
            "candidates_total": len(candidates),
            "top_raw_score": top_raw,
            "signal_quality": "high" if top_raw >= SIGNAL_FLOOR else "low",
            "signal_note": ("grafo denso, ranking confiavel" if top_raw >= SIGNAL_FLOOR
                            else f"grafo esparso (top raw {top_raw} < {SIGNAL_FLOOR}): "
                                 "perfil de nicho/BR; usar candidatos como pool e "
                                 "re-rankear via MusicBrainz rels/tags + web. Score nao discrimina."),
        },
        "profile": {
            "seeds": [{"name": s["name"], "mbid": s.get("mbid"),
                       "plays": s["plays"], "similar_returned": s.get("similar_returned", 0)}
                      for s in seeds],
            "negatives_filtered": sorted(negatives),
        },
        "candidates": [
            {"name": c["name"], "mbid": c["mbid"], "type": c["type"],
             "comment": c["comment"], "agg_score": c["agg_score"],
             "overlap": c["overlap"], "raw_max": c["raw_max"],
             "library_tracks": c["library_tracks"], "per_seed": c["per_seed"]}
            for c in candidates[:args.pool_size]
        ],
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"ok: {len(result['candidates'])} candidatos -> {args.out} "
              f"(signal={result['meta']['signal_quality']}, top_raw={top_raw})", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
