#!/usr/bin/env python3
"""One-time migration: copy enrichment fields from rustify_tracks to track_enrichments.

Idempotent — uses upsert, safe to run multiple times.
Run on the machine where Qdrant is running (cmr-auto).

Usage:
    python3 scripts/migrate-enrichments.py [QDRANT_URL]
"""
import json
import sys
import urllib.request

QDRANT = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:6333"
SRC = "rustify_tracks"
DST = "track_enrichments"
FIELDS = ["play_count", "last_played", "liked_at", "dominant_color",
          "mood_tags", "activity_tags", "energy", "valence"]


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{QDRANT}{path}", data=data,
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def put(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{QDRANT}{path}", data=data,
                                headers={"Content-Type": "application/json"},
                                method="PUT")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


offset = None
migrated = 0
skipped = 0

while True:
    body = {
        "limit": 100,
        "with_payload": {"include": FIELDS},
        "with_vector": False,
    }
    if offset is not None:
        body["offset"] = offset

    resp = post(f"/collections/{SRC}/points/scroll", body)
    points = resp["result"]["points"]
    if not points:
        break

    batch = []
    for p in points:
        pid = p["id"]
        payload = p.get("payload", {})
        enr = {}
        for k in FIELDS:
            v = payload.get(k)
            if v is not None and v != 0 and v != []:
                enr[k] = v
        if not enr:
            skipped += 1
            continue
        batch.append({"id": pid, "vector": [0.0], "payload": enr})

    if batch:
        put(f"/collections/{DST}/points?wait=true", {"points": batch})
        migrated += len(batch)

    offset = resp["result"].get("next_page_offset")
    if offset is None:
        break

print(f"Migrated: {migrated}, Skipped: {skipped}")
