"""Embed lyrics via TEI BGE-M3 and upsert to Qdrant as named vector 'lyrics'.

Usage:
    python3 scripts/embed_lyrics.py \
        --db ~/.local/share/rustify-player/library.db \
        --tei-url http://localhost:8080 \
        --qdrant-url http://localhost:6333
"""
import argparse
import json
import sqlite3
import struct
import urllib.request

COLLECTION = "rustify_tracks"
BATCH_SIZE = 50


def get_lyrics(db_path: str) -> list[tuple[int, str]]:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA query_only = ON")
    rows = conn.execute(
        "SELECT id, embedded_lyrics FROM tracks WHERE embedded_lyrics IS NOT NULL AND LENGTH(embedded_lyrics) > 20"
    ).fetchall()
    conn.close()
    return rows


def get_existing_lyrics_ids(qdrant_url: str) -> set[int]:
    """Scroll points that already have the 'lyrics' vector."""
    ids = set()
    offset = None
    while True:
        payload = {"limit": 1000, "with_payload": False, "with_vector": ["lyrics"]}
        if offset is not None:
            payload["offset"] = offset
        req = urllib.request.Request(
            f"{qdrant_url}/collections/{COLLECTION}/points/scroll",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
        for p in data["result"]["points"]:
            vec = p.get("vector", {})
            if isinstance(vec, dict) and vec.get("lyrics"):
                ids.add(p["id"])
        next_off = data["result"].get("next_page_offset")
        if next_off is None:
            break
        offset = next_off
    return ids


def embed_text(tei_url: str, text: str) -> list[float]:
    payload = json.dumps({"inputs": text, "truncate": True}).encode()
    req = urllib.request.Request(
        f"{tei_url}/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    return result[0]


def upsert_lyrics(qdrant_url: str, points: list[tuple[int, list[float]]]):
    pts = [{"id": tid, "vector": {"lyrics": vec}} for tid, vec in points]
    payload = json.dumps({"points": pts}).encode()
    req = urllib.request.Request(
        f"{qdrant_url}/collections/{COLLECTION}/points",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser(description="Embed lyrics and upsert to Qdrant")
    parser.add_argument("--db", required=True, help="Path to library.db")
    parser.add_argument("--tei-url", default="http://localhost:8080")
    parser.add_argument("--qdrant-url", default="http://localhost:6333")
    parser.add_argument("--force", action="store_true", help="Re-embed all, skip incremental check")
    args = parser.parse_args()

    rows = get_lyrics(args.db)
    print(f"Tracks with lyrics: {len(rows)}")

    if not args.force:
        existing = get_existing_lyrics_ids(args.qdrant_url)
        rows = [(tid, text) for tid, text in rows if tid not in existing]
        print(f"New to embed: {len(rows)} (skipping {len(existing)} existing)")

    if not rows:
        print("Nothing to do.")
        return

    batch = []
    for i, (track_id, lyrics) in enumerate(rows):
        vec = embed_text(args.tei_url, lyrics)
        batch.append((track_id, vec))

        if len(batch) >= BATCH_SIZE:
            result = upsert_lyrics(args.qdrant_url, batch)
            print(f"  [{i+1}/{len(rows)}] upserted {len(batch)} — {result['status']}")
            batch = []

    if batch:
        result = upsert_lyrics(args.qdrant_url, batch)
        print(f"  [{len(rows)}/{len(rows)}] upserted {len(batch)} — {result['status']}")

    print(f"Done. Embedded {len(rows)} lyrics.")


if __name__ == "__main__":
    main()
