#!/usr/bin/env python3
"""Classify tracks into mood/activity/energy/valence via Gemini.

Reads from Qdrant rustify_tracks, writes to track_enrichments.
Processes in batches of 50 to stay within token limits.
Saves intermediate JSON to data/mood-classifications.json.

Usage:
    python3 scripts/gemini-classify-tracks.py              # dry run
    python3 scripts/gemini-classify-tracks.py --write      # upsert to Qdrant
    python3 scripts/gemini-classify-tracks.py --resume     # skip already classified
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

QDRANT_URL = "http://127.0.0.1:16333"  # tunel SSH -> cmr-auto:6333 (bind loopback desde 2026-07-17)
TRACKS_COLLECTION = "rustify_tracks"
ENRICHMENTS_COLLECTION = "track_enrichments"
OUTPUT_PATH = Path(__file__).parent.parent / "data" / "mood-classifications.json"
BATCH_SIZE = 15


def load_api_key() -> str:
    for env_file in [Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env"]:
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("GEMINI_API_KEY=") and len(line) > 15:
                    return line.split("=", 1)[1].strip()
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        print("ERROR: Set GEMINI_API_KEY in .env or environment", file=sys.stderr)
        sys.exit(1)
    return key


def qdrant_scroll(offset=None):
    body = {
        "limit": BATCH_SIZE,
        "with_payload": {"include": ["title", "artist", "album", "genre"]},
    }
    if offset:
        body["offset"] = offset
    req = Request(
        f"{QDRANT_URL}/collections/{TRACKS_COLLECTION}/points/scroll",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = json.loads(urlopen(req).read())
    return resp["result"]["points"], resp["result"].get("next_page_offset")


def qdrant_set_payload(track_id: int, payload: dict):
    body = {
        "points": [track_id],
        "payload": payload,
    }
    req = Request(
        f"{QDRANT_URL}/collections/{ENRICHMENTS_COLLECTION}/points/payload",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urlopen(req)


def qdrant_upsert_enrichments(enrichments: list[dict]):
    """Set payload on existing enrichment points (no vector needed)."""
    for e in enrichments:
        tid = e["id"]
        payload = {k: v for k, v in e.items() if k not in ("id", "title", "artist", "genre")}
        body = {
            "payload": payload,
            "points": [tid],
        }
        req = Request(
            f"{QDRANT_URL}/collections/{ENRICHMENTS_COLLECTION}/points/payload",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urlopen(req)


def build_batch_prompt(tracks: list[dict]) -> str:
    lines = []
    for t in tracks:
        parts = [str(t["id"]), t.get("title", "?"), t.get("artist", "?")]
        if t.get("genre"):
            parts.append(t["genre"])
        if t.get("album"):
            parts.append(t["album"])
        lines.append(" | ".join(parts))

    track_text = "\n".join(lines)

    return f"""Classify each track below. For each, provide:
- mood_tags: 2-4 mood descriptors from this vocabulary: melancholic, energetic, romantic, aggressive, chill, uplifting, dark, nostalgic, dreamy, intense, playful, groovy, ethereal, raw, triumphant, sensual, anxious, peaceful, rebellious, bittersweet
- activity_tags: 1-3 activities from: workout, study, driving, party, sleep, cooking, meditation, commute, focus, gaming, romance, cleaning, social
- energy: float 0.0-1.0 (0=very calm, 1=very intense)
- valence: float 0.0-1.0 (0=very sad/negative, 1=very happy/positive)

Consider the artist's known style, genre context, and title meaning.
Return a JSON array where each element has "id" (the track ID as number) and the 4 fields above.
Output ONLY the JSON array, no explanation.

## TRACKS ({len(tracks)}):

