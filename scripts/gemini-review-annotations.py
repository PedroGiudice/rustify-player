#!/usr/bin/env python3
"""
Gemini 3.1 Pro review pass over Flash Lite annotations.
- Fixes null annotations (30 tracks Flash Lite couldn't classify)
- Reviews classified annotations for quality, corrects bad ones
- Normalizes out-of-vocabulary tags
"""

import json
import time
from pathlib import Path
from google import genai
from google.genai import types

MODEL = "gemini-3.1-pro-preview"
TRACKS_FILE = "/tmp/rustify_tracks_full.json"
ANNOTATIONS_FILE = "/tmp/rustify_tracks_annotated.json"
OUTPUT_FILE = "/tmp/rustify_tracks_reviewed.json"
BATCH_SIZE = 20
SLEEP_BETWEEN_BATCHES = 2

VALID_MOODS = [
    "energético", "melancólico", "romântico", "agressivo", "festivo",
    "introspectivo", "empoderador", "nostálgico", "sombrio", "alegre",
    "sensual", "rebelde", "esperançoso", "raivoso", "contemplativo",
    "eufórico", "misterioso", "dramático"
]

VALID_ACTIVITIES = [
    "malhar", "relaxar", "dirigir", "estudar", "festa", "acordar",
    "dormir", "cozinhar", "correr", "trabalhar", "meditar", "dançar",
    "road_trip", "churrasco"
]

SYSTEM_PROMPT = f"""You are a senior music analyst reviewing annotations made by a junior analyst.

You receive tracks with their current annotations (mood_tags, activity_tags, energy, valence) and must:

1. VERIFY each annotation against the lyrics and your knowledge of the artist/song
2. CORRECT any annotation that is wrong or imprecise
3. FILL IN null annotations for tracks the junior couldn't classify
4. NORMALIZE tags to the allowed vocabulary

Allowed mood_tags: {', '.join(VALID_MOODS)}
Allowed activity_tags: {', '.join(VALID_ACTIVITIES)}

Rules:
- If an annotation is correct, return it unchanged
- If energy/valence values seem off based on lyrics content, correct them
- For null annotations, classify using your knowledge and Google Search if needed
- Remove any tags not in the allowed vocabulary, replace with the closest valid one
- energy: 0.0 (very calm) to 1.0 (very intense)
- valence: 0.0 (very negative/sad) to 1.0 (very positive/happy)
- Output ONLY valid JSON"""

USER_PROMPT_TEMPLATE = """Review these {count} track annotations. Return the corrected JSON array.
Each element: {{"id": <int>, "mood_tags": [...], "activity_tags": [...], "energy": <float>, "valence": <float>, "changed": <bool>}}

Set "changed" to true if you modified anything, false if the original was correct.

Tracks:
{tracks_block}

Return ONLY the JSON array."""


def format_track_with_annotation(track: dict, annotation: dict) -> str:
    parts = [f"ID:{track['id']}"]
    parts.append(f"Title: {track['title']}")
    parts.append(f"Artist: {track['artist_name']}")
    if track.get("genre"):
        parts.append(f"Genre: {track['genre']}")
    dur_s = (track.get("duration_ms") or 0) // 1000
    parts.append(f"Duration: {dur_s // 60}:{dur_s % 60:02d}")
    if track.get("mood_station"):
        parts.append(f"Previous mood station: {track['mood_station']}")

    if annotation.get("mood_tags") is not None:
        parts.append(f"Current mood_tags: {annotation['mood_tags']}")
        parts.append(f"Current activity_tags: {annotation['activity_tags']}")
        parts.append(f"Current energy: {annotation['energy']}")
        parts.append(f"Current valence: {annotation['valence']}")
    else:
        parts.append("Current annotation: NULL (needs classification)")

    if track.get("lyrics_text"):
        parts.append(f"Lyrics:\n{track['lyrics_text'][:800]}")
    else:
        parts.append("Lyrics: [not available]")

    return "\n".join(parts)


