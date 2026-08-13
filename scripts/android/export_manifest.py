#!/usr/bin/env python3
"""Exporta o manifest da biblioteca pro Rustify Android.

O track_id no desktop é hash do PATH ABSOLUTO da cmr-auto (types.rs
path_to_id) — o celular não consegue derivá-lo dos arquivos transcodados.
Este script materializa o mapeamento track_id ↔ rel_path + metadata a partir
do rustify_tracks (Qdrant da cmr-auto), e o app Android resolve rel_path →
arquivo local por stem (sem extensão, case-insensitive; o acervo do celular
é Opus transcodado + lossy as-is, layout espelhado).

track_id sai como STRING: valores u64 > 2^53 corrompem em JS Number.

Uso (na VM, túnel idempotente pro Qdrant da cmr-auto):
  ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
  python3 scripts/android/export_manifest.py --out /tmp/rustify-manifest.json
"""

import argparse
import json
import sys
import time
import urllib.request

QDRANT = "http://127.0.0.1:16333"
COLLECTION = "rustify_tracks"
MUSIC_ROOT = "/home/cmr-auto/Music/"
FIELDS = [
    "path", "title", "artist", "album_title", "duration_ms",
    "track_number", "disc_number", "genre", "album_year",
]


def scroll_all(base_url: str) -> list[dict]:
    points, offset = [], None
    while True:
        body = {
            "limit": 500,
            "with_payload": FIELDS,
            "with_vector": False,
        }
        if offset is not None:
            body["offset"] = offset
        req = urllib.request.Request(
            f"{base_url}/collections/{COLLECTION}/points/scroll",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.load(resp)["result"]
        points.extend(result["points"])
        offset = result.get("next_page_offset")
        if offset is None:
            return points


def to_int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant", default=QDRANT)
    ap.add_argument("--out", default="/tmp/rustify-manifest.json")
    args = ap.parse_args()

    points = scroll_all(args.qdrant)
    tracks, skipped = [], 0
    for p in points:
        pl = p["payload"]
        path = pl.get("path") or ""
        if not path.startswith(MUSIC_ROOT):
            skipped += 1
            continue
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
        })

    tracks.sort(key=lambda t: t["rel_path"])
    manifest = {
        "schema": 1,
        "generated_at": int(time.time()),
        "source_device": "cmr-auto",
        "music_root": MUSIC_ROOT.rstrip("/"),
        "track_count": len(tracks),
        "tracks": tracks,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(tracks)} tracks -> {args.out} (skipped fora do root: {skipped})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
