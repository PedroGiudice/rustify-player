#!/usr/bin/env python3
"""Batch forced alignment: wav2vec2 MMS on BS-Roformer stems + Whisper text → LRC.

Reads stems from data/stems-v2/ and texts from data/output-v2/.
Outputs LRC files to data/lyrics-v2/.

Usage:
    python3 scripts/align_lyrics.py
    python3 scripts/align_lyrics.py --id 863          # single track
    python3 scripts/align_lyrics.py --workers 4       # parallel
"""

import argparse
import os
import re
import sys
import time
import unicodedata
from concurrent.futures import ProcessPoolExecutor, as_completed

STEMS_DIR = "data/stems-v2"
TEXTS_DIR = "data/output-v2"
OUTPUT_DIR = "data/lyrics-v2"

def normalize_text(text):
    text = text.lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z' ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


_model = None
_tokenizer = None
_aligner = None
_bundle = None


def _get_model():
    global _model, _tokenizer, _aligner, _bundle
    if _model is None:
        import torchaudio
        _bundle = torchaudio.pipelines.MMS_FA
        _model = _bundle.get_model()
        _tokenizer = _bundle.get_tokenizer()
        _aligner = _bundle.get_aligner()
    return _model, _tokenizer, _aligner, _bundle


def align_track(track_id):
    import torch
    import torchaudio

    stem_path = os.path.join(STEMS_DIR, f"{track_id}_vocals.wav")
    text_path = os.path.join(TEXTS_DIR, f"{track_id}.txt")
    out_path = os.path.join(OUTPUT_DIR, f"{track_id}.lrc")

    if os.path.exists(out_path):
        return track_id, "cached", 0

    if not os.path.exists(stem_path):
        return track_id, "no_stem", 0
    if not os.path.exists(text_path):
        return track_id, "no_text", 0

    raw_text = open(text_path, "r").read().strip()
    if not raw_text or len(raw_text) < 5:
        return track_id, "empty_text", 0

    text = normalize_text(raw_text)
    words = text.split()
    if not words:
        return track_id, "empty_text", 0

    t0 = time.perf_counter()

    model, tokenizer, aligner, bundle = _get_model()

    waveform, sr = torchaudio.load(stem_path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sr != bundle.sample_rate:
        waveform = torchaudio.functional.resample(waveform, sr, bundle.sample_rate)

    with torch.inference_mode():
        emission, _ = model(waveform)

    tokens = tokenizer(words)
    token_spans = aligner(emission[0], tokens)
    ratio = waveform.shape[1] / emission.shape[1] / bundle.sample_rate

    lrc_lines = []
    raw_words = raw_text.split()

    current_line = []
    line_start = None

    for i, span in enumerate(token_spans):
        if i >= len(raw_words):
            break
        start = span[0].start * ratio

        if raw_words[i][0].isupper() and current_line:
            m = int(line_start // 60)
            s = line_start % 60
            lrc_lines.append(f"[{m:02d}:{s:05.2f}]{' '.join(current_line)}")
            current_line = []
            line_start = None

        if line_start is None:
            line_start = start
        current_line.append(raw_words[i])

    if current_line and line_start is not None:
        m = int(line_start // 60)
        s = line_start % 60
        lrc_lines.append(f"[{m:02d}:{s:05.2f}]{' '.join(current_line)}")

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lrc_lines) + "\n")

    elapsed = time.perf_counter() - t0
    return track_id, "aligned", elapsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", help="Single track ID")
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()

    if args.id:
        tid, status, elapsed = align_track(args.id)
        print(f"{tid}: {status} ({elapsed:.1f}s)")
        if status == "aligned":
            print(open(os.path.join(OUTPUT_DIR, f"{tid}.lrc")).read())
        return

    track_ids = []
    for f in sorted(os.listdir(STEMS_DIR)):
        if f.endswith("_vocals.wav"):
            tid = f.replace("_vocals.wav", "")
            if os.path.exists(os.path.join(TEXTS_DIR, f"{tid}.txt")):
                track_ids.append(tid)

    print(f"Tracks to align: {len(track_ids)}")

    already = sum(1 for tid in track_ids if os.path.exists(os.path.join(OUTPUT_DIR, f"{tid}.lrc")))
    if already:
        print(f"Already done: {already}")

    aligned = 0
    skipped = 0
    failed = 0
    total = len(track_ids)

    if args.workers <= 1:
        for i, tid in enumerate(track_ids):
            try:
                tid, status, elapsed = align_track(tid)
                pct = (i + 1) / total * 100
                if status == "cached":
                    skipped += 1
                elif status == "aligned":
                    aligned += 1
                    print(f"[{i+1}/{total} {pct:.0f}%] {status.upper():10s} {tid}  ({elapsed:.1f}s)")
                else:
                    failed += 1
                    print(f"[{i+1}/{total} {pct:.0f}%] {status.upper():10s} {tid}")
            except Exception as e:
                failed += 1
                print(f"[{i+1}/{total}] FAIL {tid}: {e}")
    else:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(align_track, tid): tid for tid in track_ids}
            done = 0
            for future in as_completed(futures):
                done += 1
                try:
                    tid, status, elapsed = future.result()
                    pct = done / total * 100
                    if status == "cached":
                        skipped += 1
                    elif status == "aligned":
                        aligned += 1
                        print(f"[{done}/{total} {pct:.0f}%] {status.upper():10s} {tid}  ({elapsed:.1f}s)")
                    else:
                        failed += 1
                        print(f"[{done}/{total} {pct:.0f}%] {status.upper():10s} {tid}")
                except Exception as e:
                    failed += 1
                    print(f"[{done}/{total}] FAIL {futures[future]}: {e}")

    print(f"\nDone. aligned={aligned} cached={skipped} failed={failed} total={total}")


if __name__ == "__main__":
    main()
