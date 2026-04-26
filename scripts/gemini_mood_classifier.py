#!/usr/bin/env python3
"""Classify music tracks into mood playlists via Gemini.

Reads track metadata from the Rustify Player SQLite database, sends to
Gemini for mood clustering, and writes the results back as mood playlists.

Can also be run standalone to preview classifications without writing to DB.

Usage:
    # Preview (dry run):
    python3 scripts/gemini_mood_classifier.py --db ~/.local/share/rustify-player/library.db

    # Write to DB:
    python3 scripts/gemini_mood_classifier.py --db ~/.local/share/rustify-player/library.db --write

    # Custom number of moods:
    python3 scripts/gemini_mood_classifier.py --db ... --moods 10
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path


def _load_api_key() -> str:
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


def _log(msg: str, t0: float):
    elapsed = time.time() - t0
    print(f"[{elapsed:6.1f}s] {msg}", file=sys.stderr, flush=True)


def load_tracks(db_path: str) -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT t.id, t.title, ar.name AS artist, g.name AS genre, al.title AS album
        FROM tracks t
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN genres g ON g.id = t.genre_id
        LEFT JOIN albums al ON al.id = t.album_id
        ORDER BY g.name, ar.name, t.title
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def build_prompt(tracks: list[dict], num_moods: int) -> str:
    # Build compact track list
    lines = []
    for t in tracks:
        parts = [str(t["id"]), t["title"] or "?", t["artist"] or "?"]
        if t["genre"]:
            parts.append(t["genre"])
        if t["album"]:
            parts.append(t["album"])
        lines.append(" | ".join(parts))

    track_text = "\n".join(lines)

    return f"""You are a music curator. Given a personal music library, create {num_moods} mood/vibe playlists that group songs by feel, energy, and listening context — NOT just by genre.

Rules:
- Each playlist gets a short, evocative name in Portuguese (BR) — think vibes, not genres. Examples: "Noite Eletrônica", "Rap Introspectivo", "Funk Pesadão", "Psicodelia", "Chill & Ambient", "Agito BR".
- Names should be 2-4 words max. Creative but immediately understandable.
- Every track MUST appear in exactly one playlist. No track left out, no duplicates.
- Consider the artist's style, genre, and album context when grouping.
- Prioritize listening feel over strict genre boundaries. A chill rap track belongs with chill music, not with hype rap.
- If an artist's tracks span multiple vibes, split them across playlists.

Return a JSON object with this exact structure:
```json
{{
  "playlists": [
    {{
      "name": "Playlist Name",
      "description": "One sentence describing the vibe",
      "track_ids": [1, 2, 3, ...]
    }}
  ]
}}
```

## TRACKS ({len(tracks)} total):

{track_text}"""


def classify(tracks: list[dict], num_moods: int, model: str) -> dict:
    from google import genai
    from google.genai import types

    api_key = _load_api_key()
    os.environ["GOOGLE_API_KEY"] = api_key
    os.environ.pop("GEMINI_API_KEY", None)

    client = genai.Client(api_key=api_key)
    t0 = time.time()

    prompt = build_prompt(tracks, num_moods)
    _log(f"{len(prompt):,} chars prompt (~{len(prompt)//4:,} tokens). Sending to {model}...", t0)

    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.4,
            max_output_tokens=65536,
        ),
    )

    text = response.text.strip()

    # Parse JSON
    if "```" in text:
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()

    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        _log(f"PARSE ERROR. Raw ({len(text)} chars):\n{text[:2000]}", t0)
        return {"error": "parse_failed", "raw": text[:5000]}

    # Usage stats
    tokens_in = tokens_out = 0
    if hasattr(response, "usage_metadata") and response.usage_metadata:
        u = response.usage_metadata
        tokens_in = u.prompt_token_count or 0
        tokens_out = u.candidates_token_count or 0

    elapsed = time.time() - t0
    playlists = result.get("playlists", [])
    total_assigned = sum(len(p.get("track_ids", [])) for p in playlists)

    _log(f"Done: {len(playlists)} playlists, {total_assigned}/{len(tracks)} tracks assigned", t0)
    _log(f"Tokens: {tokens_in:,} in / {tokens_out:,} out", t0)

    # Cost (Gemini 2.5 Flash)
    cost = (tokens_in * 0.15 + tokens_out * 0.60) / 1_000_000
    _log(f"Est. cost: ${cost:.4f}", t0)

    for p in playlists:
        _log(f"  {p['name']:30s} — {len(p.get('track_ids', [])):3d} tracks", t0)

    # Validate all tracks assigned
    all_ids = {t["id"] for t in tracks}
    assigned_ids = set()
    for p in playlists:
        assigned_ids.update(p.get("track_ids", []))
    missing = all_ids - assigned_ids
    if missing:
        _log(f"WARNING: {len(missing)} tracks not assigned to any playlist", t0)

    result["tokens_in"] = tokens_in
    result["tokens_out"] = tokens_out
    result["elapsed"] = round(elapsed, 1)
    result["model"] = model

    return result


def write_to_db(db_path: str, result: dict):
    conn = sqlite3.connect(db_path)
    now = int(time.time())

    conn.execute("DELETE FROM mood_playlist_tracks")
    conn.execute("DELETE FROM mood_playlists")

    for p in result.get("playlists", []):
        name = p["name"]
        track_ids = p.get("track_ids", [])
        description = p.get("description", "")

        conn.execute(
            "INSERT INTO mood_playlists (name, track_count, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, len(track_ids), now, now),
        )
        mood_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

        for i, tid in enumerate(track_ids):
            conn.execute(
                "INSERT OR IGNORE INTO mood_playlist_tracks (mood_playlist_id, track_id, distance) VALUES (?, ?, ?)",
                (mood_id, tid, i / max(len(track_ids), 1)),
            )

    conn.commit()
    conn.close()
    print(f"Wrote {len(result.get('playlists', []))} mood playlists to {db_path}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Classify music into mood playlists via Gemini")
    parser.add_argument("--db", required=True, help="Path to library.db")
    parser.add_argument("--moods", type=int, default=8, help="Number of mood playlists (default: 8)")
    parser.add_argument("--model", default="gemini-3-flash-preview", help="Gemini model")
    parser.add_argument("--write", action="store_true", help="Write results to DB (default: dry run)")
    parser.add_argument("--output", help="Save JSON result to file")
    args = parser.parse_args()

    tracks = load_tracks(args.db)
    print(f"Loaded {len(tracks)} tracks from {args.db}", file=sys.stderr)

    result = classify(tracks, args.moods, args.model)

    if "error" in result:
        sys.exit(1)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"Saved to {args.output}", file=sys.stderr)

    if args.write:
        write_to_db(args.db, result)
    else:
        print("\nDry run. Use --write to persist to DB.", file=sys.stderr)
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
