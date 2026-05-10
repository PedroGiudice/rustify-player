#!/usr/bin/env python3
"""
Classify each frame of a generated shape animation using Gemini Flash 2.5.

Reads color_NNNN.jpg from media/shapes/<name>/, sends each to Gemini with a
structured-output schema, and rewrites manifest.json with:

    intensity_ranking: list[int]   # frame indices sorted dim → bright
    band_groups: {bass|mid|treble: list[int]}
    mood_groups: {calm|active|peak: list[int]}
    classifications: list[per-frame dict]   # raw per-frame output

Frontend uses this to map audio energy organically — kick → highest-intensity
frame, bass dominance → frames classified as "bass", etc.

Usage:
    python scripts/classify_shape_anim.py --name burning-R [--shapes-dir PATH]

Default shapes dir is the local rustify-player media root on this VM
(/home/opc/.local/share/rustify-player/media/shapes); use --shapes-dir to point
at the cmr-auto path or a tmp build output.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path


PROMPT = """\
You are classifying a single frame from a short animated visualizer that will be
audio-reactive. Frames come from the same animation loop, so they look similar.
Make subtle distinctions across the full 0-100 intensity range — do not collapse
everything to a single high or low value. Differentiate frames by relative changes
in brightness, density, and visual motion compared to a calm/peak version of the
same scene.

1. intensity (0-100): overall visual energy. Use the full range. The dimmest
   moment of the loop = low values (10-30), the brightest peak = high values
   (80-100). Most frames should fall between. Avoid clustering.

2. band: which audio frequency this frame visually represents.
   - "bass": dense, heavy, concentrated mass; the core/center of the form
     dominates; little outer detail; feels low and weighty
   - "mid": balanced state with moderate movement; mid-radius details visible;
     neither dim nor explosive
   - "treble": sharp, fast, bright peripheral detail; sparks, fine arcs, edges,
     dispersing particles; high-frequency visual content

   Aim for a mix across all three bands across the full sequence.

3. mood:
   - "calm": low-energy moment of the loop, less motion than average
   - "active": typical state, ongoing motion
   - "peak": climactic instant, most intense moment

Return JSON only, no extra text.
"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "intensity": {"type": "INTEGER"},
        "band": {"type": "STRING", "enum": ["bass", "mid", "treble"]},
        "mood": {"type": "STRING", "enum": ["calm", "active", "peak"]},
    },
    "required": ["intensity", "band", "mood"],
}


@dataclass
class FrameClassification:
    index: int
    intensity: int
    band: str
    mood: str


