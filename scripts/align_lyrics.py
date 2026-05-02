#!/usr/bin/env python3
"""Batch forced alignment: wav2vec2 MMS on BS-Roformer stems + Whisper text → LRC.

Reads stems from data/stems-v2/ and texts from data/output-v2/.
Outputs LRC files to data/lyrics-v2/.

Usage:
    python3 scripts/align_lyrics.py
    python3 scripts/align_lyrics.py --id 863          # single track
    python3 scripts/align_lyrics.py --workers 4       # parallel
    python3 scripts/align_lyrics.py --force            # overwrite existing
"""

import argparse
import os
import re
import time
import unicodedata
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed, TimeoutError

TRACK_TIMEOUT = 300  # 5 min max per track

STEMS_DIR = "data/stems-v2"
TEXTS_DIR = "data/output-v2"
OUTPUT_DIR = "data/lyrics-v2"

GAP_THRESHOLD = 1.5  # seconds of silence → new verse line


def normalize_text(text):
    text = text.lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z' ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def detect_hallucination(raw_text):
    """Return True if text looks like Whisper hallucination."""
    words = raw_text.split()
    if len(words) < 3:
        return False
    counts = Counter(w.lower().strip(".,!?") for w in words)
    most_common_count = counts.most_common(1)[0][1]
    unique_ratio = len(counts) / len(words)
    # >50% same word, or <10% unique words in 20+ word text
    if most_common_count / len(words) > 0.5:
        return True
    if len(words) >= 20 and unique_ratio < 0.10:
        return True
    return False


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


def _fmt_ts(seconds):
    m = int(seconds // 60)
    s = seconds % 60
    return f"[{m:02d}:{s:05.2f}]"


def align_track(track_id, force=False, stems_dir=STEMS_DIR, texts_dir=TEXTS_DIR, output_dir=OUTPUT_DIR):
    stem_path = os.path.join(stems_dir, f"{track_id}_vocals.wav")
    text_path = os.path.join(texts_dir, f"{track_id}.txt")
    out_path = os.path.join(output_dir, f"{track_id}.lrc")

    if os.path.exists(out_path) and not force:
        return track_id, "cached", 0

    if not os.path.exists(stem_path):
        return track_id, "no_stem", 0
    if not os.path.exists(text_path):
        return track_id, "no_text", 0

    raw_text = open(text_path, "r").read().strip()
    if not raw_text or len(raw_text) < 5:
        return track_id, "empty_text", 0

    if detect_hallucination(raw_text):
        # Remove garbage LRC if it exists
        if os.path.exists(out_path):
            os.unlink(out_path)
        return track_id, "hallucination", 0

    text = normalize_text(raw_text)
    words = text.split()
    if not words:
        return track_id, "empty_text", 0

    t0 = time.perf_counter()
    import torch
    import torchaudio

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
    prev_end = 0.0

    for i, span in enumerate(token_spans):
        if i >= len(raw_words):
            break
        start = span[0].start * ratio
        end = span[-1].end * ratio

        should_break = False

        # Primary: timing gap between words
        if current_line and i > 0:
            gap = start - prev_end
            if gap > GAP_THRESHOLD:
                should_break = True

        # Secondary: uppercase letter (verse start)
        if current_line and raw_words[i][0].isupper():
            should_break = True

        if should_break:
            lrc_lines.append(f"{_fmt_ts(line_start)}{' '.join(current_line)}")
            current_line = []
            line_start = None

        if line_start is None:
            line_start = start
        current_line.append(raw_words[i])
        prev_end = end

    if current_line and line_start is not None:
        lrc_lines.append(f"{_fmt_ts(line_start)}{' '.join(current_line)}")

    os.makedirs(output_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lrc_lines) + "\n")

    elapsed = time.perf_counter() - t0
    return track_id, "aligned", elapsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", help="Single track ID")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--force", action="store_true", help="Overwrite existing LRCs")
    parser.add_argument("--stems-dir", default=STEMS_DIR)
    parser.add_argument("--texts-dir", default=TEXTS_DIR)
    parser.add_argument("--output-dir", default=OUTPUT_DIR)
    args = parser.parse_args()

    if args.id:
        tid, status, elapsed = align_track(args.id, force=args.force,
                                           stems_dir=args.stems_dir, texts_dir=args.texts_dir,
                                           output_dir=args.output_dir)
        print(f"{tid}: {status} ({elapsed:.1f}s)")
        if status == "aligned":
            print(open(os.path.join(args.output_dir, f"{tid}.lrc")).read())
        return

    track_ids = []
    for f in sorted(os.listdir(args.stems_dir)):
        if f.endswith("_vocals.wav"):
            tid = f.replace("_vocals.wav", "")
            if os.path.exists(os.path.join(args.texts_dir, f"{tid}.txt")):
                track_ids.append(tid)

    print(f"Tracks to align: {len(track_ids)}")

    if not args.force:
        already = sum(1 for tid in track_ids if os.path.exists(os.path.join(args.output_dir, f"{tid}.lrc")))
        if already:
            print(f"Already done: {already}")

    aligned = 0
    skipped = 0
    failed = 0
    hallucinated = 0
    total = len(track_ids)

    dirs = dict(stems_dir=args.stems_dir, texts_dir=args.texts_dir, output_dir=args.output_dir)

    if args.workers <= 1:
        for i, tid in enumerate(track_ids):
            try:
                tid, status, elapsed = align_track(tid, force=args.force, **dirs)
                pct = (i + 1) / total * 100
                if status == "cached":
                    skipped += 1
                elif status == "aligned":
                    aligned += 1
                    print(f"[{i+1}/{total} {pct:.0f}%] {status.upper():10s} {tid}  ({elapsed:.1f}s)")
                elif status == "hallucination":
                    hallucinated += 1
                    print(f"[{i+1}/{total} {pct:.0f}%] {status.upper():10s} {tid}")
                else:
                    failed += 1
                    print(f"[{i+1}/{total} {pct:.0f}%] {status.upper():10s} {tid}")
            except Exception as e:
                failed += 1
                print(f"[{i+1}/{total}] FAIL {tid}: {e}")
    else:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(align_track, tid, args.force, **dirs): tid for tid in track_ids}
            done = 0
            for future in as_completed(futures):
                done += 1
                try:
                    tid, status, elapsed = future.result(timeout=TRACK_TIMEOUT)
                    pct = done / total * 100
                    if status == "cached":
                        skipped += 1
                    elif status == "aligned":
                        aligned += 1
                        print(f"[{done}/{total} {pct:.0f}%] {status.upper():10s} {tid}  ({elapsed:.1f}s)")
                    elif status == "hallucination":
                        hallucinated += 1
                        print(f"[{done}/{total} {pct:.0f}%] {status.upper():10s} {tid}")
                    else:
                        failed += 1
                        print(f"[{done}/{total} {pct:.0f}%] {status.upper():10s} {tid}")
                except Exception as e:
                    failed += 1
                    print(f"[{done}/{total}] FAIL {futures[future]}: {e}")

    print(f"\nDone. aligned={aligned} cached={skipped} hallucination={hallucinated} failed={failed} total={total}")


if __name__ == "__main__":
    main()
