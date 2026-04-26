# Search, Like & Moods — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend logic and IPC commands for contextual search, like/favorites, and mood playlist generation via k-means clustering on MERT embeddings.

**Architecture:** All three features live in the `library-indexer` crate (`search.rs` for queries, new `moods.rs` for clustering) and are exposed via Tauri IPC commands in `lib.rs`. Schema changes use the existing numbered migration system in `db.rs`. No frontend changes in this plan.

**Tech Stack:** Rust, SQLite (rusqlite), Tauri IPC, k-means (hand-rolled, ~60 lines)

**Spec:** `docs/superpowers/specs/2026-04-26-search-like-moods-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/crates/library-indexer/migrations/004_add_liked_at.sql` | Create | Add `liked_at` column to tracks |
| `src-tauri/crates/library-indexer/migrations/005_mood_playlists.sql` | Create | Create mood_playlists + mood_playlist_tracks tables |
| `src-tauri/crates/library-indexer/src/db.rs` | Modify | Register migrations 004, 005 |
| `src-tauri/crates/library-indexer/src/types.rs` | Modify | Add `liked_at` to Track, add MoodPlaylist struct |
| `src-tauri/crates/library-indexer/src/search.rs` | Modify | Add like queries, playlist search, update recommendations to use likes |
| `src-tauri/crates/library-indexer/src/moods.rs` | Create | K-means clustering + naming heuristic |
| `src-tauri/crates/library-indexer/src/lib.rs` | Modify | Expose new functions on IndexerHandle, re-export types |
| `src-tauri/src/lib.rs` | Modify | Add Tauri IPC commands |

---

## Task 1: Migration — `liked_at` column

**Files:**
- Create: `src-tauri/crates/library-indexer/migrations/004_add_liked_at.sql`
- Modify: `src-tauri/crates/library-indexer/src/db.rs`

- [ ] **Step 1: Create migration file**

```sql
ALTER TABLE tracks ADD COLUMN liked_at INTEGER;
```

- [ ] **Step 2: Register migration in db.rs**

In `db.rs`, add to the `MIGRATIONS` array:

```rust
(4, include_str!("../migrations/004_add_liked_at.sql")),
```

- [ ] **Step 3: Add `liked_at` to Track struct**

In `types.rs`, add after `last_played`:

```rust
pub liked_at: Option<i64>,
```

- [ ] **Step 4: Update `map_track` in search.rs to read `liked_at`**

The `TRACK_SELECT` constant and `map_track` function need the new column. Add `t.liked_at` to the SELECT and read it in `map_track` after `last_played`:

In `TRACK_SELECT`, add `t.liked_at` after `t.last_played`.

In `map_track`, add after the `last_played` line:

```rust
liked_at: row.get(25)?,
```

(Column index shifts by 1 — verify the exact index by counting columns in TRACK_SELECT.)

- [ ] **Step 5: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: compiles clean (warnings ok).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/library-indexer/migrations/004_add_liked_at.sql \
        src-tauri/crates/library-indexer/src/db.rs \
        src-tauri/crates/library-indexer/src/types.rs \
        src-tauri/crates/library-indexer/src/search.rs
git commit -m "feat(indexer): add liked_at column to tracks (migration 004)"
```

---

## Task 2: Like — backend queries + IPC

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/search.rs`
- Modify: `src-tauri/crates/library-indexer/src/lib.rs` (IndexerHandle)
- Modify: `src-tauri/src/lib.rs` (IPC commands)

- [ ] **Step 1: Add like functions to search.rs**

Add after the `list_history` function:

