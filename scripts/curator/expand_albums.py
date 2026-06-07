#!/usr/bin/env python3
"""Expande (artista, album) -> tracklist via MusicBrainz, no formato musica|artista
que o baixar_soulseek_teste.py consome. Resolve o album inteiro pra download por
faixa (o script de download e faixa-orientado: 1 FLAC por query, nao baixa pasta).

Escolhe a edicao CANONICA, evitando as armadilhas do MusicBrainz:
- release-group por match EXATO de titulo (evita bootleg 'ASTROWORLD X' vs 'ASTROWORLD')
- release com status=Official (exclui Bootleg/Promo), preferindo country US
- entre os Official, a MODA do track-count (a edicao mais prensada = a padrao,
  imune a edicao cortada e a deluxe inflada)
- titulo de faixa sanitizado: '|' (ex: TA13OO 'TABOO | TA13OO') quebraria o CSV

Input: pares 'Artista|Album' por linha no stdin. Sem stdin, usa DEFAULT_ALBUMS.
Output: 'musica|artista' por linha no stdout (sem header — concatene voce mesmo).
        Progresso e contagens vao pro stderr.

Uso:
    printf 'Travis Scott|ASTROWORLD\\nTyler, the Creator|IGOR\\n' \\
        | python3 scripts/curator/expand_albums.py > /tmp/albums.csv
    python3 scripts/curator/expand_albums.py            # usa DEFAULT_ALBUMS
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter

MB = "https://musicbrainz.org/ws/2"
UA = "rustify-player-curator/1.0 ( pedrogr1707@gmail.com )"

# Exemplo / fallback: a leva de rap-trap de 2026-06. Sobrescreva via stdin.
DEFAULT_ALBUMS = [
    ("Travis Scott", "ASTROWORLD"),
    ("Tyler, the Creator", "IGOR"),
    ("A$AP Rocky", "LONG.LIVE.A$AP"),
    ("ScHoolboy Q", "Blank Face LP"),
    ("JID", "The Forever Story"),
    ("Smino", "blkswn"),
    ("Vince Staples", "Summertime '06"),
    ("Jay Rock", "Redemption"),
    ("Denzel Curry", "TA13OO"),
    ("Isaiah Rashad", "The Sun's Tirade"),
    ("Joey Bada$$", "B4.DA.$$"),
    ("Saba", "CARE FOR ME"),
]


def _norm(s):
    s = (s or "").lower().replace(".", "").replace(",", "")
    s = re.sub(r"[‘’]", "'", s)
    return re.sub(r"\s+", " ", s).strip()


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode("utf-8", "replace"), strict=False)


def tracklist(artist, album):
    """(release_title, [titulos]) da edicao canonica, ou (None, [])."""
    q = urllib.parse.quote(f'artist:"{artist}" AND releasegroup:"{album}"')
    try:
        rg = _get(f"{MB}/release-group/?query={q}&type=album&fmt=json&limit=8")
    finally:
        time.sleep(1.1)
    groups = rg.get("release-groups") or []

    def clean(g):
        st = g.get("secondary-types") or []
        return not any(s in st for s in ("Compilation", "Live", "Remix", "DJ-mix"))

    cand = [g for g in groups if clean(g) and g.get("primary-type") == "Album"] or groups
    if not cand:
        return None, []
    album_n = _norm(album)
    exact = [g for g in cand if _norm(g.get("title", "")) == album_n]
    rgid = (exact or cand)[0]["id"]

    try:
        rl = _get(f"{MB}/release?release-group={rgid}&fmt=json&limit=50&inc=media")
    finally:
        time.sleep(1.1)
    rels = rl.get("releases") or []
    off = [r for r in rels if r.get("status") == "Official"]
    pool = [r for r in off if r.get("country") == "US"] or off or rels
    if not pool:
        return None, []

    def tc(r):
        return sum((m.get("track-count") or 0) for m in (r.get("media") or [])) \
            or (r.get("track-count") or 0)

    counts = Counter(tc(r) for r in pool if tc(r) >= 5)
    if counts:  # moda do track-count = edicao canonica
        target = counts.most_common(1)[0][0]
        relid = next(r["id"] for r in pool if tc(r) == target)
    else:
        relid = pool[0]["id"]

    try:
        rel = _get(f"{MB}/release/{relid}?inc=recordings&fmt=json")
    finally:
        time.sleep(1.1)
    titles = []
    for m in rel.get("media") or []:
        for t in m.get("tracks") or []:
            ti = (t.get("title") or "").split("|")[0].strip()  # '|' quebra o CSV
            if ti:
                titles.append(ti)
    return rel.get("title"), titles


def _read_albums():
    if sys.stdin.isatty():
        return DEFAULT_ALBUMS
    pairs = []
    for line in sys.stdin:
        line = line.strip()
        if not line or "|" not in line:
            continue
        artist, album = line.split("|", 1)
        if artist.strip() and album.strip():
            pairs.append((artist.strip(), album.strip()))
    return pairs or DEFAULT_ALBUMS


def main():
    albums = _read_albums()
    total = 0
    for artist, album in albums:
        try:
            reltitle, titles = tracklist(artist, album)
        except Exception as e:  # noqa: BLE001
            print(f"# ERRO {artist} - {album}: {e}", file=sys.stderr)
            continue
        print(f"# {artist} - {album} -> {reltitle!r} ({len(titles)} faixas)", file=sys.stderr)
        for t in titles:
            print(f"{t}|{artist}")
            total += 1
    print(f"# TOTAL: {total} faixas de {len(albums)} albuns", file=sys.stderr)


if __name__ == "__main__":
    main()
