"""Embed lyrics via cogmem BGE-M3 and upsert to Qdrant as named vector 'lyrics'.

Source of truth is the Qdrant collection itself, not SQLite: each point's
payload carries `embedded_lyrics` / `lrc_path` (set by the app on scan) and the
point id is the app's `path_to_id(path)` (DefaultHasher/SipHash of the file
path). The SQLite `tracks.id` is a separate autoincrement value and does NOT
match the Qdrant point id — using it produced silent no-op upserts.

Usage:
    python3 scripts/embed_lyrics.py \
        --cogmem-url http://100.123.73.128:3939 \
        --qdrant-url http://localhost:6333 [--force]
"""
import argparse
import json
import re
import urllib.request

COLLECTION = "rustify_tracks"
BATCH_SIZE = 50
_TS = re.compile(r"\[\d+:\d+\.\d+\]")


def _clean(text: str) -> str:
    """Strip LRC inline timestamps, drop blank lines, keep plain text."""
    out = []
    for line in text.splitlines():
        line = _TS.sub("", line).strip()
        if line:
            out.append(line)
    return "\n".join(out)


def _read_lrc(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            return _clean(f.read())
    except (OSError, UnicodeDecodeError):
        return None


def _scroll(qdrant_url: str, with_payload, with_vector=False):
    """Yield every point in the collection (paginated)."""
    offset = None
    while True:
        body = {"limit": 1000, "with_payload": with_payload, "with_vector": with_vector}
        if offset is not None:
            body["offset"] = offset
        req = urllib.request.Request(
            f"{qdrant_url}/collections/{COLLECTION}/points/scroll",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())["result"]
        yield from result["points"]
        offset = result.get("next_page_offset")
        if offset is None:
            break


def get_lyrics(qdrant_url: str) -> list[tuple[int, str]]:
    """[(point_id, text)] from payload — embedded_lyrics first, else lrc_path."""
    rows = []
    for p in _scroll(qdrant_url, ["embedded_lyrics", "lrc_path"]):
        pl = p.get("payload") or {}
        emb = pl.get("embedded_lyrics")
        if emb and len(emb) > 20:
            text = _clean(emb)
        elif pl.get("lrc_path"):
            text = _read_lrc(pl["lrc_path"])
        else:
            text = None
        if text and len(text) > 20:
            rows.append((p["id"], text))
    return rows


def get_existing_lyrics_ids(qdrant_url: str) -> set[int]:
    """Point ids that already carry a 'lyrics' vector."""
    ids = set()
    for p in _scroll(qdrant_url, False, with_vector=["lyrics"]):
        vec = p.get("vector", {})
        if isinstance(vec, dict) and vec.get("lyrics"):
            ids.add(p["id"])
    return ids


def embed_text(cogmem_url: str, text: str) -> list[float]:
    text = text[:8000]
    payload = json.dumps({"inputs": [text], "model": "bge-m3"}).encode()
    req = urllib.request.Request(
        f"{cogmem_url}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["embeddings"][0]


def upsert_lyrics(qdrant_url: str, points: list[tuple[int, list[float]]]):
    pts = [{"id": pid, "vector": {"lyrics": vec}} for pid, vec in points]
    payload = json.dumps({"points": pts}).encode()
    req = urllib.request.Request(
        f"{qdrant_url}/collections/{COLLECTION}/points/vectors",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser(description="Embed lyrics and upsert to Qdrant")
    parser.add_argument("--cogmem-url", default="http://100.123.73.128:3939")
    parser.add_argument("--qdrant-url", default="http://localhost:6333")
    parser.add_argument("--force", action="store_true", help="Re-embed all, skip incremental check")
    args = parser.parse_args()

    rows = get_lyrics(args.qdrant_url)
    print(f"Points with lyrics text: {len(rows)}")

    if not args.force:
        existing = get_existing_lyrics_ids(args.qdrant_url)
        rows = [(pid, t) for pid, t in rows if pid not in existing]
        print(f"New to embed: {len(rows)} (skipping {len(existing)} existing)")

    if not rows:
        print("Nothing to do.")
        return

    batch = []
    skipped = 0
    for i, (pid, text) in enumerate(rows):
        try:
            vec = embed_text(args.cogmem_url, text)
            batch.append((pid, vec))
        except Exception as e:
            print(f"  SKIP {pid}: {e}", flush=True)
            skipped += 1
            continue

        if len(batch) >= BATCH_SIZE:
            result = upsert_lyrics(args.qdrant_url, batch)
            print(f"  [{i+1}/{len(rows)}] upserted {len(batch)} — {result['status']}", flush=True)
            batch = []

    if batch:
        result = upsert_lyrics(args.qdrant_url, batch)
        print(f"  [{len(rows)}/{len(rows)}] upserted {len(batch)} — {result['status']}", flush=True)

    print(f"Done. Embedded {len(rows) - skipped} lyrics, skipped {skipped}.")


if __name__ == "__main__":
    main()