```rust
// ---------------------------------------------------------------------------
// Likes / Favorites
// ---------------------------------------------------------------------------

pub fn toggle_like(conn: &Connection, track_id: i64) -> Result<bool, IndexerError> {
    let currently_liked: bool = conn.query_row(
        "SELECT liked_at IS NOT NULL FROM tracks WHERE id = ?",
        [track_id],
        |row| row.get(0),
    )?;

    if currently_liked {
        conn.execute("UPDATE tracks SET liked_at = NULL WHERE id = ?", [track_id])?;
        Ok(false)
    } else {
        conn.execute(
            "UPDATE tracks SET liked_at = unixepoch() WHERE id = ?",
            [track_id],
        )?;
        Ok(true)
    }
}

pub fn list_liked(conn: &Connection, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let sql = format!(
        "{TRACK_SELECT} WHERE t.liked_at IS NOT NULL ORDER BY t.liked_at DESC LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([limit as i64], map_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn is_liked(conn: &Connection, track_id: i64) -> Result<bool, IndexerError> {
    let liked: bool = conn.query_row(
        "SELECT liked_at IS NOT NULL FROM tracks WHERE id = ?",
        [track_id],
        |row| row.get(0),
    )?;
    Ok(liked)
}
```

- [ ] **Step 2: Expose on IndexerHandle**

In `library-indexer/src/lib.rs`, add to the `impl IndexerHandle` block:

```rust
pub fn toggle_like(&self, track_id: i64) -> Result<bool, IndexerError> {
    self.inner.write_pool.with(|conn| search::toggle_like(conn, track_id))
}

pub fn list_liked(&self, limit: usize) -> Result<Vec<Track>, IndexerError> {
    self.inner.pool.with(|conn| search::list_liked(conn, limit))
}

pub fn is_liked(&self, track_id: i64) -> Result<bool, IndexerError> {
    self.inner.pool.with(|conn| search::is_liked(conn, track_id))
}
```

- [ ] **Step 3: Add Tauri IPC commands**

In `src-tauri/src/lib.rs`, add the command functions:

```rust
#[tauri::command]
fn lib_toggle_like(lib: State<Library>, track_id: i64) -> Result<bool, String> {
    lib.handle.toggle_like(track_id).map_err(err)
}

#[tauri::command]
fn lib_list_liked(lib: State<Library>, limit: Option<usize>) -> Result<Vec<Track>, String> {
    let mut tracks = lib.handle.list_liked(limit.unwrap_or(200)).map_err(err)?;
    for t in &mut tracks {
        if let Some(rel) = &t.album_cover_path {
            t.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn lib_is_liked(lib: State<Library>, track_id: i64) -> Result<bool, String> {
    lib.handle.is_liked(track_id).map_err(err)
}
```

Register in `generate_handler!`:

```rust
lib_toggle_like,
lib_list_liked,
lib_is_liked,
```

- [ ] **Step 4: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/library-indexer/src/search.rs \
        src-tauri/crates/library-indexer/src/lib.rs \
        src-tauri/src/lib.rs
git commit -m "feat(indexer): add like/favorites backend (toggle, list, is_liked)"
```

---

## Task 3: Update recommendations to use liked tracks as seeds

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/search.rs`

- [ ] **Step 1: Modify `recommendations()` to include liked seeds**

Replace the current seed logic. The new approach: seed pool = union of top 5 most-played + all liked tracks (deduplicated). Liked seeds get used first (they represent explicit preference, stronger signal than passive play count).

```rust
pub fn recommendations(conn: &Connection) -> Result<Recommendations, IndexerError> {
    // Most played (top 10)
    let most_played_sql = format!(
        "{TRACK_SELECT} WHERE t.play_count > 0 ORDER BY t.play_count DESC LIMIT 10"
    );
    let most_played: Vec<Track> = conn
        .prepare(&most_played_sql)?
        .query_map([], map_track)?
        .collect::<Result<Vec<_>, _>>()?;

    // Build seed pool: liked tracks first, then top played (deduplicated)
    let liked_sql = format!(
        "SELECT id FROM tracks WHERE liked_at IS NOT NULL ORDER BY liked_at DESC LIMIT 10"
    );
    let liked_ids: Vec<i64> = conn
        .prepare(&liked_sql)?
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut seed_set: std::collections::HashSet<i64> = liked_ids.iter().copied().collect();
    let mut seed_ids: Vec<i64> = liked_ids;
    for t in most_played.iter().take(5) {
        if seed_set.insert(t.id) {
            seed_ids.push(t.id);
        }
    }
    seed_ids.truncate(10);

    // Based on top: use seeds, get similar, deduplicate
    let mut based_on_ids: std::collections::HashSet<i64> =
        seed_ids.iter().copied().collect();
    let mut based_on_top: Vec<Track> = Vec::new();

    for &seed_id in &seed_ids {
        if let Ok(sim) = similar(conn, seed_id, 5) {
            for (track, _score) in sim {
                if based_on_ids.insert(track.id) {
                    based_on_top.push(track);
                }
            }
        }
        if based_on_top.len() >= 10 {
            break;
        }
    }
    based_on_top.truncate(10);

    // Discover: unplayed tracks similar to seeds
    let mut discover: Vec<Track> = Vec::new();
    let mut discover_ids: std::collections::HashSet<i64> =
        seed_ids.iter().copied().collect();
    for &seed_id in &seed_ids {
        if let Ok(sim) = similar(conn, seed_id, 10) {
            for (track, _score) in sim {
                if track.play_count == 0 && discover_ids.insert(track.id) {
                    discover.push(track);
                }
            }
        }
        if discover.len() >= 10 {
            break;
        }
    }
    discover.truncate(10);

    Ok(Recommendations {
        most_played,
        based_on_top,
        discover,
    })
}
```

