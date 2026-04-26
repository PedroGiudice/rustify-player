# Rustify Player — Search, Like, Moods

Spec date: 2026-04-26

## Scope

Three features for Rustify Player:

1. **Contextual search** — persistent search bar, scope changes by active view
2. **Like/favorites** — toggle on tracks, feeds "Liked Songs" playlist + influences recommendations
3. **Mood playlists** — k-means clustering on MERT embeddings, heuristic naming, incremental updates

Also included: media keys next/prev fix (already implemented, pending release).

## Current State

- 749 tracks, 100% embedded (768d MERT vectors, L2-normalized)
- 75 artists, 6 dominant genres
- `lib_search` exists (FTS5 tracks + LIKE albums/artists), no frontend UI
- `lib_similar` exists (brute-force dot product, works)
- `lib_recommendations` exists (most played seeds → similar)
- Autoplay by similarity exists (player-bar.js)
- No liked/favorites system
- No clustering or mood generation

---

## 1. Contextual Search

### Behavior

A search input lives in the view header area. Always visible, activated on type + Enter.

| Active view | Scope | Backend call |
|-------------|-------|-------------|
| Home, Tracks, Artists, Albums | Global — searches tracks, albums, artists | `lib_search(query, limit)` |
| Playlists (folder list) | All folders — filters folder names + searches tracks across all folders, shows which folder contains matches | `lib_search_playlists(query)` (new) |
| Inside a playlist (folder) | That folder only — filters tracks within the open folder | Client-side filter on already-loaded tracks |
| History | Filters history list | Client-side filter |
| Queue | Filters current queue | Client-side filter |

### Backend

Existing `lib_search` handles the global case. New IPC command needed:

- `lib_search_playlists(query: String) -> Vec<PlaylistSearchResult>` where `PlaylistSearchResult = { folder: String, tracks: Vec<Track> }`. Searches FTS5 + folder grouping.

### Frontend

- Shared component `search-bar.js` — exported function `mountSearchBar(container, { scope, onResults })`.
- Each view imports it and mounts in its header.
- Results for global search render as grouped sections: Tracks, Albums, Artists (same as `SearchResults` struct).
- Results for playlist search render as folder groups with matched tracks.
- Client-side search (queue, history, inside folder) uses simple `title/artist` substring match on the already-loaded array.
- Clear button (X) restores original view content.
- Keyboard: Enter to search, Escape to clear.

---

## 2. Like / Favorites

### Data model

New column on `tracks` table:

```sql
ALTER TABLE tracks ADD COLUMN liked_at INTEGER;  -- unix timestamp, NULL = not liked
```

No separate table. A liked track is one where `liked_at IS NOT NULL`.

Migration runs at startup in the indexer's `ensure_schema()` — checks if column exists first (`PRAGMA table_info`), adds if missing. Same pattern used for other schema evolutions.

### Backend IPC

- `lib_toggle_like(track_id: i64) -> bool` — toggles liked_at. Returns new liked state.
- `lib_list_liked(limit: Option<usize>) -> Vec<Track>` — returns liked tracks ordered by liked_at DESC.
- `lib_is_liked(track_id: i64) -> bool` — single track check (for player bar state).

### Frontend

- **Player bar**: like toggle button next to track title/artist. Custom icon (not heart — Rustify identity, details below).
- **Track rows**: like toggle in every track table row (tracks view, playlist view, search results).
- **Playlists view**: "Liked Songs" appears as a special entry at the top of the playlists list, with a distinct icon and track count.

### Like icon identity

Instead of a generic heart, the like icon should be unique to Rustify. Options to explore during implementation:
- A spark/flame (rust igniting)
- A gear with a glow
- A soundwave pulse

The icon has two states: default (outline/muted) and liked (filled/accent color). Transition should be snappy, not floaty.

### Influence on intelligence

- `lib_recommendations`: liked tracks are added to the seed pool alongside most-played. A track that is liked but has low play count still seeds recommendations.
- Autoplay: when selecting similar tracks, prefer candidates that are similar to liked tracks (weight liked seeds 2x vs play-count-only seeds).

---

## 3. Mood Playlists (Generated)

### Pipeline

1. **Clustering**: Load all 749 embedding blobs from tracks table. Run k-means (k=8 initial, adjustable). Pure Rust, no external dependency needed — k-means on 749x768 is trivial.

2. **Naming heuristic**: For each cluster, compute:
   - Dominant genre(s) by frequency (>30% of cluster = primary)
   - Top 3 artists by track count in cluster
   - Energy proxy: average dot-product distance from global centroid (high = niche, low = mainstream)
   - Label format: `"{genre} — {qualifier}"` where qualifier is derived from artist mix or energy level
   - Examples: "Eletrônica — Chill", "Rap BR — Agitado", "MPB & Soul", "Funk — Pesadão"

3. **Persistence**: New tables:
   ```sql
   CREATE TABLE mood_playlists (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     centroid BLOB,          -- 768 floats, for nearest-centroid assignment
     track_count INTEGER DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );

   CREATE TABLE mood_playlist_tracks (
     mood_playlist_id INTEGER REFERENCES mood_playlists(id),
     track_id INTEGER REFERENCES tracks(id),
     distance REAL,           -- distance to centroid, for ordering
     PRIMARY KEY (mood_playlist_id, track_id)
   );
   ```

4. **Incremental update**: When new tracks are indexed and embedded, classify them into the nearest existing cluster (nearest centroid by dot product). Re-cluster periodically if the library grows >20% since last full cluster.

### Backend IPC

- `lib_generate_moods(k: Option<usize>)` — runs full clustering pipeline. Called manually from Settings or automatically on first launch if moods table is empty.
- `lib_list_moods() -> Vec<MoodPlaylist>` — returns mood playlists with metadata.
- `lib_list_mood_tracks(mood_id: i64) -> Vec<Track>` — tracks in a mood, ordered by distance to centroid (most representative first).

### Frontend

- **Playlists view**: Mood playlists appear in a "Moods" section above folder-based playlists. Each shows name + track count. Click opens track list (same layout as folder playlists).
- **Home view**: Optional "Moods" section showing mood cards (name + track count, clickable).

### K-means implementation

Implement in Rust inside library-indexer crate. Algorithm:
1. Initialize centroids via k-means++ (better convergence)
2. Iterate: assign points to nearest centroid, recompute centroids
3. Stop when assignments don't change or max 50 iterations
4. Since vectors are L2-normalized, use dot product (= cosine similarity) for distance

No external crate needed. K-means on 749 points in 768d converges in <100ms.

---

## Out of Scope

- Folder-based playlist management (user manages folders locally)
- LLM-based mood naming (heuristic first, revisit if labels are too generic)
- Playlist CRUD (create/rename/delete custom playlists)
- Cross-device sync

## Implementation Order

1. Search (backend exists, just needs frontend + one new IPC)
2. Like (small schema change + IPC + UI)
3. Moods (most code, but self-contained — clustering + naming + persistence + UI)

Media keys next/prev is already implemented, ships with the next release.
