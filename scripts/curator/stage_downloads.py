#!/usr/bin/env python3
"""Stage slskd downloads -> ~/Music/<playlist>, com dedup interno e vs acervo.

Le metadata (mutagen) dos FLAC em ~/slskd_dados/downloads, le artist/title do
acervo via Qdrant (rustify_tracks), e classifica cada download:

  - ja_no_acervo : (artist,title) ja existe no Qdrant -> NAO mover
  - dup_interno  : mesma (artist,title) aparece >1x nos downloads -> manter so
                   a de maior bitrate
  - novo         : mover para o destino

Por padrao roda em DRY-RUN (so relatorio). Com --apply, move (mv) os 'novo'
para ~/Music/<DEST>/<album>/. Nada e deletado: dup_interno e ja_no_acervo
ficam em downloads para decisao posterior.

Levas multi-genero: --map aponta um JSON {"Artista": "Playlist", ...}
(nomes humanos; as chaves passam pelo artist_main() do proprio script).
Com --map ativo, 'novo' sem artista mapeado NAO move (vira 'sem_mapa') —
melhor sobrar em downloads do que cair na playlist errada.

GOTCHA re-run (2026-07-20): o dedup interno compara so o que esta em
downloads. Num segundo --apply, o par de pior bitrate de um dup_interno
da primeira passada vira 'novo' (o melhor ja saiu) e move DUPLICADO pra
Music. Re-run so apos rescan do app (acervo no Qdrant atualizado), ou
conferir dup_interno da run anterior antes.

Uso:
    python3 stage_downloads.py                      # dry-run, dest "Rap & Hip-Hop"
    python3 stage_downloads.py --apply
    python3 stage_downloads.py --dest "Rap & Hip-Hop"
    python3 stage_downloads.py --map leva.json --apply
"""
import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
from collections import defaultdict

HOME = os.path.expanduser("~")
DOWNLOADS = os.path.join(HOME, "slskd_dados", "downloads")
MUSIC = os.path.join(HOME, "Music")
QDRANT = "http://localhost:6333/collections/rustify_tracks/points/scroll"

_PARENS = re.compile(r"[\(\[].*?[\)\]]")
_FEAT = re.compile(r"\b(feat|ft|featuring|with|prod)\b.*", re.I)
_PUNCT = re.compile(r"[^a-z0-9 ]")
_WS = re.compile(r"\s+")


def norm(s):
    if not s:
        return ""
    s = s.lower()
    s = _PARENS.sub(" ", s)
    s = _FEAT.sub(" ", s)
    s = _PUNCT.sub(" ", s)
    s = _WS.sub(" ", s).strip()
    return s


def artist_main(s):
    """Primeiro artista (antes de &, feat, vírgula, x)."""
    if not s:
        return ""
    s = re.split(r"\bfeat\b|\bft\b|&|,| x |/", s, flags=re.I)[0]
    return norm(s)


def read_meta(path):
    try:
        from mutagen import File
        f = File(path)
        if f is None:
            return None
        tags = f.tags or {}
        def g(*keys):
            for k in keys:
                v = tags.get(k)
                if v:
                    return str(v[0]) if isinstance(v, list) else str(v)
            return ""
        artist = g("artist", "ARTIST", "albumartist", "ALBUMARTIST", "TPE1")
        title = g("title", "TITLE", "TIT2")
        album = g("album", "ALBUM", "TALB")
        br = getattr(f.info, "bitrate", 0) or 0
        dur = getattr(f.info, "length", 0) or 0
        return {"artist": artist, "title": title, "album": album, "bitrate": br, "dur": dur}
    except Exception as e:
        return {"error": str(e)}