- [ ] **Step 2: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/library-indexer/src/search.rs
git commit -m "feat(indexer): recommendations now use liked tracks as seeds"
```

---

## Task 4: Playlist search IPC

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/search.rs`
- Modify: `src-tauri/crates/library-indexer/src/lib.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `PlaylistSearchResult` struct and `search_playlists` function**

In `search.rs`, add after the `list_folder_tracks` function:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistSearchResult {
    pub folder: String,
    pub tracks: Vec<Track>,
}

pub fn search_playlists(
    conn: &Connection,
    music_root: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<PlaylistSearchResult>, IndexerError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let fts_query = build_fts_query(q);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let prefix = if music_root.ends_with('/') {
        music_root.to_string()
    } else {
        format!("{}/", music_root)
    };
    let prefix_len = prefix.len();

    // Find matching track IDs via FTS
    let mut stmt = conn.prepare(
        "SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ? ORDER BY rank LIMIT ?",
    )?;
    let track_ids: Vec<i64> = stmt
        .query_map(params![fts_query, limit as i64], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    if track_ids.is_empty() {
        return Ok(Vec::new());
    }

    let tracks = fetch_tracks_by_ids(conn, &track_ids)?;

    // Group by folder
    let mut folder_map: std::collections::BTreeMap<String, Vec<Track>> =
        std::collections::BTreeMap::new();
    for track in tracks {
        let path_str = track.path.to_string_lossy();
        let folder = if path_str.starts_with(&prefix) {
            let rest = &path_str[prefix_len..];
            match rest.find('/') {
                Some(idx) => rest[..idx].to_string(),
                None => String::new(),
            }
        } else {
            String::new()
        };
        folder_map.entry(folder).or_default().push(track);
    }

    let results: Vec<PlaylistSearchResult> = folder_map
        .into_iter()
        .map(|(folder, tracks)| PlaylistSearchResult { folder, tracks })
        .collect();

    Ok(results)
}
```

- [ ] **Step 2: Expose on IndexerHandle**

In `library-indexer/src/lib.rs`:

```rust
pub fn search_playlists(
    &self,
    music_root: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<search::PlaylistSearchResult>, IndexerError> {
    self.inner
        .pool
        .with(|conn| search::search_playlists(conn, music_root, query, limit))
}
```

Add to re-exports at the top of `lib.rs`:

```rust
pub use search::{FolderPlaylist, PlaylistSearchResult, Recommendations};
```

- [ ] **Step 3: Add Tauri IPC command**

In `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn lib_search_playlists(
    lib: State<Library>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<PlaylistSearchResult>, String> {
    let mut results = lib
        .handle
        .search_playlists(
            lib.music_root.to_str().unwrap_or(""),
            &query,
            limit.unwrap_or(50),
        )
        .map_err(err)?;

    for result in &mut results {
        for t in &mut result.tracks {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
        }
    }

    Ok(results)
}
```

Add `PlaylistSearchResult` to the imports from `library_indexer` at the top.

Register `lib_search_playlists` in `generate_handler!`.

