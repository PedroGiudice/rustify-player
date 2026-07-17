#!/usr/bin/env python3
"""Pre-classify tracks using local Ollama (qwen3:14b-nothink) before Gemini refinement."""

import json
import time
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

QDRANT_URL = "http://127.0.0.1:16333"  # tunel SSH -> cmr-auto:6333 (bind loopback desde 2026-07-17)
OLLAMA_URL = "http://100.123.73.128:11434"
MODEL = "qwen3:14b"
COLLECTION = "rustify_tracks"
OUTPUT_PATH = Path(__file__).parent.parent / "data" / "mood-classifications-local.json"
BATCH_SIZE = 20

SYSTEM_PROMPT = """You are a music classifier. Given a track's metadata, output a JSON object with:
- mood_tags: array of 2-4 mood descriptors (e.g., "melancholic", "energetic", "romantic", "aggressive", "chill", "uplifting", "dark", "nostalgic", "dreamy", "intense")
- activity_tags: array of 1-3 activities this fits (e.g., "workout", "study", "driving", "party", "sleep", "cooking", "meditation")
- energy: float 0.0-1.0 (0=very calm, 1=very intense)
- valence: float 0.0-1.0 (0=very negative/sad, 1=very positive/happy)

Output ONLY the JSON object, no explanation."""


def qdrant_scroll(offset=None):
    body = {
        "limit": BATCH_SIZE,
        "with_payload": {"include": ["title", "artist", "album", "genre"]},
    }
    if offset:
        body["offset"] = offset
    req = Request(
        f"{QDRANT_URL}/collections/{COLLECTION}/points/scroll",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = json.loads(urlopen(req).read())
    return resp["result"]["points"], resp["result"].get("next_page_offset")


def classify_track(title, artist, genre=None, album=None):
    parts = [f"Title: {title}", f"Artist: {artist}"]
    if genre:
        parts.append(f"Genre: {genre}")
    if album:
        parts.append(f"Album: {album}")
    user_msg = "\n".join(parts)

    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "think": False,
        "options": {"temperature": 0.3, "num_predict": 256},
    }
    req = Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = json.loads(urlopen(req, timeout=120).read())
    content = resp["choices"][0]["message"]["content"] if "choices" in resp else resp["message"]["content"]

    # Extract JSON from response
    content = content.strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(content)


def main():
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Resume from existing output
    results = {}
    if OUTPUT_PATH.exists():
        results = {str(k): v for k, v in json.load(open(OUTPUT_PATH)).items()}
        print(f"Resuming: {len(results)} already classified")

    offset = None
    total = 0
    errors = 0
    start = time.time()

    while True:
        points, offset = qdrant_scroll(offset)
        if not points:
            break

        for point in points:
            track_id = str(point["id"])
            if track_id in results:
                total += 1
                continue

            payload = point.get("payload", {})
            title = payload.get("title", "Unknown")
            artist = payload.get("artist", "Unknown")
            genre = payload.get("genre")
            album = payload.get("album")

            try:
                classification = classify_track(title, artist, genre, album)
                results[track_id] = {
                    "title": title,
                    "artist": artist,
                    "genre": genre,
                    **classification,
                }
                total += 1
                elapsed = time.time() - start
                rate = total / elapsed if elapsed > 0 else 0
                print(f"[{total}/983] {artist} - {title} | {classification.get('mood_tags', [])} ({rate:.1f} tracks/s)")
            except (json.JSONDecodeError, KeyError, URLError) as e:
                errors += 1
                total += 1
                print(f"[{total}/983] ERROR: {artist} - {title}: {e}", file=sys.stderr)
                results[track_id] = {
                    "title": title,
                    "artist": artist,
                    "genre": genre,
                    "error": str(e),
                }

            # Save every 10 tracks
            if total % 10 == 0:
                json.dump(results, open(OUTPUT_PATH, "w"), ensure_ascii=False, indent=2)

        if not offset:
            break

    json.dump(results, open(OUTPUT_PATH, "w"), ensure_ascii=False, indent=2)
    elapsed = time.time() - start
    print(f"\nDone: {total} tracks, {errors} errors, {elapsed:.0f}s ({total/elapsed:.1f} tracks/s)")
    print(f"Output: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
