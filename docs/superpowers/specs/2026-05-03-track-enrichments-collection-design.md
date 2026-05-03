# Track Enrichments Collection — Design Spec

## Problem

`rustify_tracks` is rebuilt via full upsert on every library rescan. Any fields added after indexing (Gemini mood tags, user likes, play counts, dominant colors) are destroyed.

## Solution

New Qdrant collection `track_enrichments` — same numeric IDs as `rustify_tracks`, no vectors (dummy 1-d), holds all non-scan payload fields. The scan pipeline never touches it.

## Collection Schema

```
Collection: track_enrichments
Vectors: dummy 1-d (Qdrant requires at least one)
Points: same IDs as rustify_tracks
```

**Payload fields (migrated from rustify_tracks):**

| Field | Type | Source |
|-------|------|--------|
| `play_count` | integer | record_play() |
| `last_played` | integer (unix) | record_play() |
| `liked_at` | integer (unix) or null | toggle_like() |
| `dominant_color` | string (hex) | get_track_color() fallback |
| `mood_tags` | string[] | Gemini classifier |
| `activity_tags` | string[] | Gemini classifier |
| `energy` | float 0-1 | Gemini classifier |
| `valence` | float 0-1 | Gemini classifier |

## Changes

### 1. qdrant_client.rs

- `ensure_enrichments_collection()` — create collection if missing (dummy 1-d vector, integer indexes on play_count/last_played/liked_at)
- `get_enrichment(track_id) -> Value` — read enrichment payload for one point
- `set_enrichment(track_ids, payload)` — set_payload on enrichments collection
- `scroll_enrichments_with_filter(filter, order_by, limit)` — like scroll_with_filter but targets enrichments collection

### 2. pipeline.rs

- Remove `play_count`, `last_played`, `liked_at`, `dominant_color` from the scan payload (lines 391, 400-402)
- Scan no longer owns these fields

### 3. query.rs

- `record_play()` — change from set_payload on rustify_tracks to set_enrichment on track_enrichments
- `toggle_like()` / `is_liked()` / `list_liked()` — target enrichments collection
- `list_history()` — scroll enrichments collection (order_by last_played), then resolve tracks from rustify_tracks
- `mood_search()` — move from qdrant_client.rs to query.rs, filter on enrichments collection, resolve tracks

### 4. lib.rs

- `get_track_color()` — read/write dominant_color from enrichments collection
- `lib_list_history()` — already calls query::list_history, no change needed
- `lib_mood_search()` — already calls mood_search, update to use enrichments
- Track resolution: queries that return Track structs need to merge enrichment fields (play_count, last_played, liked_at) into the Track before returning to frontend

### 5. Track struct resolution

When returning tracks to the frontend, merge enrichment data:
1. Get track payload from rustify_tracks (title, artist, album, path, etc.)
2. Get enrichment payload from track_enrichments (play_count, last_played, liked_at)
3. Merge into Track struct

This merge happens in the existing `payload_to_track()` helper — add optional enrichment parameter.

### 6. Startup (lib.rs)

Add `client.ensure_enrichments_collection()` alongside existing `ensure_play_events_collection()`.

### 7. Migration

One-time: read play_count/last_played/liked_at/dominant_color from existing rustify_tracks points, write to track_enrichments. Can be a startup migration that runs once.

## What does NOT change

- Frontend — zero changes, Track interface stays identical
- play_events collection — untouched
- Scan pipeline vectors (MERT, lyrics) — untouched
- Search (textual, semantic) — these query rustify_tracks only, no enrichment fields needed

## Risk

- Extra Qdrant round-trip when resolving tracks with enrichment data. Mitigated by batching (scroll enrichments for all returned IDs in one call).
- Migration must be idempotent — running twice should be safe.