- [ ] **Step 4: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/library-indexer/src/search.rs \
        src-tauri/crates/library-indexer/src/lib.rs \
        src-tauri/src/lib.rs
git commit -m "feat(indexer): add playlist search IPC (FTS + folder grouping)"
```

---

## Task 5: Migration — mood playlists tables

**Files:**
- Create: `src-tauri/crates/library-indexer/migrations/005_mood_playlists.sql`
- Modify: `src-tauri/crates/library-indexer/src/db.rs`

- [ ] **Step 1: Create migration file**

```sql
CREATE TABLE IF NOT EXISTS mood_playlists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    centroid BLOB,
    track_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mood_playlist_tracks (
    mood_playlist_id INTEGER REFERENCES mood_playlists(id) ON DELETE CASCADE,
    track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    distance REAL,
    PRIMARY KEY (mood_playlist_id, track_id)
);
```

- [ ] **Step 2: Register in db.rs**

```rust
(5, include_str!("../migrations/005_mood_playlists.sql")),
```

- [ ] **Step 3: Add MoodPlaylist type to types.rs**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoodPlaylist {
    pub id: i64,
    pub name: String,
    pub track_count: u32,
    pub created_at: i64,
    pub updated_at: i64,
}
```

- [ ] **Step 4: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/library-indexer/migrations/005_mood_playlists.sql \
        src-tauri/crates/library-indexer/src/db.rs \
        src-tauri/crates/library-indexer/src/types.rs
git commit -m "feat(indexer): add mood_playlists schema (migration 005)"
```

---

## Task 6: K-means clustering module

**Files:**
- Create: `src-tauri/crates/library-indexer/src/moods.rs`

This is the core algorithm. Pure Rust, no dependencies. Operates on the embedding blobs already in the tracks table.

- [ ] **Step 1: Create moods.rs with k-means implementation**

```rust
//! Mood playlist generation via k-means clustering on MERT embeddings.

use crate::error::IndexerError;
use crate::search::{bytes_to_f32, TRACK_SELECT, map_track};
use crate::types::{MoodPlaylist, Track};
use rusqlite::{params, Connection};
use rusqlite::params_from_iter;

/// Run k-means clustering on all embedded tracks and persist mood playlists.
pub fn generate_moods(conn: &Connection, k: usize) -> Result<Vec<MoodPlaylist>, IndexerError> {
    // 1. Load all embeddings
    let mut stmt = conn.prepare(
        "SELECT id, embedding FROM tracks WHERE embedding_status = 'done' AND embedding IS NOT NULL",
    )?;
    let rows: Vec<(i64, Vec<f32>)> = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((id, bytes_to_f32(&blob)))
        })?
        .filter_map(|r| r.ok())
        .filter(|(_, v)| !v.is_empty())
        .collect();

    if rows.len() < k {
        return Ok(Vec::new());
    }

    let dim = rows[0].1.len();
    let n = rows.len();

    // 2. K-means++ initialization
    let mut centroids = kmeans_pp_init(&rows, k, dim);

    // 3. Iterate
    let mut assignments = vec![0usize; n];
    for _ in 0..50 {
        let mut changed = false;
        for (i, (_, vec)) in rows.iter().enumerate() {
            let nearest = nearest_centroid(vec, &centroids);
            if assignments[i] != nearest {
                assignments[i] = nearest;
                changed = true;
            }
        }
        if !changed {
            break;
        }
        recompute_centroids(&rows, &assignments, &mut centroids, k, dim);
    }

    // 4. Name clusters
    let names = name_clusters(conn, &rows, &assignments, k)?;

    // 5. Persist
    conn.execute("DELETE FROM mood_playlist_tracks", [])?;
    conn.execute("DELETE FROM mood_playlists", [])?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let mut result = Vec::with_capacity(k);

    for cluster_idx in 0..k {
        let cluster_track_ids: Vec<(i64, f32)> = rows
            .iter()
            .zip(assignments.iter())
            .filter(|(_, &a)| a == cluster_idx)
            .map(|((id, vec), _)| (*id, 1.0 - dot(vec, &centroids[cluster_idx])))
            .collect();

        if cluster_track_ids.is_empty() {
            continue;
        }

        let centroid_blob = f32_to_bytes(&centroids[cluster_idx]);

        conn.execute(
            "INSERT INTO mood_playlists (name, centroid, track_count, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?)",
            params![
                names[cluster_idx],
                centroid_blob,
                cluster_track_ids.len() as i64,
                now,
                now,
            ],
        )?;
        let mood_id = conn.last_insert_rowid();

        for (track_id, distance) in &cluster_track_ids {
            conn.execute(
                "INSERT INTO mood_playlist_tracks (mood_playlist_id, track_id, distance) \
                 VALUES (?, ?, ?)",
                params![mood_id, track_id, distance],
            )?;
        }

        result.push(MoodPlaylist {
            id: mood_id,
            name: names[cluster_idx].clone(),
            track_count: cluster_track_ids.len() as u32,
            created_at: now,
            updated_at: now,
        });
    }

    Ok(result)
}

