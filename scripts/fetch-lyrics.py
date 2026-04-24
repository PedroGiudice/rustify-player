#!/usr/bin/env python3
"""Fetch synchronized lyrics from lrclib.net for all tracks in a CSV.

Input CSV format (no header): id, path, title, artist, album, duration_ms, lrc_path
Output: .lrc files written to --output-dir/<id>.lrc

Usage:
    python3 scripts/fetch-lyrics.py /tmp/tracks.csv --output-dir /tmp/lyrics
"""

import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API_BASE = "https://lrclib.net/api"
USER_AGENT = "RustifyPlayer/0.1.0 (https://github.com/PedroGiudice/rustify-player)"


def fetch_lyrics(title: str, artist: str, album: str, duration_s: int) -> dict | None:
    """Try to get synced lyrics from lrclib.net. Returns dict or None."""
    params = urllib.parse.urlencode({
        "track_name": title,
        "artist_name": artist,
        "album_name": album,
        "duration": duration_s,
    })
    url = f"{API_BASE}/get?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                return json.loads(resp.read())
    except Exception:
        pass
    return None


def fetch_lyrics_search(title: str, artist: str) -> dict | None:
    """Fallback: search without album/duration for broader matches."""
    params = urllib.parse.urlencode({"q": f"{artist} {title}"})
    url = f"{API_BASE}/search?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                results = json.loads(resp.read())
                if results:
                    return results[0]
    except Exception:
        pass
    return None


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <tracks.csv> [--output-dir DIR]", file=sys.stderr)
        sys.exit(1)

    csv_path = sys.argv[1]
    output_dir = "/tmp/lyrics"
    if "--output-dir" in sys.argv:
        idx = sys.argv.index("--output-dir")
        output_dir = sys.argv[idx + 1]

    os.makedirs(output_dir, exist_ok=True)

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        tracks = list(reader)

    total = len(tracks)
    synced = 0
    plain = 0
    missed = 0
    skipped = 0

    for i, row in enumerate(tracks):
        track_id = row[0]
        path = row[1]
        title = row[2]
        artist = row[3]
        album = row[4]
        duration_ms = int(row[5]) if row[5] else 0
        existing_lrc = row[6] if len(row) > 6 else ""

        # Derive the sidecar path: same as audio file but .lrc extension
        audio_base = os.path.splitext(path)[0]
        lrc_filename = os.path.basename(audio_base) + ".lrc"

        # Use track_id in output filename for easy mapping later
        out_path = os.path.join(output_dir, f"{track_id}__{lrc_filename}")

        if os.path.exists(out_path):
            skipped += 1
            continue

        duration_s = duration_ms // 1000

        # Try exact match first, then search fallback
        data = fetch_lyrics(title, artist, album, duration_s)
        if not data:
            data = fetch_lyrics_search(title, artist)

        if data and data.get("syncedLyrics"):
            with open(out_path, "w", encoding="utf-8") as lrc:
                lrc.write(data["syncedLyrics"])
            synced += 1
            status = "SYNCED"
        elif data and data.get("plainLyrics"):
            # Save plain lyrics as unsynced (no timestamps)
            with open(out_path, "w", encoding="utf-8") as lrc:
                # Write as plain text lines — no LRC timestamps
                for line in data["plainLyrics"].splitlines():
                    lrc.write(line + "\n")
            plain += 1
            status = "PLAIN"
        else:
            missed += 1
            status = "MISS"

        pct = (i + 1) / total * 100
        print(f"[{i+1}/{total} {pct:.0f}%] {status}  {artist} - {title}")

        # Rate limit: lrclib.net is community-run, be nice
        time.sleep(0.15)

    print(f"\nDone. synced={synced} plain={plain} missed={missed} skipped={skipped} total={total}")
    print(f"Output: {output_dir}")


if __name__ == "__main__":
    main()