def load_acervo():
    keys = set()
    off = None
    while True:
        body = {"limit": 256, "with_payload": ["artist", "title"], "with_vector": False}
        if off is not None:
            body["offset"] = off
        req = urllib.request.Request(QDRANT, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())["result"]
        for p in r["points"]:
            pl = p["payload"]
            keys.add((artist_main(pl.get("artist", "")), norm(pl.get("title", ""))))
        off = r.get("next_page_offset")
        if off is None:
            break
    return keys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="mover de fato (default: dry-run)")
    ap.add_argument("--dest", default="Rap & Hip-Hop", help="pasta de 1o nivel destino")
    ap.add_argument("--map", dest="map_path", default=None,
                    help="JSON {artista: playlist} para leva multi-genero")
    args = ap.parse_args()

    artist_dest = None
    if args.map_path:
        with open(args.map_path) as fh:
            raw_map = json.load(fh)
        # Mesma normalizacao usada nas keys dos items — nomes humanos no JSON.
        artist_dest = {artist_main(k): v for k, v in raw_map.items()}

    flacs = []
    for dp, _, fns in os.walk(DOWNLOADS):
        for fn in fns:
            if fn.lower().endswith(".flac"):
                flacs.append(os.path.join(dp, fn))
    flacs.sort()

    acervo = load_acervo()
    print(f"acervo (Qdrant): {len(acervo)} (artist,title) distintos")
    print(f"downloads: {len(flacs)} flac\n")

    items = []
    no_meta = 0
    for path in flacs:
        m = read_meta(path)
        if not m or "error" in (m or {}):
            no_meta += 1
            # fallback: nome do arquivo
            base = os.path.splitext(os.path.basename(path))[0]
            m = {"artist": "", "title": base, "album": os.path.basename(os.path.dirname(path)),
                 "bitrate": 0, "dur": 0, "_nometa": True}
        key = (artist_main(m["artist"]) or artist_main(m["album"]), norm(m["title"]))
        items.append({"path": path, "key": key, **m})

    # classificar
    by_key = defaultdict(list)
    for it in items:
        by_key[it["key"]].append(it)

    ja_acervo, dup_interno, novo = [], [], []
    for it in items:
        if it["key"] in acervo:
            ja_acervo.append(it)
    seen_internal = set()
    for it in items:
        if it["key"] in acervo:
            continue
        group = sorted(by_key[it["key"]], key=lambda x: -x["bitrate"])
        best = group[0]
        if it is best and it["key"] not in seen_internal:
            novo.append(it)
            seen_internal.add(it["key"])
        else:
            dup_interno.append(it)

    # dest por item: mapa por artista (quando --map) ou --dest global
    sem_mapa = []
    if artist_dest is not None:
        mapped = []
        for it in novo:
            d = artist_dest.get(it["key"][0])
            if d is None:
                sem_mapa.append(it)
            else:
                it["dest"] = d
                mapped.append(it)
        novo = mapped
    else:
        for it in novo:
            it["dest"] = args.dest

    print(f"=== CLASSIFICACAO ===")
    print(f"  ja_no_acervo : {len(ja_acervo)}  (nao mover)")
    print(f"  dup_interno  : {len(dup_interno)}  (manter so melhor bitrate)")
    print(f"  novo         : {len(novo)}  (MOVER{' via mapa' if artist_dest is not None else ' -> ' + args.dest})")
    if artist_dest is not None:
        print(f"  sem_mapa     : {len(sem_mapa)}  (artista fora do mapa — NAO mover)")
        by_dest = defaultdict(int)
        for it in novo:
            by_dest[it["dest"]] += 1
        for d, n in sorted(by_dest.items(), key=lambda x: -x[1]):
            print(f"      {n:3d} -> {d}")
        if sem_mapa:
            print("  --- sem_mapa (artista - titulo):")
            for it in sem_mapa[:20]:
                print(f"      {it['artist'] or it['album']} - {it['title']}")
    print(f"  sem metadata : {no_meta}")
    print()

    # plano de movimentacao por album
    by_album = defaultdict(int)
    for it in novo:
        by_album[os.path.basename(os.path.dirname(it["path"]))] += 1
    print("=== NOVO por album (top 20) ===")
    for alb, n in sorted(by_album.items(), key=lambda x: -x[1])[:20]:
        print(f"  {n:3d}  {alb}")
    print()
    print("=== amostra JA_NO_ACERVO (top 12) ===")
    for it in ja_acervo[:12]:
        print(f"  {it['artist']} - {it['title']}")
    print()
    print("=== amostra DUP_INTERNO (top 12) ===")
    for it in dup_interno[:12]:
        print(f"  {it['artist']} - {it['title']}  ({it['bitrate']//1000}k)  [{os.path.basename(os.path.dirname(it['path']))}]")

    if not args.apply:
        print("\n[DRY-RUN] nada movido. Rode com --apply para mover os 'novo'.")
        return

    moved = 0
    moved_by_dest = defaultdict(int)
    for it in novo:
        alb = os.path.basename(os.path.dirname(it["path"]))
        dest_dir = os.path.join(MUSIC, it["dest"], alb)
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, os.path.basename(it["path"]))
        if os.path.exists(dest):
            continue
        shutil.move(it["path"], dest)
        moved += 1
        moved_by_dest[it["dest"]] += 1
    print(f"\n[APPLY] movidos {moved} flac:")
    for d, n in sorted(moved_by_dest.items(), key=lambda x: -x[1]):
        print(f"  {n:3d} -> {os.path.join(MUSIC, d)}/<album>/")
    print("Rode o rescan no app (ou lib_rescan) para indexar.")


if __name__ == "__main__":
    main()
