#!/usr/bin/env python3
"""Download all v2 results (texts + stems) from Modal volume to local."""

import os
import modal

VOL_NAME = "rustify-lyrics-data"
vol = modal.Volume.from_name(VOL_NAME)

def download_dir(remote_prefix, local_dir):
    os.makedirs(local_dir, exist_ok=True)
    entries = list(vol.listdir(remote_prefix, recursive=True))
    files = [e for e in entries if e.type == modal.volume.FileEntryType.FILE]
    print(f"{remote_prefix}: {len(files)} files")

    for i, entry in enumerate(files):
        fname = os.path.basename(entry.path)
        local_path = os.path.join(local_dir, fname)
        if os.path.exists(local_path):
            continue
        with open(local_path, "wb") as f:
            for chunk in vol.read_file(entry.path):
                f.write(chunk)
        if (i + 1) % 50 == 0 or i + 1 == len(files):
            print(f"  [{i + 1}/{len(files)}] downloaded")

    existing = len([e for e in files if os.path.exists(os.path.join(local_dir, os.path.basename(e.path)))])
    print(f"  Done: {existing} files in {local_dir}")


if __name__ == "__main__":
    print("Downloading output-v2 (texts)...")
    download_dir("output-v2", "data/output-v2")

    print("\nDownloading stems-v2 (vocals)...")
    download_dir("stems-v2", "data/stems-v2")
