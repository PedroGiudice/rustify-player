#!/usr/bin/env python3
"""Batch forced alignment: wav2vec2 MMS on vocal stems + curated text → LRC.

Reads stems from data/stems-v2/ and texts (one verse per line) from
data/scraped-texts/. Outputs LRC files to data/lyrics-v2/.

A quebra de linha do LRC segue a ESTRUTURA DE VERSO do texto-fonte (scraped-texts
traz a letra ja versejada do letras.com), nao heuristica de capitalizacao. O
wav2vec2 da o timestamp real de cada palavra; cada verso recebe o tempo da sua
primeira palavra. Ver segment_by_verses().

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
TEXTS_DIR = "data/scraped-texts"
OUTPUT_DIR = "data/lyrics-v2"


def normalize_text(text):
    text = text.lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z' ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def count_norm_tokens(verse):
    """Numero de tokens que `verse` produz apos normalize_text.

    E a MESMA tokenizacao usada no forced alignment (normalize_text(...).split()),
    entao a contagem por verso casa 1:1 com os word_spans do wav2vec2.
    """
    return len(normalize_text(verse).split())


def segment_by_verses(verses, word_spans):
    """Quebra o LRC pela estrutura de verso do texto-fonte.

    verses: linhas do texto-fonte (versos limpos do scraped-texts), incluindo
            linhas vazias (separadores de estrofe).
    word_spans: tempo de inicio (segundos) de cada palavra alinhada, na ordem do
            texto normalizado flat. 1:1 com normalize_text(" ".join(verses)).split().

    Retorna [(timestamp, texto_do_verso)] — uma entrada por verso nao-vazio,
    com o timestamp da primeira palavra do verso.

    Sem heuristica de maiuscula nem gap temporal: a quebra E a do texto-fonte,
    que ja traz os versos corretos da letra. Se os spans acabarem antes dos versos
    (audio mais curto que a letra), para gracioso e emite o que alinhou.
    """
    out = []
    idx = 0
    n_spans = len(word_spans)
    for verse in verses:
        text = verse.strip()
        if not text:
            continue
        n = count_norm_tokens(verse)
        if n == 0:
            continue
        if idx >= n_spans:
            break
        out.append((word_spans[idx], text))
        idx += n
    return out


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

    # Tempo de inicio de cada palavra alinhada, na ordem do texto normalizado.
    word_spans = [span[0].start * ratio for span in token_spans]

    # Quebra pela ESTRUTURA DE VERSO do texto-fonte (versos limpos do scraped-texts),
    # nao por heuristica de maiuscula/gap. Cada verso = uma linha LRC, com o
    # timestamp da sua primeira palavra.
    verses = raw_text.splitlines()
    lrc_lines = [f"{_fmt_ts(t)}{txt}" for t, txt in segment_by_verses(verses, word_spans)]

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
