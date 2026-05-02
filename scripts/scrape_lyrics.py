#!/usr/bin/env python3
"""Fetch lyrics for pending tracks via multi-source fallback chain.

Default chain: Musixmatch (synced) → Letras.com (plain)
Optional: --source genius (needs residential IP, Cloudflare blocks datacenter)

Input: data/tracks_pending_v2.csv (no header): id, path, title, artist, album, duration_ms
Output:
  - data/scraped-lyrics/{id}.lrc   (synced results written directly)
  - data/scraped-texts/{id}.txt    (plain results for later forced alignment)
  - data/scrape-report.csv         (id, title, artist, source, type, timestamp)

Usage:
    python3 scripts/scrape_lyrics.py
    python3 scripts/scrape_lyrics.py --id 863
    python3 scripts/scrape_lyrics.py --source genius    # single source (run from cmr-auto)
    python3 scripts/scrape_lyrics.py --dry-run
"""

import argparse
import csv
import os
import sys
import time
from datetime import datetime, timezone

PENDING_CSV = "data/tracks_pending_v2.csv"
LYRICS_DIR = "data/scraped-lyrics"
TEXTS_DIR = "data/scraped-texts"
REPORT_CSV = "data/scrape-report.csv"

DEFAULT_SOURCES = ["letras"]

SOURCE_DELAYS = {
    "musixmatch": 2.0,
    "genius": 1.5,
    "letras": 2.0,
}


def load_source_fn(name):
    sys.path.insert(0, os.path.dirname(__file__))
    from lyrics_sources import fetch_musixmatch, fetch_genius, fetch_letras
    return {
        "musixmatch": fetch_musixmatch,
        "genius": fetch_genius,
        "letras": fetch_letras,
    }[name]


def already_done(track_id):
    return (
        os.path.exists(os.path.join(LYRICS_DIR, f"{track_id}.lrc"))
        or os.path.exists(os.path.join(TEXTS_DIR, f"{track_id}.txt"))
    )


def save_result(track_id, result):
    if result.synced:
        os.makedirs(LYRICS_DIR, exist_ok=True)
        path = os.path.join(LYRICS_DIR, f"{track_id}.lrc")
        with open(path, "w", encoding="utf-8") as f:
            f.write(result.text)
    else:
        os.makedirs(TEXTS_DIR, exist_ok=True)
        path = os.path.join(TEXTS_DIR, f"{track_id}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(result.text)


def append_report(track_id, title, artist, source, result_type):
    write_header = not os.path.exists(REPORT_CSV)
    with open(REPORT_CSV, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        if write_header:
            w.writerow(["id", "title", "artist", "source", "type", "timestamp"])
        w.writerow([
            track_id, title, artist, source, result_type,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ])


def main():
    parser = argparse.ArgumentParser(description="Multi-source lyrics scraper")
    parser.add_argument("--id", help="Process single track ID")
    parser.add_argument("--source", choices=["musixmatch", "genius", "letras"],
                        help="Use only this source")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="Overwrite existing results")
    parser.add_argument("--csv", default=PENDING_CSV, help="Input CSV path")
    args = parser.parse_args()

    with open(args.csv, newline="", encoding="utf-8") as f:
        tracks = list(csv.reader(f))

    if args.id:
        tracks = [t for t in tracks if t[0] == args.id]
        if not tracks:
            print(f"Track {args.id} not found in {args.csv}", file=sys.stderr)
            sys.exit(1)

    sources = [args.source] if args.source else DEFAULT_SOURCES
    source_fns = {s: load_source_fn(s) for s in sources}

    stats = {"synced": 0, "plain": 0, "miss": 0, "skip": 0}
    total = len(tracks)

    for i, row in enumerate(tracks):
        track_id = row[0]
        title = row[2]
        artist = row[3]

        if not args.force and already_done(track_id):
            stats["skip"] += 1
            continue

        if args.dry_run:
            print(f"[{i+1}/{total}] WOULD FETCH {track_id}: {artist} - {title}")
            continue

        result = None
        for src_name in sources:
            fn = source_fns[src_name]
            try:
                result = fn(title, artist)
            except Exception as e:
                print(f"  [{src_name}] ERROR: {e}", file=sys.stderr)
                result = None

            if result:
                break

            time.sleep(SOURCE_DELAYS.get(src_name, 1.0))

        pct = (i + 1) / total * 100

        if result:
            save_result(track_id, result)
            rtype = "synced" if result.synced else "plain"
            stats[rtype] += 1
            append_report(track_id, title, artist, result.source, rtype)
            print(f"[{i+1}/{total} {pct:.0f}%] {rtype.upper():6s} [{result.source}] {artist} - {title}")
        else:
            stats["miss"] += 1
            append_report(track_id, title, artist, "none", "miss")
            print(f"[{i+1}/{total} {pct:.0f}%] MISS   {artist} - {title}")

    print(f"\nDone. synced={stats['synced']} plain={stats['plain']} "
          f"miss={stats['miss']} skip={stats['skip']} total={total}")


if __name__ == "__main__":
    main()