def review_batch(client, items: list[tuple[dict, dict]], batch_num: int, total: int) -> list[dict]:
    tracks_block = "\n---\n".join(
        format_track_with_annotation(t, a) for t, a in items
    )
    user_prompt = USER_PROMPT_TEMPLATE.format(count=len(items), tracks_block=tracks_block)

    print(f"  Batch {batch_num}/{total}: {len(items)} tracks...", end=" ", flush=True)

    response = client.models.generate_content(
        model=MODEL,
        contents=user_prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=0.5,
            max_output_tokens=8192,
            tools=[types.Tool(google_search=types.GoogleSearch())],
        ),
    )

    text = response.text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        if text.endswith("```"):
            text = text[: text.rfind("```")]
        text = text.strip()

    try:
        results = json.loads(text)
        changed = sum(1 for r in results if r.get("changed", False))
        print(f"OK: {changed} changed, {len(results) - changed} kept", flush=True)
        return results
    except json.JSONDecodeError as e:
        print(f"PARSE ERROR: {e}", flush=True)
        Path(f"/tmp/gemini_review_batch_{batch_num}_raw.txt").write_text(text)
        return []


def main():
    with open(TRACKS_FILE) as f:
        tracks_by_id = {t["id"]: t for t in json.load(f)}

    with open(ANNOTATIONS_FILE) as f:
        annotations = {a["id"]: a for a in json.load(f)}

    # Priority 1: null annotations
    nulls = [(tracks_by_id[a["id"]], a) for a in annotations.values()
             if a.get("mood_tags") is None and a["id"] in tracks_by_id]

    # Priority 2: out-of-vocabulary tags
    oov = []
    for a in annotations.values():
        if a.get("mood_tags") is None:
            continue
        bad_moods = [t for t in a["mood_tags"] if t not in VALID_MOODS]
        bad_acts = [t for t in (a.get("activity_tags") or []) if t not in VALID_ACTIVITIES]
        if bad_moods or bad_acts:
            oov.append((tracks_by_id[a["id"]], a))

    # Priority 3: random sample for quality check (10% of classified)
    import random
    random.seed(42)
    classified_ids = [a["id"] for a in annotations.values()
                      if a.get("mood_tags") is not None and a["id"] not in {x[1]["id"] for x in oov}]
    sample_size = min(100, len(classified_ids) // 10)
    sample_ids = set(random.sample(classified_ids, sample_size))
    quality_sample = [(tracks_by_id[aid], annotations[aid]) for aid in sample_ids]

    all_items = nulls + oov + quality_sample
    print(f"Review pass: {len(nulls)} nulls + {len(oov)} OOV + {len(quality_sample)} quality sample = {len(all_items)} total")

    # Resume support
    existing = {}
    if Path(OUTPUT_FILE).exists():
        with open(OUTPUT_FILE) as f:
            existing = {r["id"]: r for r in json.load(f)}
        print(f"Resuming: {len(existing)} already reviewed")

    remaining = [(t, a) for t, a in all_items if a["id"] not in existing]
    print(f"Remaining: {len(remaining)}")

    if not remaining:
        print("All done!")
        return

    client = genai.Client()
    batches = [remaining[i:i + BATCH_SIZE] for i in range(0, len(remaining), BATCH_SIZE)]
    all_reviews = list(existing.values())
    errors = 0

    t_start = time.time()
    for i, batch in enumerate(batches, 1):
        try:
            results = review_batch(client, batch, i, len(batches))
            all_reviews.extend(results)
            with open(OUTPUT_FILE, "w") as f:
                json.dump(all_reviews, f, ensure_ascii=False, indent=2)
        except Exception as e:
            errors += 1
            print(f"  ERROR: {e}", flush=True)
            if errors > 3:
                print("Too many errors, stopping.")
                break
        if i < len(batches):
            time.sleep(SLEEP_BETWEEN_BATCHES)

    elapsed = time.time() - t_start
    print(f"\nDone in {elapsed:.0f}s. {len(all_reviews)} reviews in {OUTPUT_FILE}")

    changed = sum(1 for r in all_reviews if r.get("changed", False))
    print(f"Changed: {changed} | Kept: {len(all_reviews) - changed}")

    # Merge reviews into annotations
    merged = dict(annotations)
    for r in all_reviews:
        rid = r["id"]
        merged[rid] = {
            "id": rid,
            "mood_tags": r["mood_tags"],
            "activity_tags": r["activity_tags"],
            "energy": r["energy"],
            "valence": r["valence"],
        }

    final_file = "/tmp/rustify_tracks_final.json"
    with open(final_file, "w") as f:
        json.dump(list(merged.values()), f, ensure_ascii=False, indent=2)

    classified = sum(1 for a in merged.values() if a.get("mood_tags") is not None)
    still_null = sum(1 for a in merged.values() if a.get("mood_tags") is None)
    print(f"\nFinal: {classified} classified, {still_null} still null")
    print(f"Saved to {final_file}")


if __name__ == "__main__":
    main()
