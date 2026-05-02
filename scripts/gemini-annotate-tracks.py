#!/usr/bin/env python3
"""
Gemini 3.1 Flash Lite track mood/activity annotation pipeline.
Reads tracks from extracted JSON, sends batches to Gemini,
outputs annotated JSON for human review before Qdrant upload.

Tracks the model can't confidently classify are skipped (null annotations).
A second pass with Pro can fill those gaps.
"""

import json
import sys
import time
from pathlib import Path
from google import genai
from google.genai import types

MODEL = "gemini-3.1-flash-lite-preview"
INPUT_FILE = "/tmp/rustify_tracks_full.json"
OUTPUT_FILE = "/tmp/rustify_tracks_annotated.json"
BATCH_SIZE = 30
SLEEP_BETWEEN_BATCHES = 1

SYSTEM_PROMPT = """You are a music analyst. You receive batches of tracks from a personal music library and must annotate each one with mood, activity, and energy metadata.

For each track you receive:
- ID, title, artist, genre, duration
- Previous mood station assignment (from an earlier classification pass using only audio embeddings)
- Lyrics text (when available)

For each track, produce these annotations:

1. **mood_tags** (list of 2-5 strings): emotional descriptors. Use from this vocabulary:
   energético, melancólico, romântico, agressivo, festivo, introspectivo,
   empoderador, nostálgico, sombrio, alegre, sensual, rebelde,
   esperançoso, raivoso, contemplativo, eufórico, misterioso, dramático

2. **activity_tags** (list of 1-4 strings): when/where to listen. Use from this vocabulary:
   malhar, relaxar, dirigir, estudar, festa, acordar, dormir,
   cozinhar, correr, trabalhar, meditar, dançar, road_trip, churrasco

3. **energy** (float 0.0-1.0): 0=very calm, 1=very intense

4. **valence** (float 0.0-1.0): 0=very negative/sad, 1=very positive/happy

IMPORTANT:
- Use the lyrics to understand the ACTUAL mood of the song, not just the genre.
- A song can be in an energetic genre but have sad lyrics — the lyrics should inform valence.
- The previous mood station is a reference, not gospel — correct it if lyrics tell a different story.
- For tracks WITHOUT lyrics, use your knowledge of the artist and song if you know it.
- If you do NOT know a track and have no lyrics, set ALL fields to null instead of guessing. Do not fabricate annotations for unknown tracks.
- Be precise: Tom Jobim bossa nova is calm (energy ~0.2), not workout music.
- Brazilian funk (Funk BR) varies widely: "Baile de Favela" is high energy party, but some funk is melodic/sensual.
- Output ONLY valid JSON, no markdown, no explanation."""

USER_PROMPT_TEMPLATE = """Annotate these {count} tracks. Return a JSON array where each element has:
{{"id": <track_id>, "mood_tags": [...] or null, "activity_tags": [...] or null, "energy": <float> or null, "valence": <float> or null}}

Set fields to null if you cannot confidently classify a track.

Tracks:
{tracks_block}

Return ONLY the JSON array."""


def format_track(t: dict) -> str:
    parts = [f"ID:{t['id']}"]
    parts.append(f"Title: {t['title']}")
    parts.append(f"Artist: {t['artist_name']}")
    if t.get("album_title"):
        parts.append(f"Album: {t['album_title']}")
    if t.get("genre"):
        parts.append(f"Genre: {t['genre']}")
    dur_s = (t.get("duration_ms") or 0) // 1000
    parts.append(f"Duration: {dur_s // 60}:{dur_s % 60:02d}")
    if t.get("mood_station"):
        parts.append(f"Previous mood: {t['mood_station']}")
    if t.get("lyrics_text"):
        parts.append(f"Lyrics:\n{t['lyrics_text'][:800]}")
    else:
        parts.append("Lyrics: [not available]")
    return "\n".join(parts)


def annotate_batch(client, tracks: list[dict], batch_num: int, total_batches: int) -> list[dict]:
    tracks_block = "\n---\n".join(format_track(t) for t in tracks)
    user_prompt = USER_PROMPT_TEMPLATE.format(count=len(tracks), tracks_block=tracks_block)

    print(f"  Batch {batch_num}/{total_batches}: {len(tracks)} tracks...", end=" ", flush=True)

    response = client.models.generate_content(
        model=MODEL,
        contents=user_prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=1.0,
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
        annotations = json.loads(text)
        classified = sum(1 for a in annotations if a.get("mood_tags") is not None)
        skipped = len(annotations) - classified
        print(f"OK: {classified} classified, {skipped} skipped", flush=True)
        return annotations
    except json.JSONDecodeError as e:
        print(f"PARSE ERROR: {e}", flush=True)
        print(f"  Raw (first 500): {text[:500]}", file=sys.stderr, flush=True)
        Path(f"/tmp/gemini_batch_{batch_num}_raw.txt").write_text(text)
        return []


def main():
    with open(INPUT_FILE) as f:
        tracks = json.load(f)

    print(f"Loaded {len(tracks)} tracks from {INPUT_FILE}")

    existing = {}
    if Path(OUTPUT_FILE).exists():
        with open(OUTPUT_FILE) as f:
            existing = {a["id"]: a for a in json.load(f)}
        print(f"Resuming: {len(existing)} already done")

    remaining = [t for t in tracks if t["id"] not in existing]
    print(f"Remaining: {len(remaining)}")

    if not remaining:
        print("All done!")
        return

    client = genai.Client()
    batches = [remaining[i : i + BATCH_SIZE] for i in range(0, len(remaining), BATCH_SIZE)]
    all_annotations = list(existing.values())
    errors = 0

    t_start = time.time()
    for i, batch in enumerate(batches, 1):
        try:
            annotations = annotate_batch(client, batch, i, len(batches))
            all_annotations.extend(annotations)
            with open(OUTPUT_FILE, "w") as f:
                json.dump(all_annotations, f, ensure_ascii=False, indent=2)
        except Exception as e:
            errors += 1
            print(f"  BATCH ERROR: {e}", file=sys.stderr, flush=True)
            if errors > 5:
                print("Too many errors, stopping.", file=sys.stderr)
                break
        if i < len(batches):
            time.sleep(SLEEP_BETWEEN_BATCHES)

    elapsed = time.time() - t_start
    print(f"\nDone in {elapsed:.0f}s. {len(all_annotations)} annotations in {OUTPUT_FILE}")
    print(f"Errors: {errors}")

    classified = [a for a in all_annotations if a.get("mood_tags") is not None]
    nulls = [a for a in all_annotations if a.get("mood_tags") is None]
    print(f"Classified: {len(classified)} | Skipped (null): {len(nulls)}")

    if classified:
        energies = [a["energy"] for a in classified]
        print(f"Energy: {min(energies):.2f} - {max(energies):.2f}, avg {sum(energies)/len(energies):.2f}")
        all_moods = set()
        all_activities = set()
        for a in classified:
            all_moods.update(a.get("mood_tags", []))
            all_activities.update(a.get("activity_tags", []))
        print(f"Mood tags used: {sorted(all_moods)}")
        print(f"Activity tags used: {sorted(all_activities)}")


if __name__ == "__main__":
    main()