{track_text}"""


def classify_batch(tracks: list[dict], model: str, api_key: str) -> list[dict]:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    prompt = build_batch_prompt(tracks)

    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.3,
            max_output_tokens=8192,
            response_mime_type="application/json",
        ),
    )

    text = response.text.strip()
    if "```" in text:
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()

    # Attempt JSON repair for common Gemini issues
    try:
        results = json.loads(text)
    except json.JSONDecodeError:
        import re
        # Fix trailing commas before ] or }
        fixed = re.sub(r',\s*([}\]])', r'\1', text)
        # Fix unescaped newlines in strings
        fixed = re.sub(r'(?<!\\)\n(?=[^"]*"[^"]*$)', r'\\n', fixed)
        results = json.loads(fixed)

    tokens_in = tokens_out = 0
    if hasattr(response, "usage_metadata") and response.usage_metadata:
        u = response.usage_metadata
        tokens_in = u.prompt_token_count or 0
        tokens_out = u.candidates_token_count or 0

    return results, tokens_in, tokens_out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Upsert results to Qdrant track_enrichments")
    parser.add_argument("--resume", action="store_true", help="Skip tracks already in output JSON")
    parser.add_argument("--model", default="gemini-2.5-flash", help="Gemini model")
    args = parser.parse_args()

    api_key = load_api_key()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Load existing results for resume
    existing = {}
    if args.resume and OUTPUT_PATH.exists():
        existing = {str(r["id"]): r for r in json.load(open(OUTPUT_PATH))}
        print(f"Resuming: {len(existing)} already classified", file=sys.stderr)

    # Scroll all tracks
    all_tracks = []
    offset = None
    while True:
        points, offset = qdrant_scroll(offset)
        for p in points:
            track = {"id": p["id"], **p.get("payload", {})}
            if not args.resume or str(p["id"]) not in existing:
                all_tracks.append(track)
        if not offset:
            break

    print(f"Tracks to classify: {len(all_tracks)}", file=sys.stderr)

    all_results = list(existing.values()) if args.resume else []
    total_tokens_in = 0
    total_tokens_out = 0
    t0 = time.time()

    for i in range(0, len(all_tracks), BATCH_SIZE):
        batch = all_tracks[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(all_tracks) + BATCH_SIZE - 1) // BATCH_SIZE

        try:
            results, tok_in, tok_out = None, 0, 0
            for attempt in range(3):
                try:
                    results, tok_in, tok_out = classify_batch(batch, args.model, api_key)
                    break
                except json.JSONDecodeError as je:
                    if attempt < 2:
                        print(f"  retry {attempt+1} (JSON error: {je})", file=sys.stderr)
                        time.sleep(3)
                    else:
                        raise
            total_tokens_in += tok_in
            total_tokens_out += tok_out

            # Merge track metadata into results
            track_map = {t["id"]: t for t in batch}
            for r in results:
                tid = r.get("id")
                if tid in track_map:
                    r["title"] = track_map[tid].get("title")
                    r["artist"] = track_map[tid].get("artist")
                    r["genre"] = track_map[tid].get("genre")

            all_results.extend(results)
            elapsed = time.time() - t0
            print(
                f"[batch {batch_num}/{total_batches}] +{len(results)} classified "
                f"({len(all_results)} total, {elapsed:.0f}s, "
                f"${(total_tokens_in * 0.15 + total_tokens_out * 0.60) / 1_000_000:.4f})",
                file=sys.stderr,
            )

            # Save after each batch
            json.dump(all_results, open(OUTPUT_PATH, "w"), ensure_ascii=False, indent=2)

            if args.write and results:
                qdrant_upsert_enrichments(results)
                print(f"  -> upserted {len(results)} to {ENRICHMENTS_COLLECTION}", file=sys.stderr)

        except Exception as e:
            print(f"[batch {batch_num}] ERROR: {e}", file=sys.stderr)
            # Save progress and continue
            json.dump(all_results, open(OUTPUT_PATH, "w"), ensure_ascii=False, indent=2)
            time.sleep(5)
            continue

        # Rate limit: Gemini free tier = 15 RPM
        if i + BATCH_SIZE < len(all_tracks):
            time.sleep(4)

    elapsed = time.time() - t0
    cost = (total_tokens_in * 0.15 + total_tokens_out * 0.60) / 1_000_000
    print(f"\nDone: {len(all_results)} tracks, {elapsed:.0f}s", file=sys.stderr)
    print(f"Tokens: {total_tokens_in:,} in / {total_tokens_out:,} out", file=sys.stderr)
    print(f"Cost: ${cost:.4f}", file=sys.stderr)
    print(f"Output: {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