/// Assign a single track to the nearest existing mood playlist.
pub fn classify_track(conn: &Connection, track_id: i64) -> Result<(), IndexerError> {
    let blob: Option<Vec<u8>> = conn
        .query_row(
            "SELECT embedding FROM tracks WHERE id = ? AND embedding_status = 'done'",
            [track_id],
            |row| row.get(0),
        )
        .ok();

    let Some(bytes) = blob else { return Ok(()) };
    let vec = bytes_to_f32(&bytes);
    if vec.is_empty() {
        return Ok(());
    }

    let mut stmt = conn.prepare("SELECT id, centroid FROM mood_playlists WHERE centroid IS NOT NULL")?;
    let moods: Vec<(i64, Vec<f32>)> = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((id, bytes_to_f32(&blob)))
        })?
        .filter_map(|r| r.ok())
        .collect();

    if moods.is_empty() {
        return Ok(());
    }

    let (best_id, best_dist) = moods
        .iter()
        .map(|(id, c)| (*id, 1.0 - dot(&vec, c)))
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap();

    conn.execute(
        "INSERT OR REPLACE INTO mood_playlist_tracks (mood_playlist_id, track_id, distance) \
         VALUES (?, ?, ?)",
        params![best_id, track_id, best_dist],
    )?;

    conn.execute(
        "UPDATE mood_playlists SET track_count = \
         (SELECT COUNT(*) FROM mood_playlist_tracks WHERE mood_playlist_id = ?), \
         updated_at = unixepoch() WHERE id = ?",
        params![best_id, best_id],
    )?;

    Ok(())
}

/// List all mood playlists.
pub fn list_moods(conn: &Connection) -> Result<Vec<MoodPlaylist>, IndexerError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, track_count, created_at, updated_at \
         FROM mood_playlists ORDER BY name",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MoodPlaylist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get::<_, i64>(2)? as u32,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// List tracks in a mood playlist, ordered by distance to centroid.