def numeric_classify(shape_dir: Path, frame_count: int) -> list["FrameClassification"]:
    """Classifica frames por brilho medio relativo. Deterministico, zero-cost."""
    from PIL import Image

    luminances: list[tuple[int, float]] = []
    for i in range(frame_count):
        # Pixel-art shapes use PNG; default uses JPEG
        path = shape_dir / f"color_{i:04d}.png"
        if not path.is_file():
            path = shape_dir / f"color_{i:04d}.jpg"
        if not path.is_file():
            raise FileNotFoundError(f"missing frame: {path}")
        img = Image.open(path).convert("L")
        # mean luminance: media simples dos pixels (0..255)
        pixels = img.getdata()
        mean_lum = sum(pixels) / len(pixels)
        luminances.append((i, mean_lum))
        sys.stdout.write(f"\rread {i + 1}/{frame_count}")
        sys.stdout.flush()
    sys.stdout.write("\n")

    # Normaliza pra 0..100 baseado no range observado
    lums = [l for _, l in luminances]
    lo, hi = min(lums), max(lums)
    span = max(hi - lo, 1e-6)

    # Ordena por luminancia (dim -> bright)
    sorted_idx = sorted(range(frame_count), key=lambda i: luminances[i][1])

    # Tertiles pra band: 33/33/33 (bass=dimmest, treble=brightest)
    n = frame_count
    band_cuts = [n // 3, 2 * n // 3]
    band_for: dict[int, str] = {}
    for rank, frame_idx in enumerate(sorted_idx):
        if rank < band_cuts[0]:
            band_for[frame_idx] = "bass"
        elif rank < band_cuts[1]:
            band_for[frame_idx] = "mid"
        else:
            band_for[frame_idx] = "treble"

    # Quartis pra mood: 25/50/25 (calm=quartil inferior, peak=quartil superior, active=meio)
    mood_cuts = [n // 4, 3 * n // 4]
    mood_for: dict[int, str] = {}
    for rank, frame_idx in enumerate(sorted_idx):
        if rank < mood_cuts[0]:
            mood_for[frame_idx] = "calm"
        elif rank < mood_cuts[1]:
            mood_for[frame_idx] = "active"
        else:
            mood_for[frame_idx] = "peak"

    classifications: list[FrameClassification] = []
    for i, lum in luminances:
        intensity = int(round((lum - lo) / span * 100))
        classifications.append(FrameClassification(
            index=i, intensity=intensity, band=band_for[i], mood=mood_for[i],
        ))
    return classifications


def classify_frame(client, image_path: Path) -> dict:
    from google.genai import types
    image_bytes = image_path.read_bytes()
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
            PROMPT,
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SCHEMA,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    parsed = json.loads(resp.text)
    # Gemini com response_schema as vezes retorna [{...}] em vez de {...}
    if isinstance(parsed, list):
        if not parsed:
            raise ValueError("empty list response")
        parsed = parsed[0]
    if not isinstance(parsed, dict):
        raise ValueError(f"unexpected response type: {type(parsed).__name__}")
    return parsed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="shape directory name (e.g., burning-R)")
    ap.add_argument(
        "--shapes-dir",
        default=os.path.expanduser("~/.local/share/rustify-player/media/shapes"),
        help="parent directory containing shape subdirs",
    )
    ap.add_argument("--retry", type=int, default=2, help="retries per frame on transient errors (gemini only)")
    ap.add_argument(
        "--method",
        choices=["numeric", "gemini"],
        default="numeric",
        help="numeric (default): bucket por brilho medio, deterministico, zero-cost; "
             "gemini: classificacao semantica via Gemini Flash 2.5 (~$0.012/shape, "
             "ruim em shapes visualmente homogeneas)",
    )
    args = ap.parse_args()

    shape_dir = Path(args.shapes_dir) / args.name
    manifest_path = shape_dir / "manifest.json"
    if not manifest_path.is_file():
        print(f"manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text())
    frame_count = manifest["frames"]

    if args.method == "numeric":
        try:
            classifications = numeric_classify(shape_dir, frame_count)
        except Exception as e:
            print(f"\nnumeric classify failed: {e}", file=sys.stderr)
            return 1
    else:
        from google import genai

        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            print("GEMINI_API_KEY not set", file=sys.stderr)
            return 1

        client = genai.Client(api_key=api_key)
        classifications = []
        for i in range(frame_count):
            idx = f"{i:04d}"
            path = shape_dir / f"color_{idx}.jpg"
            if not path.is_file():
                print(f"missing frame: {path}", file=sys.stderr)
                return 1

            last_err: Exception | None = None
            for attempt in range(args.retry + 1):
                try:
                    result = classify_frame(client, path)
                    classifications.append(
                        FrameClassification(
                            index=i,
                            intensity=int(result["intensity"]),
                            band=result["band"],
                            mood=result["mood"],
                        )
                    )
                    last_err = None
                    break
                except Exception as e:
                    last_err = e
                    time.sleep(1 + attempt)
            if last_err is not None:
                print(f"\nfailed frame {i}: {last_err}", file=sys.stderr)
                return 1

            sys.stdout.write(f"\rclassified {i + 1}/{frame_count}")
            sys.stdout.flush()
        sys.stdout.write("\n")

    intensity_ranking = sorted(range(frame_count), key=lambda i: classifications[i].intensity)
    band_groups: dict[str, list[int]] = {"bass": [], "mid": [], "treble": []}
    mood_groups: dict[str, list[int]] = {"calm": [], "active": [], "peak": []}
    for c in classifications:
        band_groups[c.band].append(c.index)
        mood_groups[c.mood].append(c.index)

    manifest["intensity_ranking"] = intensity_ranking
    manifest["band_groups"] = band_groups
    manifest["mood_groups"] = mood_groups
    manifest["classifications"] = [
        {"index": c.index, "intensity": c.intensity, "band": c.band, "mood": c.mood}
        for c in classifications
    ]
    manifest["classified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"updated {manifest_path}")
    print(f"  intensity range: min={classifications[intensity_ranking[0]].intensity} max={classifications[intensity_ranking[-1]].intensity}")
    print(f"  band counts: bass={len(band_groups['bass'])} mid={len(band_groups['mid'])} treble={len(band_groups['treble'])}")
    print(f"  mood counts: calm={len(mood_groups['calm'])} active={len(mood_groups['active'])} peak={len(mood_groups['peak'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
