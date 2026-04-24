#!/usr/bin/env python3
"""Fetch synchronized lyrics from lrclib.net — parallel version.

Input CSV (no header): id, path, title, artist, album, duration_ms, lrc_path
Output: .lrc files in --output-dir/<id>__<filename>.lrc

Usage:
    python3 scripts/fetch-lyrics-fast.py /tmp/tracks.csv --output-dir /tmp/lyrics
"""

import asyncio
import csv
import json
import os
import sys
import urllib.parse

try:
    import aiohttp
except ImportError:
    print("Installing aiohttp...", file=sys.stderr)
    os.system(f"{sys.executable} -m pip install -q aiohttp")
    import aiohttp

API_BASE = "https://lrclib.net/api"
USER_AGENT = "RustifyPlayer/0.1.0 (https://github.com/PedroGiudice/rustify-player)"
CONCURRENCY = 20


async def fetch_one(session, track, sem, stats):
    track_id, path, title, artist, album, duration_ms = track
    audio_base = os.path.splitext(path)[0]
    lrc_filename = os.path.basename(audio_base) + ".lrc"
    out_path = os.path.join(stats["output_dir"], f"{track_id}__{lrc_filename}")

    if os.path.exists(out_path):
        stats["skipped"] += 1
        return

    duration_s = int(duration_ms) // 1000 if duration_ms else 0

    async with sem:
        data = await _get(session, title, artist, album, duration_s)
        if not data:
            data = await _search(session, title, artist)

    if data and data.get("syncedLyrics"):
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(data["syncedLyrics"])
        stats["synced"] += 1
        status = "SYNCED"
    elif data and data.get("plainLyrics"):
        with open(out_path, "w", encoding="utf-8") as f:
            for line in data["plainLyrics"].splitlines():
                f.write(line + "\n")
        stats["plain"] += 1
        status = "PLAIN"
    else:
        stats["missed"] += 1
        status = "MISS"

    stats["done"] += 1
    total = stats["total"]
    pct = stats["done"] / total * 100
    print(f"[{stats['done']}/{total} {pct:.0f}%] {status}  {artist} - {title}")


async def _get(session, title, artist, album, duration_s):
    params = urllib.parse.urlencode({
        "track_name": title, "artist_name": artist,
        "album_name": album, "duration": duration_s,
    })
    try:
        async with session.get(f"{API_BASE}/get?{params}", timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                return await resp.json()
    except Exception:
        pass
    return None


async def _search(session, title, artist):
    params = urllib.parse.urlencode({"q": f"{artist} {title}"})
    try:
        async with session.get(f"{API_BASE}/search?{params}", timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                results = await resp.json()
                if results:
                    return results[0]
    except Exception:
        pass
    return None


async def main():
    csv_path = sys.argv[1]
    output_dir = "/tmp/lyrics"
    if "--output-dir" in sys.argv:
        idx = sys.argv.index("--output-dir")
        output_dir = sys.argv[idx + 1]

    os.makedirs(output_dir, exist_ok=True)

    with open(csv_path, newline="", encoding="utf-8") as f:
        tracks = [(r[0], r[1], r[2], r[3], r[4], r[5]) for r in csv.reader(f)]

    stats = {"synced": 0, "plain": 0, "missed": 0, "skipped": 0, "done": 0,
             "total": len(tracks), "output_dir": output_dir}

    sem = asyncio.Semaphore(CONCURRENCY)
    headers = {"User-Agent": USER_AGENT}

    async with aiohttp.ClientSession(headers=headers) as session:
        tasks = [fetch_one(session, t, sem, stats) for t in tracks]
        await asyncio.gather(*tasks)

    print(f"\nDone. synced={stats['synced']} plain={stats['plain']} "
          f"missed={stats['missed']} skipped={stats['skipped']} total={stats['total']}")


if __name__ == "__main__":
    asyncio.run(main())