pub fn list_mood_tracks(conn: &Connection, mood_id: i64) -> Result<Vec<Track>, IndexerError> {
    let sql = format!(
        "{TRACK_SELECT} \
         JOIN mood_playlist_tracks mpt ON mpt.track_id = t.id \
         WHERE mpt.mood_playlist_id = ? \
         ORDER BY mpt.distance ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([mood_id], map_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// K-means internals
// ---------------------------------------------------------------------------

fn kmeans_pp_init(data: &[(i64, Vec<f32>)], k: usize, dim: usize) -> Vec<Vec<f32>> {
    let mut centroids: Vec<Vec<f32>> = Vec::with_capacity(k);
    let mut rng = simple_rng(42);

    // First centroid: random point
    let idx = (rng() as usize) % data.len();
    centroids.push(data[idx].1.clone());

    // Remaining: weighted by distance squared
    for _ in 1..k {
        let mut dists: Vec<f64> = data
            .iter()
            .map(|(_, v)| {
                centroids
                    .iter()
                    .map(|c| {
                        let d = 1.0 - dot(v, c) as f64;
                        d * d
                    })
                    .fold(f64::MAX, f64::min)
            })
            .collect();

        let total: f64 = dists.iter().sum();
        if total <= 0.0 {
            break;
        }
        for d in &mut dists {
            *d /= total;
        }

        let r = (rng() as f64) / (u64::MAX as f64);
        let mut cumulative = 0.0;
        let mut chosen = data.len() - 1;
        for (i, &d) in dists.iter().enumerate() {
            cumulative += d;
            if cumulative >= r {
                chosen = i;
                break;
            }
        }
        centroids.push(data[chosen].1.clone());
    }

    centroids
}

fn nearest_centroid(vec: &[f32], centroids: &[Vec<f32>]) -> usize {
    centroids
        .iter()
        .enumerate()
        .map(|(i, c)| (i, dot(vec, c)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

fn recompute_centroids(
    data: &[(i64, Vec<f32>)],
    assignments: &[usize],
    centroids: &mut [Vec<f32>],
    k: usize,
    dim: usize,
) {
    let mut sums = vec![vec![0.0f64; dim]; k];
    let mut counts = vec![0usize; k];

    for (i, (_, vec)) in data.iter().enumerate() {
        let c = assignments[i];
        counts[c] += 1;
        for (j, &v) in vec.iter().enumerate() {
            sums[c][j] += v as f64;
        }
    }

    for c in 0..k {
        if counts[c] == 0 {
            continue;
        }
        let norm: f64 = sums[c].iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm > 0.0 {
            for j in 0..dim {
                centroids[c][j] = (sums[c][j] / norm) as f32;
            }
        }
    }
}

fn name_clusters(
    conn: &Connection,
    data: &[(i64, Vec<f32>)],
    assignments: &[usize],
    k: usize,
) -> Result<Vec<String>, IndexerError> {
    let mut names = Vec::with_capacity(k);

    for cluster_idx in 0..k {
        let track_ids: Vec<i64> = data
            .iter()
            .zip(assignments.iter())
            .filter(|(_, &a)| a == cluster_idx)
            .map(|((id, _), _)| *id)
            .collect();

        if track_ids.is_empty() {
            names.push(format!("Mix {}", cluster_idx + 1));
            continue;
        }

        // Get genre distribution for this cluster
        let placeholders: String = track_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT g.name, COUNT(*) as cnt \
             FROM tracks t JOIN genres g ON t.genre_id = g.id \
             WHERE t.id IN ({placeholders}) \
             GROUP BY g.name ORDER BY cnt DESC LIMIT 3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let genres: Vec<(String, i64)> = stmt
            .query_map(
                rusqlite::params_from_iter(track_ids.iter()),
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?
            .filter_map(|r| r.ok())
            .collect();

        // Get top artists
        let sql2 = format!(
            "SELECT ar.name, COUNT(*) as cnt \
             FROM tracks t JOIN artists ar ON t.artist_id = ar.id \
             WHERE t.id IN ({placeholders}) \
             GROUP BY ar.name ORDER BY cnt DESC LIMIT 3"
        );
        let mut stmt2 = conn.prepare(&sql2)?;
        let artists: Vec<(String, i64)> = stmt2
            .query_map(
                rusqlite::params_from_iter(track_ids.iter()),
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?
            .filter_map(|r| r.ok())
            .collect();

        let total = track_ids.len() as f64;
        let name = if let Some((genre, count)) = genres.first() {
            let ratio = *count as f64 / total;
            if ratio > 0.6 {
                // Dominant genre — qualify with second genre or top artist
                if genres.len() > 1 && genres[1].1 as f64 / total > 0.15 {
                    format!("{} & {}", genre, genres[1].0)
                } else if let Some((artist, _)) = artists.first() {
                    format!("{} — {}", genre, artist)
                } else {
                    genre.clone()
                }
            } else if genres.len() >= 2 {
                format!("{} / {}", genre, genres[1].0)
            } else {
                genre.clone()
            }
        } else {
            format!("Mix {}", cluster_idx + 1)
        };

        names.push(name);
    }

    Ok(names)
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn f32_to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn simple_rng(seed: u64) -> impl FnMut() -> u64 {
    let mut state = seed;
    move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    }
}
```

Note: `bytes_to_f32` and `map_track` need to be `pub(crate)` in search.rs. Also `TRACK_SELECT` needs to be `pub(crate)`.

- [ ] **Step 2: Make required items pub(crate) in search.rs**

Change visibility of `bytes_to_f32`, `map_track`, and `TRACK_SELECT` from private to `pub(crate)`.

- [ ] **Step 3: Register module in library-indexer/src/lib.rs**

Add `mod moods;` in the module declarations. Add re-export:

```rust
pub use moods::{generate_moods, classify_track};
```

- [ ] **Step 4: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/library-indexer/src/moods.rs \
        src-tauri/crates/library-indexer/src/search.rs \
        src-tauri/crates/library-indexer/src/lib.rs
git commit -m "feat(indexer): k-means mood clustering with heuristic naming"
```

---

## Task 7: Moods IPC commands

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/lib.rs` (IndexerHandle)
- Modify: `src-tauri/src/lib.rs` (Tauri commands)

- [ ] **Step 1: Expose on IndexerHandle**

```rust
pub fn generate_moods(&self, k: usize) -> Result<Vec<MoodPlaylist>, IndexerError> {
    self.inner.write_pool.with(|conn| moods::generate_moods(conn, k))
}

pub fn list_moods(&self) -> Result<Vec<MoodPlaylist>, IndexerError> {
    self.inner.pool.with(|conn| moods::list_moods(conn))
}

pub fn list_mood_tracks(&self, mood_id: i64) -> Result<Vec<Track>, IndexerError> {
    self.inner.pool.with(|conn| moods::list_mood_tracks(conn, mood_id))
}

pub fn classify_track(&self, track_id: i64) -> Result<(), IndexerError> {
    self.inner.write_pool.with(|conn| moods::classify_track(conn, track_id))
}
```

Add `MoodPlaylist` to the re-exports in `lib.rs`.

- [ ] **Step 2: Add Tauri IPC commands**

```rust
#[tauri::command]
fn lib_generate_moods(lib: State<Library>, k: Option<usize>) -> Result<Vec<MoodPlaylist>, String> {
    lib.handle.generate_moods(k.unwrap_or(8)).map_err(err)
}

#[tauri::command]
fn lib_list_moods(lib: State<Library>) -> Result<Vec<MoodPlaylist>, String> {
    lib.handle.list_moods().map_err(err)
}

#[tauri::command]
fn lib_list_mood_tracks(lib: State<Library>, mood_id: i64) -> Result<Vec<Track>, String> {
    let mut tracks = lib.handle.list_mood_tracks(mood_id).map_err(err)?;
    for t in &mut tracks {
        if let Some(rel) = &t.album_cover_path {
            t.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(tracks)
}
```

Add `MoodPlaylist` to imports from `library_indexer`.

Register all three in `generate_handler!`:

```rust
lib_generate_moods,
lib_list_moods,
lib_list_mood_tracks,
```

- [ ] **Step 3: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/library-indexer/src/lib.rs \
        src-tauri/src/lib.rs
git commit -m "feat(indexer): expose mood playlist IPC commands"
```

---

## Task 8: Smoke test — generate moods on real data

This validates the full pipeline works end-to-end on the cmr-auto library.

- [ ] **Step 1: Build release**

```bash
./scripts/release.sh
```

- [ ] **Step 2: Install on cmr-auto and test**

```bash
ssh cmr-auto@100.102.249.9 "gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb"
```

Ask user to launch app, open dev console (or use MCP bridge), and run:

```javascript
await window.__TAURI__.core.invoke("lib_generate_moods", { k: 8 });
await window.__TAURI__.core.invoke("lib_list_moods");
```

Verify: returns array of 8 mood playlists with names derived from genre/artist metadata.

- [ ] **Step 3: Commit any fixes if needed**

---

## Summary

| Task | Feature | Scope |
|------|---------|-------|
| 1 | Like | Migration: `liked_at` column |
| 2 | Like | Backend queries + IPC (toggle, list, is_liked) |
| 3 | Like | Update recommendations to use liked seeds |
| 4 | Search | Playlist search IPC |
| 5 | Moods | Migration: mood tables |
| 6 | Moods | K-means clustering + naming module |
| 7 | Moods | IPC commands (generate, list, list_tracks) |
| 8 | All | Smoke test on real data |
