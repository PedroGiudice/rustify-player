#!/usr/bin/env python3
"""Deploy .lrc files to cmr-auto, placing each next to its FLAC.

Reads the CSV to map track_id -> audio path, then SCPs each .lrc to the
correct directory on cmr-auto.

Usage:
    python3 scripts/deploy-lyrics.py /tmp/tracks.csv --lyrics-dir /tmp/lyrics
"""

import csv
import os
import subprocess
import sys

REMOTE = "cmr-auto@100.102.249.9"


def main():
    csv_path = sys.argv[1]
    lyrics_dir = "/tmp/lyrics"
    if "--lyrics-dir" in sys.argv:
        idx = sys.argv.index("--lyrics-dir")
        lyrics_dir = sys.argv[idx + 1]

    # Build map: track_id -> audio_path
    with open(csv_path, newline="", encoding="utf-8") as f:
        id_to_path = {row[0]: row[1] for row in csv.reader(f)}

    # Collect lrc files and their remote destinations
    transfers = []  # (local_lrc, remote_dir, remote_filename)
    for fname in os.listdir(lyrics_dir):
        if not fname.endswith(".lrc"):
            continue
        # Format: <track_id>__<original_name>.lrc
        parts = fname.split("__", 1)
        if len(parts) != 2:
            continue
        track_id = parts[0]
        audio_path = id_to_path.get(track_id)
        if not audio_path:
            continue
        # Target: same dir as audio, same base name + .lrc
        audio_base = os.path.splitext(audio_path)[0]
        remote_lrc = audio_base + ".lrc"
        local_lrc = os.path.join(lyrics_dir, fname)
        transfers.append((local_lrc, remote_lrc))

    print(f"Deploying {len(transfers)} .lrc files to {REMOTE}...")

    # Batch: create a tar on stdin, extract on remote
    # This avoids 300 individual SCP calls
    import tarfile
    import io
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as tmp:
        tmp_path = tmp.name
        with tarfile.open(tmp.name, "w") as tar:
            for local_lrc, remote_lrc in transfers:
                tar.add(local_lrc, arcname=remote_lrc)

    # Send tar and extract on remote
    result = subprocess.run(
        ["ssh", REMOTE, "tar", "xf", "-", "-C", "/"],
        stdin=open(tmp_path, "rb"),
        capture_output=True, text=True
    )

    os.unlink(tmp_path)

    if result.returncode == 0:
        print(f"Done. {len(transfers)} .lrc files deployed.")
    else:
        print(f"Error: {result.stderr}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
