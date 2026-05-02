# SQLite → Qdrant Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate SQLite entirely, making Qdrant the sole data store for library metadata, play events, likes, history, and recommendations.

**Architecture:** All track metadata moves to Qdrant payloads on the existing `rustify_tracks` collection. The scan pipeline upserts directly to Qdrant. Query functions use Qdrant scroll/filter/recommend instead of SQL. `play_events` collection stays unchanged.

**Tech Stack:** Rust, Qdrant REST API (via ureq), serde_json, Tauri 2.x

**Spec:** `docs/superpowers/specs/2026-05-02-sqlite-to-qdrant-migration-design.md`

---

## File Structure

### Created
- `src-tauri/crates/library-indexer/src/query.rs` — All read queries backed by Qdrant (replaces search.rs)
- `src-tauri/crates/library-indexer/src/store.rs` — Qdrant connection state + shared helpers (replaces db.rs)

### Modified
- `src-tauri/crates/library-indexer/src/qdrant_client.rs` — Expanded: payload indices, set_payload, scroll_with_filter, text search, aggregation
- `src-tauri/crates/library-indexer/src/pipeline.rs` — Scan writes to Qdrant, not SQLite
- `src-tauri/crates/library-indexer/src/lib.rs` — IndexerHandle uses QdrantClient, new config
- `src-tauri/crates/library-indexer/src/types.rs` — Track/Album/Artist/Genre without integer IDs, filters use strings
- `src-tauri/crates/library-indexer/src/error.rs` — Remove rusqlite variant
- `src-tauri/crates/library-indexer/Cargo.toml` — Remove rusqlite dependency
- `src-tauri/Cargo.toml` — Remove rusqlite from workspace
- `src-tauri/src/lib.rs` — Tauri commands use new API (string filters, u64 IDs)

### Deleted
- `src-tauri/crates/library-indexer/src/db.rs`
- `src-tauri/crates/library-indexer/src/search.rs`
- `src-tauri/crates/library-indexer/src/play_events.rs`
- `src-tauri/crates/library-indexer/migrations/` (entire directory)
- `src-tauri/crates/library-indexer/seeds/genres.json`

---

## Task 1: Expand QdrantClient with Payload Management

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/qdrant_client.rs`

This task adds the low-level Qdrant operations needed by all other tasks: payload indices creation, set_payload for partial updates, scroll with filters and ordering, text search, and point deletion.

- [ ] **Step 1: Add payload index creation to ensure_collection**

Add method to create all payload indices needed for the full-metadata collection. Call it from `ensure_collection` after creating the collection.

```rust
/// Create payload indices for full-metadata storage.
/// Idempotent — Qdrant ignores duplicate index creation.
fn create_payload_indices(&self) -> Result<(), IndexerError> {
    let indices: Vec<(&str, Value)> = vec![
        ("path", json!({"type": "keyword"})),
        ("title", json!({"type": "text", "tokenizer": "word", "lowercase": true})),
        ("artist", json!({"type": "text", "tokenizer": "word", "lowercase": true})),
        ("artist_exact", json!({"type": "keyword"})),
        ("album_title", json!({"type": "text", "tokenizer": "word", "lowercase": true})),
        ("album_title_exact", json!({"type": "keyword"})),
        ("genre", json!({"type": "keyword"})),
        ("tags", json!({"type": "keyword"})),
        ("play_count", json!({"type": "integer"})),
        ("last_played", json!({"type": "integer"})),
        ("liked_at", json!({"type": "integer"})),
        ("embedding_status", json!({"type": "keyword"})),
        ("track_number", json!({"type": "integer"})),
        ("disc_number", json!({"type": "integer"})),
        ("mtime", json!({"type": "integer"})),
        ("indexed_at", json!({"type": "integer"})),
    ];

    for (field, schema) in &indices {
        let url = format!("{}/collections/{COLLECTION}/index", self.base_url);
        let body = json!({
            "field_name": field,
            "field_schema": schema
        });
        // 409 = index already exists, ignore
        match self.agent.put(&url).send_json(&body) {
            Ok(_) => {}
            Err(ureq::Error::Status(409, _)) => {}
            Err(e) => {
                return Err(IndexerError::Embedding(format!(
                    "qdrant create index {field}: {e}"
                )));
            }
        }
    }
    Ok(())
}
```

Update `ensure_collection` to call `self.create_payload_indices()?;` after collection creation.

- [ ] **Step 2: Add set_payload method**

```rust
/// Partial update of payload fields on one or more points.
/// Does NOT overwrite fields not mentioned in `payload`.
pub fn set_payload(&self, point_ids: &[u64], payload: Value) -> Result<(), IndexerError> {
    if point_ids.is_empty() {
        return Ok(());
    }
    let body = json!({
        "payload": payload,
        "points": point_ids
    });
    self.agent
        .post(&format!("{}/collections/{COLLECTION}/points/payload", self.base_url))
        .send_json(&body)
        .map_err(|e| IndexerError::Embedding(format!("qdrant set_payload: {e}")))?;
    Ok(())
}
```

- [ ] **Step 3: Add scroll_with_filter method**

```rust
/// Scroll points with optional filter, ordering, and field selection.
/// Returns (point_id, payload) pairs.
pub fn scroll_with_filter(
    &self,
    filter: Option<Value>,
    order_by: Option<&str>,
    limit: usize,
    with_vector: bool,
) -> Result<Vec<(u64, Value)>, IndexerError> {
    let mut body = json!({
        "limit": limit,
        "with_payload": true,
        "with_vector": with_vector
    });
    if let Some(f) = filter {
        body["filter"] = f;
    }
    if let Some(key) = order_by {
        body["order_by"] = json!({ "key": key, "direction": "desc" });
    }

    let resp: Value = self
        .agent
        .post(&format!("{}/collections/{COLLECTION}/points/scroll", self.base_url))
        .send_json(&body)
        .map_err(|e| IndexerError::Embedding(format!("qdrant scroll: {e}")))?
        .into_json()
        .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

    let mut results = Vec::new();
    if let Some(points) = resp["result"]["points"].as_array() {
        for p in points {
            let id = p["id"].as_u64().unwrap_or(0);
            let payload = p.get("payload").cloned().unwrap_or(Value::Null);
            results.push((id, payload));
        }
    }
    Ok(results)
}
```

- [ ] **Step 4: Add scroll_all_payloads for aggregation**

```rust
/// Scroll ALL points returning only selected payload fields.
/// Used for client-side aggregation (list albums, artists, genres).
pub fn scroll_all_payloads(&self, fields: &[&str]) -> Result<Vec<(u64, Value)>, IndexerError> {
    let mut all: Vec<(u64, Value)> = Vec::new();
    let mut offset: Option<Value> = None;

    let include = json!({ "include": fields });

    loop {
        let mut body = json!({
            "limit": 1000,
            "with_payload": include,
            "with_vector": false
        });
        if let Some(ref off) = offset {
            body["offset"] = off.clone();
        }

        let resp: Value = self
            .agent
            .post(&format!("{}/collections/{COLLECTION}/points/scroll", self.base_url))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant scroll_all: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        if let Some(points) = resp["result"]["points"].as_array() {
            for p in points {
                let id = p["id"].as_u64().unwrap_or(0);
                let payload = p.get("payload").cloned().unwrap_or(Value::Null);
                all.push((id, payload));
            }
        }

        match resp["result"].get("next_page_offset") {
            Some(Value::Null) | None => break,
            Some(v) => offset = Some(v.clone()),
        }
    }

    Ok(all)
}
```

- [ ] **Step 5: Add get_point and delete_points methods**

```rust
/// Get a single point by ID with full payload.
pub fn get_point(&self, id: u64) -> Result<Option<Value>, IndexerError> {
    let url = format!("{}/collections/{COLLECTION}/points/{id}", self.base_url);
    match self.agent.get(&url).call() {
        Ok(resp) => {
            let body: Value = resp.into_json()
                .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;
            Ok(Some(body["result"].clone()))
        }
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(e) => Err(IndexerError::Embedding(format!("qdrant get_point: {e}"))),
    }
}

/// Delete points by ID.
pub fn delete_points(&self, ids: &[u64]) -> Result<(), IndexerError> {
    if ids.is_empty() {
        return Ok(());
    }
    let body = json!({ "points": ids });
    self.agent
        .post(&format!("{}/collections/{COLLECTION}/points/delete", self.base_url))
        .send_json(&body)
        .map_err(|e| IndexerError::Embedding(format!("qdrant delete: {e}")))?;
    Ok(())
}
```

- [ ] **Step 6: Add upsert_track_batch for full metadata points**

This replaces the old `upsert_batch` which only handled MERT vectors.
New version accepts full metadata payload and optional vectors.

```rust
/// Upsert tracks with full metadata payload and optional MERT vector.
/// Point ID = u64 hash of path.
pub fn upsert_tracks(&self, points: &[(u64, Value, Option<Vec<f32>>)]) -> Result<(), IndexerError> {
    if points.is_empty() {
        return Ok(());
    }
    for chunk in points.chunks(100) {
        let pts: Vec<Value> = chunk.iter().map(|(id, payload, vector)| {
            let mert_vec = vector.as_deref()
                .unwrap_or(&vec![0.0_f32; MERT_DIM]);
            json!({
                "id": id,
                "vector": { VEC_MERT: mert_vec },
                "payload": payload
            })
        }).collect();

        let body = json!({ "points": pts });
        self.agent
            .put(&format!("{}/collections/{COLLECTION}/points", self.base_url))
            .query("wait", "true")
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant upsert_tracks: {e}")))?;
    }
    Ok(())
}
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/library-indexer/src/qdrant_client.rs
git commit -m "feat(library-indexer): expand QdrantClient with payload management, scroll, set_payload, text indices"
```

---

## Task 2: Update Types for Qdrant-only Model

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/types.rs`

- [ ] **Step 1: Update Track struct — remove integer foreign keys, change id to u64**

```rust
pub struct Track {
    pub id: u64,                    // was i64, now u64 hash of path
    pub path: PathBuf,
    pub filename: String,
    pub title: String,
    pub track_number: Option<i32>,
    pub disc_number: i32,
    pub duration_ms: i64,
    pub album_title: Option<String>,      // was album_id + album_title
    pub album_year: Option<i32>,
    pub album_cover_path: Option<PathBuf>,
    pub artist_name: Option<String>,      // was artist_id + artist_name
    pub genre_name: Option<String>,       // was genre_id + genre_name
    pub tags: Vec<String>,
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub channels: u16,
    pub rg_track_gain: Option<f32>,
    pub rg_album_gain: Option<f32>,
    pub rg_track_peak: Option<f32>,
    pub rg_album_peak: Option<f32>,
    pub embedding_status: EmbeddingStatus,
    pub play_count: u32,
    pub last_played: Option<i64>,
    pub liked_at: Option<i64>,
    pub lrc_path: Option<PathBuf>,
}
```

- [ ] **Step 2: Update Album, Artist, Genre — remove integer IDs**

```rust
pub struct Genre {
    pub name: String,
    pub track_count: u32,
}

pub struct Artist {
    pub name: String,
    pub sort_name: Option<String>,
    pub track_count: u32,
    pub album_count: u32,
}

pub struct Album {
    pub title: String,
    pub artist_name: Option<String>,
    pub year: Option<i32>,
    pub cover_path: Option<PathBuf>,
    pub track_count: u32,
}
```

- [ ] **Step 3: Update filter types — string-based instead of ID-based**

```rust
pub struct TrackFilter {
    pub genre: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub tags: Vec<String>,
    pub limit: Option<usize>,
    pub order: TrackOrder,
}

pub struct AlbumFilter {
    pub genre: Option<String>,
    pub artist: Option<String>,
    pub limit: Option<usize>,
}

pub struct ArtistFilter {
    pub genre: Option<String>,
    pub limit: Option<usize>,
}
```

- [ ] **Step 4: Update IndexerConfig — qdrant_url instead of db_path**

Add to types.rs or update in lib.rs:

```rust
pub struct IndexerConfig {
    pub qdrant_url: String,
    pub music_root: PathBuf,
    pub cache_dir: PathBuf,
    pub embed_client: Option<EmbedClient>,
}
```

- [ ] **Step 5: Add path_to_id helper**

```rust
/// Deterministic point ID from filesystem path.
pub fn path_to_id(path: &std::path::Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/library-indexer/src/types.rs
git commit -m "refactor(types): remove integer foreign keys, use string identifiers for Qdrant-only model"
```

---

## Task 3: Create query.rs — All Read Queries via Qdrant

**Files:**
- Create: `src-tauri/crates/library-indexer/src/query.rs`

This module replaces `search.rs`. Every function takes `&QdrantClient` instead of `&Connection`.

- [ ] **Step 1: Create query.rs with Track parsing from Qdrant payload**

```rust
//! Read-side queries backed by Qdrant.

use crate::error::IndexerError;
use crate::qdrant_client::QdrantClient;
use crate::types::{
    Album, AlbumFilter, Artist, ArtistFilter, Genre, MoodPlaylist,
    SearchResults, Track, TrackFilter, TrackOrder,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

fn payload_to_track(id: u64, p: &Value) -> Track {
    let cover_str = p["cover_path"].as_str().map(PathBuf::from);
    let lrc_str = p["lrc_path"].as_str().map(PathBuf::from);
    let tags = p["tags"].as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let status = p["embedding_status"].as_str().unwrap_or("pending");

    Track {
        id,
        path: PathBuf::from(p["path"].as_str().unwrap_or("")),
        filename: p["filename"].as_str().unwrap_or("").to_string(),
        title: p["title"].as_str().unwrap_or("").to_string(),
        track_number: p["track_number"].as_i64().map(|v| v as i32),
        disc_number: p["disc_number"].as_i64().unwrap_or(1) as i32,
        duration_ms: p["duration_ms"].as_i64().unwrap_or(0),
        album_title: p["album_title"].as_str().map(String::from),
        album_year: p["album_year"].as_i64().map(|v| v as i32),
        album_cover_path: cover_str,
        artist_name: p["artist"].as_str().map(String::from),
        genre_name: p["genre"].as_str().map(String::from),
        tags,
        sample_rate: p["sample_rate"].as_u64().unwrap_or(44100) as u32,
        bit_depth: p["bit_depth"].as_u64().unwrap_or(16) as u16,
        channels: p["channels"].as_u64().unwrap_or(2) as u16,
        rg_track_gain: p["rg_track_gain"].as_f64().map(|v| v as f32),
        rg_album_gain: p["rg_album_gain"].as_f64().map(|v| v as f32),
        rg_track_peak: p["rg_track_peak"].as_f64().map(|v| v as f32),
        rg_album_peak: p["rg_album_peak"].as_f64().map(|v| v as f32),
        embedding_status: crate::types::EmbeddingStatus::parse(status)
            .unwrap_or(crate::types::EmbeddingStatus::Pending),
        play_count: p["play_count"].as_u64().unwrap_or(0) as u32,
        last_played: p["last_played"].as_i64(),
        liked_at: p["liked_at"].as_i64(),
        lrc_path: lrc_str,
    }
}
```

- [ ] **Step 2: Add get_track, get_track_by_path**

```rust
pub fn get_track(client: &QdrantClient, id: u64) -> Result<Option<Track>, IndexerError> {
    match client.get_point(id)? {
        Some(point) => {
            let payload = &point["payload"];
            Ok(Some(payload_to_track(id, payload)))
        }
        None => Ok(None),
    }
}

pub fn get_track_by_path(client: &QdrantClient, path: &std::path::Path) -> Result<Option<Track>, IndexerError> {
    let id = crate::types::path_to_id(path);
    get_track(client, id)
}
```

- [ ] **Step 3: Add list_tracks with filter**

```rust
pub fn list_tracks(client: &QdrantClient, filter: &TrackFilter) -> Result<Vec<Track>, IndexerError> {
    let qdrant_filter = build_track_filter(filter);
    let order_key = match filter.order {
        TrackOrder::RecentlyAdded => Some("indexed_at"),
        TrackOrder::LastPlayed => Some("last_played"),
        _ => None,
    };
    let limit = filter.limit.unwrap_or(500);

    let results = client.scroll_with_filter(qdrant_filter, order_key, limit, false)?;
    let mut tracks: Vec<Track> = results.iter()
        .map(|(id, payload)| payload_to_track(*id, payload))
        .collect();

    match filter.order {
        TrackOrder::AlbumDiscTrack => {
            tracks.sort_by(|a, b| {
                a.album_title.cmp(&b.album_title)
                    .then(a.disc_number.cmp(&b.disc_number))
                    .then(a.track_number.cmp(&b.track_number))
                    .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            });
        }
        TrackOrder::TitleAsc => {
            tracks.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        }
        TrackOrder::Random => {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            tracks.sort_by(|a, b| {
                let mut ha = DefaultHasher::new();
                a.id.hash(&mut ha);
                let mut hb = DefaultHasher::new();
                b.id.hash(&mut hb);
                ha.finish().cmp(&hb.finish())
            });
        }
        _ => {} // already ordered by scroll
    }

    Ok(tracks)
}

fn build_track_filter(filter: &TrackFilter) -> Option<Value> {
    let mut must: Vec<Value> = Vec::new();

    if let Some(genre) = &filter.genre {
        must.push(json!({"key": "genre", "match": {"value": genre}}));
    }
    if let Some(artist) = &filter.artist {
        must.push(json!({"key": "artist_exact", "match": {"value": artist}}));
    }
    if let Some(album) = &filter.album {
        must.push(json!({"key": "album_title_exact", "match": {"value": album}}));
    }
    for tag in &filter.tags {
        must.push(json!({"key": "tags", "match": {"value": tag}}));
    }

    if must.is_empty() {
        None
    } else {
        Some(json!({"must": must}))
    }
}
```

- [ ] **Step 4: Add aggregation functions — list_albums, list_artists, list_genres**

```rust
pub fn list_genres(client: &QdrantClient) -> Result<Vec<Genre>, IndexerError> {
    let all = client.scroll_all_payloads(&["genre"])?;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for (_, payload) in &all {
        if let Some(g) = payload["genre"].as_str() {
            if !g.is_empty() {
                *counts.entry(g.to_string()).or_default() += 1;
            }
        }
    }
    let mut genres: Vec<Genre> = counts.into_iter()
        .map(|(name, track_count)| Genre { name, track_count })
        .collect();
    genres.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(genres)
}

pub fn list_albums(client: &QdrantClient, filter: &AlbumFilter) -> Result<Vec<Album>, IndexerError> {
    let fields = &["album_title", "album_title_exact", "artist", "album_year", "cover_path", "genre"];
    let all = client.scroll_all_payloads(fields)?;

    let mut album_map: HashMap<String, Album> = HashMap::new();
    for (_, payload) in &all {
        let title = match payload["album_title"].as_str() {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        let artist = payload["artist"].as_str().map(String::from);
        let genre = payload["genre"].as_str().unwrap_or("");

        if let Some(f_genre) = &filter.genre {
            if genre != f_genre { continue; }
        }
        if let Some(f_artist) = &filter.artist {
            if artist.as_deref() != Some(f_artist) { continue; }
        }

        let key = format!("{}|{}", title.to_lowercase(), artist.as_deref().unwrap_or(""));
        let entry = album_map.entry(key).or_insert_with(|| Album {
            title: title.to_string(),
            artist_name: artist.clone(),
            year: payload["album_year"].as_i64().map(|v| v as i32),
            cover_path: payload["cover_path"].as_str().map(PathBuf::from),
            track_count: 0,
        });
        entry.track_count += 1;
    }

    let mut albums: Vec<Album> = album_map.into_values().collect();
    albums.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    if let Some(limit) = filter.limit {
        albums.truncate(limit);
    }
    Ok(albums)
}

pub fn list_artists(client: &QdrantClient, filter: &ArtistFilter) -> Result<Vec<Artist>, IndexerError> {
    let fields = &["artist", "album_title", "genre"];
    let all = client.scroll_all_payloads(fields)?;

    let mut artist_tracks: HashMap<String, u32> = HashMap::new();
    let mut artist_albums: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    for (_, payload) in &all {
        let name = match payload["artist"].as_str() {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        if let Some(f_genre) = &filter.genre {
            if payload["genre"].as_str().unwrap_or("") != f_genre { continue; }
        }
        *artist_tracks.entry(name.to_string()).or_default() += 1;
        if let Some(album) = payload["album_title"].as_str() {
            if !album.is_empty() {
                artist_albums.entry(name.to_string()).or_default().insert(album.to_string());
            }
        }
    }

    let mut artists: Vec<Artist> = artist_tracks.into_iter()
        .map(|(name, track_count)| {
            let album_count = artist_albums.get(&name).map(|s| s.len() as u32).unwrap_or(0);
            Artist { name, sort_name: None, track_count, album_count }
        })
        .collect();
    artists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if let Some(limit) = filter.limit {
        artists.truncate(limit);
    }
    Ok(artists)
}
```

- [ ] **Step 5: Add search function (text search across title/artist/album)**

```rust
pub fn search(client: &QdrantClient, query: &str, limit: usize) -> Result<SearchResults, IndexerError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults { tracks: Vec::new(), albums: Vec::new(), artists: Vec::new() });
    }

    // Text search: OR across title, artist, album_title
    let filter = json!({
        "should": [
            {"key": "title", "match": {"text": q}},
            {"key": "artist", "match": {"text": q}},
            {"key": "album_title", "match": {"text": q}}
        ]
    });

    let results = client.scroll_with_filter(Some(filter), None, limit * 3, false)?;
    let tracks: Vec<Track> = results.iter()
        .map(|(id, payload)| payload_to_track(*id, payload))
        .take(limit)
        .collect();

    // Derive album/artist results from matching tracks
    let mut seen_albums = std::collections::HashSet::new();
    let mut albums = Vec::new();
    let mut seen_artists = std::collections::HashSet::new();
    let mut artists = Vec::new();

    for t in &tracks {
        if let Some(album) = &t.album_title {
            let key = album.to_lowercase();
            if seen_albums.insert(key) && albums.len() < 5 {
                albums.push(Album {
                    title: album.clone(),
                    artist_name: t.artist_name.clone(),
                    year: t.album_year,
                    cover_path: t.album_cover_path.clone(),
                    track_count: 0,
                });
            }
        }
        if let Some(artist) = &t.artist_name {
            let key = artist.to_lowercase();
            if seen_artists.insert(key) && artists.len() < 5 {
                artists.push(Artist {
                    name: artist.clone(),
                    sort_name: None,
                    track_count: 0,
                    album_count: 0,
                });
            }
        }
    }

    Ok(SearchResults { tracks, albums, artists })
}
```

- [ ] **Step 6: Add playback functions — record_play, list_history, toggle_like, list_liked, is_liked**

```rust
pub fn record_play(client: &QdrantClient, track_id: u64) -> Result<(), IndexerError> {
    let point = client.get_point(track_id)?;
    let current_count = point.as_ref()
        .and_then(|p| p["payload"]["play_count"].as_u64())
        .unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    client.set_payload(&[track_id], json!({
        "play_count": current_count + 1,
        "last_played": now
    }))
}

pub fn list_history(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "last_played", "range": {"gt": 0}}]
    });
    let results = client.scroll_with_filter(Some(filter), Some("last_played"), limit, false)?;
    Ok(results.iter().map(|(id, p)| payload_to_track(*id, p)).collect())
}

pub fn toggle_like(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    let point = client.get_point(track_id)?
        .ok_or_else(|| IndexerError::Embedding(format!("track {track_id} not found")))?;
    let currently_liked = point["payload"]["liked_at"].as_i64().is_some();

    if currently_liked {
        client.set_payload(&[track_id], json!({"liked_at": null}))?;
        Ok(false)
    } else {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        client.set_payload(&[track_id], json!({"liked_at": now}))?;
        Ok(true)
    }
}

pub fn list_liked(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "liked_at", "range": {"gt": 0}}]
    });
    let results = client.scroll_with_filter(Some(filter), Some("liked_at"), limit, false)?;
    Ok(results.iter().map(|(id, p)| payload_to_track(*id, p)).collect())
}

pub fn is_liked(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    match client.get_point(track_id)? {
        Some(point) => Ok(point["payload"]["liked_at"].as_i64().is_some()),
        None => Ok(false),
    }
}
```

- [ ] **Step 7: Add recommendations using Qdrant recommend API**

```rust
pub fn recommendations(client: &QdrantClient) -> Result<Recommendations, IndexerError> {
    // Most played (top 10)
    let filter = json!({"must": [{"key": "play_count", "range": {"gt": 0}}]});
    let results = client.scroll_with_filter(Some(filter), Some("play_count"), 10, false)?;
    let most_played: Vec<Track> = results.iter().map(|(id, p)| payload_to_track(*id, p)).collect();

    // Seeds: liked + most played
    let liked_filter = json!({"must": [{"key": "liked_at", "range": {"gt": 0}}]});
    let liked = client.scroll_with_filter(Some(liked_filter), Some("liked_at"), 10, false)?;
    let mut seed_ids: Vec<u64> = liked.iter().map(|(id, _)| *id).collect();
    for t in most_played.iter().take(5) {
        if !seed_ids.contains(&t.id) {
            seed_ids.push(t.id);
        }
    }
    seed_ids.truncate(10);

    // Based on top: recommend from seeds
    let based_on_top = if !seed_ids.is_empty() {
        let rec_ids = client.recommend(
            &seed_ids.iter().map(|id| *id as i64).collect::<Vec<_>>(),
            &[],
            10,
        )?;
        let mut tracks = Vec::new();
        for (tid, _score) in rec_ids {
            if let Some(t) = get_track(client, tid as u64)? {
                if !seed_ids.contains(&t.id) {
                    tracks.push(t);
                }
            }
        }
        tracks
    } else {
        Vec::new()
    };

    // Discover: unplayed tracks similar to seeds
    let discover = if !seed_ids.is_empty() {
        let rec_ids = client.recommend(
            &seed_ids.iter().map(|id| *id as i64).collect::<Vec<_>>(),
            &[],
            20,
        )?;
        let mut tracks = Vec::new();
        for (tid, _score) in rec_ids {
            if let Some(t) = get_track(client, tid as u64)? {
                if t.play_count == 0 && !seed_ids.contains(&t.id) {
                    tracks.push(t);
                }
            }
        }
        tracks.truncate(10);
        tracks
    } else {
        Vec::new()
    };

    Ok(Recommendations { most_played, based_on_top, discover })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Recommendations {
    pub most_played: Vec<Track>,
    pub based_on_top: Vec<Track>,
    pub discover: Vec<Track>,
}
```

- [ ] **Step 8: Add similar, shuffle, folders, mood, lyrics functions**

```rust
pub fn similar(client: &QdrantClient, track_id: u64, limit: usize) -> Result<Vec<(Track, f32)>, IndexerError> {
    let recs = client.recommend(&[track_id as i64], &[], limit)?;
    let mut results = Vec::new();
    for (tid, score) in recs {
        if let Some(t) = get_track(client, tid as u64)? {
            results.push((t, score as f32));
        }
    }
    Ok(results)
}

pub fn shuffle(client: &QdrantClient, filter: &TrackFilter, seed: u64, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let mut tracks = list_tracks(client, &TrackFilter {
        limit: Some(limit * 3),
        ..filter.clone()
    })?;
    // Fisher-Yates with deterministic seed
    let mut rng = seed;
    for i in (1..tracks.len()).rev() {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let j = (rng as usize) % (i + 1);
        tracks.swap(i, j);
    }
    tracks.truncate(limit);
    Ok(tracks)
}

pub fn list_folders(client: &QdrantClient, music_root: &str) -> Result<Vec<FolderPlaylist>, IndexerError> {
    let all = client.scroll_all_payloads(&["path", "cover_path"])?;
    let mut folder_map: HashMap<String, (u32, Option<PathBuf>)> = HashMap::new();
    let root = std::path::Path::new(music_root);

    for (_, payload) in &all {
        let path_str = payload["path"].as_str().unwrap_or("");
        let path = std::path::Path::new(path_str);
        if let Ok(rel) = path.strip_prefix(root) {
            if let Some(parent) = rel.parent() {
                let folder = parent.to_string_lossy().to_string();
                if !folder.is_empty() {
                    let entry = folder_map.entry(folder).or_insert((0, None));
                    entry.0 += 1;
                    if entry.1.is_none() {
                        entry.1 = payload["cover_path"].as_str().map(PathBuf::from);
                    }
                }
            }
        }
    }

    let mut folders: Vec<FolderPlaylist> = folder_map.into_iter()
        .map(|(folder, (track_count, cover_path))| FolderPlaylist { folder, track_count, cover_path })
        .collect();
    folders.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(folders)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderPlaylist {
    pub folder: String,
    pub track_count: u32,
    pub cover_path: Option<PathBuf>,
}

pub fn list_folder_tracks(client: &QdrantClient, music_root: &str, folder: &str) -> Result<Vec<Track>, IndexerError> {
    let prefix = format!("{}/{}", music_root.trim_end_matches('/'), folder);
    // Qdrant keyword match doesn't support prefix, so we scroll and filter client-side
    let all = client.scroll_all_payloads(&[
        "path", "filename", "title", "track_number", "disc_number", "duration_ms",
        "album_title", "album_year", "cover_path", "artist", "genre", "tags",
        "sample_rate", "bit_depth", "channels",
        "rg_track_gain", "rg_album_gain", "rg_track_peak", "rg_album_peak",
        "embedding_status", "play_count", "last_played", "liked_at", "lrc_path",
    ])?;

    let mut tracks: Vec<Track> = all.iter()
        .filter(|(_, p)| {
            p["path"].as_str()
                .map(|s| s.starts_with(&prefix))
                .unwrap_or(false)
        })
        .map(|(id, p)| payload_to_track(*id, p))
        .collect();
    tracks.sort_by(|a, b| {
        a.disc_number.cmp(&b.disc_number)
            .then(a.track_number.cmp(&b.track_number))
            .then(a.title.cmp(&b.title))
    });
    Ok(tracks)
}

pub fn get_lyrics(client: &QdrantClient, track_id: u64) -> Result<Vec<crate::lyrics::LyricLine>, IndexerError> {
    let point = match client.get_point(track_id)? {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let payload = &point["payload"];

    // 1. Prefer sidecar LRC
    if let Some(lrc) = payload["lrc_path"].as_str() {
        let path = std::path::Path::new(lrc);
        if path.is_file() {
            return crate::lyrics::parse_lrc_file(path);
        }
    }

    // 2. Embedded lyrics
    if let Some(text) = payload["embedded_lyrics"].as_str() {
        if !text.trim().is_empty() {
            let lines = text.trim().lines()
                .map(|line| crate::lyrics::LyricLine { t: 0.0, line: line.to_string(), header: false })
                .collect();
            return Ok(lines);
        }
    }

    Ok(Vec::new())
}

pub fn autoplay_next(client: &QdrantClient, seed_track_id: u64, exclude_ids: &[u64], limit: usize) -> Result<Vec<(u64, f64)>, IndexerError> {
    let neg: Vec<i64> = exclude_ids.iter().map(|id| *id as i64).collect();
    let recs = client.recommend(&[seed_track_id as i64], &neg, limit)?;
    Ok(recs.iter().map(|(id, score)| (*id as u64, *score)).collect())
}
```

- [ ] **Step 9: Commit**

```bash
git add src-tauri/crates/library-indexer/src/query.rs
git commit -m "feat(library-indexer): add query.rs with all read queries backed by Qdrant"
```

---

## Task 4: Rewrite Pipeline for Qdrant-only Ingest

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/pipeline.rs`

The pipeline changes from SQLite transactions to Qdrant upserts. The coordinator thread no longer needs a writer Connection. Embed results are upserted directly as vectors on existing points.

- [ ] **Step 1: Replace imports and pipeline start signature**

Remove all `rusqlite` and `db` imports. Replace `Connection` with `QdrantClient`. The `start` function now takes a `QdrantClient` instead of `OpenedDb`:

```rust
use crate::cover::{self, CoverSource};
use crate::embed_client::EmbedClient;
use crate::error::IndexerError;
use crate::lyrics;
use crate::metadata::{self, ParsedFlacMetadata, PictureUsage};
use crate::qdrant_client::QdrantClient;
use crate::scan::{self, FileEntry};
use crate::types::{IndexerCommand, IndexerEvent, IndexerSnapshot, path_to_id};
use crossbeam_channel::{select, unbounded, Receiver, Sender};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};
```

Update `SharedState::refresh_from_db` → `SharedState::refresh`:

```rust
impl SharedState {
    pub fn refresh(&self, client: &QdrantClient) {
        let total = client.collection_point_count().unwrap_or(0);
        self.tracks_total.store(total, Ordering::Relaxed);
        // Embedding counts: scroll with filter
        // For simplicity, just set done = total for now, pending/failed derived from events
    }
}
```

Update `start` signature:

```rust
pub(crate) fn start(
    client: QdrantClient,
    config: PipelineConfig,
) -> (
    Sender<IndexerCommand>,
    Receiver<IndexerEvent>,
    Arc<SharedState>,
    QdrantClient,
    Handles,
) {
    // ... same channel setup, but pass client to coordinator
    let coord_client = client.clone();
    let coordinator = thread::Builder::new()
        .name("library-indexer-coord".into())
        .spawn(move || {
            coordinator_loop(coord_client, config, cmd_rx, coord_evt_tx, coord_state, embed_job_tx, embed_result_rx);
        })
        .expect("spawn coordinator");

    (cmd_tx, evt_rx, state, client, Handles { coordinator, embed_worker })
}
```

- [ ] **Step 2: Rewrite coordinator_loop**

Replace `Connection` with `QdrantClient`:

```rust
fn coordinator_loop(
    client: QdrantClient,
    config: PipelineConfig,
    cmd_rx: Receiver<IndexerCommand>,
    evt_tx: Sender<IndexerEvent>,
    state: Arc<SharedState>,
    embed_job_tx: Sender<EmbedJob>,
    embed_result_rx: Receiver<EmbedResult>,
) {
    info!(target: "library_indexer::pipeline", "coordinator starting");
    state.refresh(&client);

    if let Err(e) = run_scan(&client, &config, &evt_tx, &state, &embed_job_tx) {
        error!(target: "library_indexer::pipeline", error = %e, "initial scan failed");
        let _ = evt_tx.send(IndexerEvent::Error(e.to_string()));
    }

    loop {
        select! {
            recv(cmd_rx) -> msg => match msg {
                Ok(IndexerCommand::Rescan) => {
                    if let Err(e) = run_scan(&client, &config, &evt_tx, &state, &embed_job_tx) {
                        error!(target: "library_indexer::pipeline", error = %e, "rescan failed");
                        let _ = evt_tx.send(IndexerEvent::Error(e.to_string()));
                    }
                }
                Ok(IndexerCommand::Shutdown) | Err(_) => break,
            },
            recv(embed_result_rx) -> msg => match msg {
                Ok(result) => {
                    apply_embed_result(&client, &result, &state, &evt_tx);
                }
                Err(_) => {}
            },
        }
    }
}
```

- [ ] **Step 3: Rewrite run_scan — scroll existing from Qdrant, diff, upsert**

```rust
fn run_scan(
    client: &QdrantClient,
    config: &PipelineConfig,
    evt_tx: &Sender<IndexerEvent>,
    state: &Arc<SharedState>,
    embed_job_tx: &Sender<EmbedJob>,
) -> Result<(), IndexerError> {
    state.scan_in_progress.store(true, Ordering::Relaxed);
    let _guard = ScanGuard(Arc::clone(state));
    let _ = evt_tx.send(IndexerEvent::ScanStarted);

    let entries: Vec<FileEntry> = scan::walk_music_root(&config.music_root)?.collect();
    let total = entries.len() as u64;

    // Load existing from Qdrant: (id, path, mtime, size_bytes)
    let existing = load_existing_from_qdrant(client)?;
    info!(target: "library_indexer::pipeline", files_on_disk = total, tracks_in_qdrant = existing.len(), "scan diff starting");

    let mut added = 0u64;
    let mut updated = 0u64;
    let mut removed = 0u64;

    let seen_paths: std::collections::HashSet<PathBuf> = entries.iter().map(|e| e.path.clone()).collect();

    // Deletions
    let to_delete: Vec<u64> = existing.iter()
        .filter(|(_, path, _, _)| !seen_paths.contains(path))
        .map(|(id, _, _, _)| *id)
        .collect();
    if !to_delete.is_empty() {
        client.delete_points(&to_delete)?;
        removed = to_delete.len() as u64;
        for id in &to_delete {
            let _ = evt_tx.send(IndexerEvent::TrackRemoved(*id as i64));
        }
    }

    let by_path: std::collections::HashMap<PathBuf, (u64, u64, u64)> = existing.into_iter()
        .map(|(id, p, mt, sz)| (p, (id, mt, sz)))
        .collect();

    let mut batch: Vec<(u64, serde_json::Value, Option<Vec<f32>>)> = Vec::new();
    let mut processed = 0u64;

    for entry in entries {
        processed += 1;
        let prior = by_path.get(&entry.path);
        let needs_ingest = match prior {
            None => true,
            Some((_, mt, sz)) => *mt != entry.mtime || *sz != entry.size,
        };

        if needs_ingest {
            match build_track_payload(config, &entry) {
                Ok(payload) => {
                    let id = path_to_id(&entry.path);
                    batch.push((id, payload, None));
                    if prior.is_none() { added += 1; } else { updated += 1; }
                    let _ = embed_job_tx.send(EmbedJob { track_id: id, path: entry.path.clone() });
                }
                Err(e) => {
                    warn!(target: "library_indexer::pipeline", path = ?entry.path, error = %e, "ingest failed");
                }
            }
        } else if let Some((id, _, _)) = prior {
            // Re-enqueue pending embeddings
            let _ = embed_job_tx.send(EmbedJob { track_id: *id, path: entry.path.clone() });
        }

        // Flush batch every 100
        if batch.len() >= 100 {
            client.upsert_tracks(&batch)?;
            batch.clear();
        }

        if processed % 25 == 0 {
            let _ = evt_tx.send(IndexerEvent::ScanProgress { processed, total });
        }
    }

    // Flush remaining
    if !batch.is_empty() {
        client.upsert_tracks(&batch)?;
    }

    let _ = evt_tx.send(IndexerEvent::ScanProgress { processed, total });
    state.refresh(client);
    let _ = evt_tx.send(IndexerEvent::ScanDone { added, updated, removed });
    Ok(())
}
```

- [ ] **Step 4: Add load_existing_from_qdrant and build_track_payload helpers**

```rust
fn load_existing_from_qdrant(client: &QdrantClient) -> Result<Vec<(u64, PathBuf, u64, u64)>, IndexerError> {
    let all = client.scroll_all_payloads(&["path", "mtime", "size_bytes"])?;
    Ok(all.into_iter()
        .map(|(id, payload)| {
            let path = PathBuf::from(payload["path"].as_str().unwrap_or(""));
            let mtime = payload["mtime"].as_u64().unwrap_or(0);
            let size = payload["size_bytes"].as_u64().unwrap_or(0);
            (id, path, mtime, size)
        })
        .collect())
}

fn build_track_payload(config: &PipelineConfig, entry: &FileEntry) -> Result<serde_json::Value, IndexerError> {
    let md = crate::metadata::parse_flac(&entry.path)?;

    let artist_name = md.album_artist.clone()
        .or_else(|| md.artist.clone())
        .or_else(|| entry.album_artist_from_path.clone())
        .unwrap_or_default();
    let album_title = md.album.clone()
        .or_else(|| entry.album_from_path.clone())
        .unwrap_or_default();
    let genre = entry.genre_from_path.clone().unwrap_or_default();
    let filename = entry.path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let title = md.title.clone().unwrap_or_else(|| filename_stem(&filename));
    let lrc_path = lyrics::find_lrc_sidecar(&entry.path).map(|p| path_str(&p));
    let embedded_lyrics = md.embedded_lyrics.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Cover art processing
    let cover_source = pick_cover_source(entry, &md);
    let cover_path = if let Some(src) = cover_source {
        let album_key = format!("{}|{}", album_title.to_lowercase(), artist_name.to_lowercase());
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&album_key, &mut hasher);
        let album_hash = std::hash::Hasher::finish(&hasher);
        match crate::cover::process_album_cover(album_hash as i64, src, &config.cache_dir) {
            Ok(path) => {
                let rel = path.strip_prefix(&config.cache_dir)
                    .map(|p| p.to_path_buf())
                    .unwrap_or(path);
                Some(rel.to_string_lossy().to_string())
            }
            Err(e) => {
                warn!(target: "library_indexer::pipeline", error = %e, "cover processing failed");
                None
            }
        }
    } else {
        None
    };

    let now = unix_now();

    Ok(json!({
        "path": path_str(&entry.path),
        "filename": filename,
        "title": title,
        "track_number": md.track_number,
        "disc_number": md.disc_number.unwrap_or(1),
        "duration_ms": md.duration_ms,
        "album_title": album_title,
        "album_title_exact": album_title,
        "album_year": md.year.or(entry.year_from_path),
        "artist": artist_name,
        "artist_exact": artist_name,
        "genre": genre,
        "tags": md.tags,
        "cover_path": cover_path,
        "sample_rate": md.sample_rate,
        "bit_depth": md.bit_depth,
        "channels": md.channels,
        "rg_track_gain": md.rg_track_gain,
        "rg_album_gain": md.rg_album_gain,
        "rg_track_peak": md.rg_track_peak,
        "rg_album_peak": md.rg_album_peak,
        "embedding_status": "pending",
        "play_count": 0,
        "last_played": null,
        "liked_at": null,
        "lrc_path": lrc_path,
        "embedded_lyrics": embedded_lyrics,
        "mtime": entry.mtime,
        "size_bytes": entry.size,
        "indexed_at": now
    }))
}
```

- [ ] **Step 5: Rewrite apply_embed_result — set vector via Qdrant API**

```rust
fn apply_embed_result(
    client: &QdrantClient,
    result: &EmbedResult,
    state: &Arc<SharedState>,
    evt_tx: &Sender<IndexerEvent>,
) {
    match &result.outcome {
        Ok(vector) => {
            // Upsert vector on existing point
            let body = json!({
                "points": [{
                    "id": result.track_id,
                    "vector": { "mert": vector }
                }]
            });
            let url = format!("{}/collections/rustify_tracks/points", client.base_url());
            match client.raw_put(&url, &body) {
                Ok(_) => {
                    client.set_payload(&[result.track_id], json!({"embedding_status": "done"})).ok();
                    state.embeddings_done.fetch_add(1, Ordering::Relaxed);
                    let _ = evt_tx.send(IndexerEvent::EmbeddingDone { track_id: result.track_id as i64 });
                }
                Err(e) => {
                    warn!(target: "library_indexer::pipeline", track_id = result.track_id, error = %e, "write embedding failed");
                }
            }
        }
        Err(msg) => {
            client.set_payload(&[result.track_id], json!({"embedding_status": "failed"})).ok();
            state.embeddings_failed.fetch_add(1, Ordering::Relaxed);
        }
    }
    state.refresh(client);
    let snap = state.snapshot();
    let _ = evt_tx.send(IndexerEvent::EmbeddingProgress { done: snap.embeddings_done, pending: snap.embeddings_pending });
}
```

Note: `EmbedJob.track_id` changes to `u64`. `raw_put` and `base_url()` are small helpers to add to QdrantClient (pub getter for base_url, thin wrapper around agent.put).

- [ ] **Step 6: Remove regenerate_missing_covers (or adapt)**

The cover regen function queries SQLite for album IDs. In the Qdrant model, covers are per-track payload. The scan already handles cover extraction. Remove `regenerate_missing_covers` — if a user clears cache, a rescan fixes it.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/library-indexer/src/pipeline.rs
git commit -m "refactor(pipeline): rewrite scan pipeline for Qdrant-only ingest"
```

---

## Task 5: Rewrite IndexerHandle and lib.rs

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/lib.rs`
- Modify: `src-tauri/crates/library-indexer/src/error.rs`

- [ ] **Step 1: Update lib.rs — replace SQLite modules with Qdrant-backed ones**

```rust
pub mod error;
pub mod types;

mod scan;
mod metadata;
mod cover;
mod watch;
pub mod query;
mod pipeline;

pub mod lyrics;
pub mod qdrant_client;

pub use qdrant_client::{MoodFilters, QdrantClient};
pub use error::IndexerError;
pub use lyrics::LyricLine;
pub use query::{FolderPlaylist, PlaylistSearchResult, Recommendations};
pub use types::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbeddingStatus, Genre, IndexerCommand,
    IndexerEvent, IndexerSnapshot, MoodPlaylist, SearchResults, Tag, Track, TrackFilter,
    TrackOrder,
};
```

- [ ] **Step 2: Update IndexerConfig and Indexer::open**

```rust
pub struct IndexerConfig {
    pub qdrant_url: String,
    pub music_root: PathBuf,
    pub cache_dir: PathBuf,
    pub embed_client: Option<embed_client::EmbedClient>,
}

pub struct Indexer;

impl Indexer {
    pub fn open(config: IndexerConfig) -> Result<IndexerHandle, IndexerError> {
        let client = QdrantClient::new(&config.qdrant_url);
        client.ensure_collection()?;
        client.ensure_play_events_collection()?;

        let pipeline_cfg = pipeline::PipelineConfig {
            music_root: config.music_root.clone(),
            cache_dir: config.cache_dir.clone(),
            embed_client: config.embed_client.clone(),
        };
        let (cmd_tx, evt_rx, state, client, _handles) = pipeline::start(client, pipeline_cfg);
        Ok(IndexerHandle {
            inner: Arc::new(HandleInner {
                cmd_tx,
                evt_rx,
                state,
                client,
            }),
        })
    }
}
```

- [ ] **Step 3: Rewrite IndexerHandle — all methods delegate to query.rs or QdrantClient**

```rust
struct HandleInner {
    cmd_tx: Sender<IndexerCommand>,
    evt_rx: Receiver<IndexerEvent>,
    state: Arc<pipeline::SharedState>,
    client: QdrantClient,
}

#[derive(Clone)]
pub struct IndexerHandle {
    inner: Arc<HandleInner>,
}

impl IndexerHandle {
    pub fn send(&self, cmd: IndexerCommand) -> Result<(), IndexerError> {
        self.inner.cmd_tx.send(cmd).map_err(|_| IndexerError::Shutdown)
    }
    pub fn subscribe(&self) -> Receiver<IndexerEvent> { self.inner.evt_rx.clone() }
    pub fn snapshot(&self) -> IndexerSnapshot { self.inner.state.snapshot() }
    pub fn client(&self) -> &QdrantClient { &self.inner.client }

    pub fn track(&self, id: u64) -> Result<Option<Track>, IndexerError> {
        query::get_track(&self.inner.client, id)
    }
    pub fn get_track_by_path(&self, path: &std::path::Path) -> Result<Option<Track>, IndexerError> {
        query::get_track_by_path(&self.inner.client, path)
    }
    pub fn list_genres(&self) -> Result<Vec<Genre>, IndexerError> {
        query::list_genres(&self.inner.client)
    }
    pub fn list_tracks(&self, filter: TrackFilter) -> Result<Vec<Track>, IndexerError> {
        query::list_tracks(&self.inner.client, &filter)
    }
    pub fn list_albums(&self, filter: AlbumFilter) -> Result<Vec<Album>, IndexerError> {
        query::list_albums(&self.inner.client, &filter)
    }
    pub fn list_artists(&self, filter: ArtistFilter) -> Result<Vec<Artist>, IndexerError> {
        query::list_artists(&self.inner.client, &filter)
    }
    pub fn search(&self, query: &str, limit: usize) -> Result<SearchResults, IndexerError> {
        query::search(&self.inner.client, query, limit)
    }
    pub fn similar(&self, track_id: u64, limit: usize) -> Result<Vec<(Track, f32)>, IndexerError> {
        query::similar(&self.inner.client, track_id, limit)
    }
    pub fn shuffle(&self, filter: TrackFilter, seed: u64, limit: usize) -> Result<Vec<Track>, IndexerError> {
        query::shuffle(&self.inner.client, &filter, seed, limit)
    }
    pub fn list_folders(&self, music_root: &str) -> Result<Vec<query::FolderPlaylist>, IndexerError> {
        query::list_folders(&self.inner.client, music_root)
    }
    pub fn list_folder_tracks(&self, music_root: &str, folder: &str) -> Result<Vec<Track>, IndexerError> {
        query::list_folder_tracks(&self.inner.client, music_root, folder)
    }
    pub fn get_lyrics(&self, track_id: u64) -> Result<Vec<LyricLine>, IndexerError> {
        query::get_lyrics(&self.inner.client, track_id)
    }
    pub fn record_play(&self, track_id: u64) -> Result<(), IndexerError> {
        query::record_play(&self.inner.client, track_id)
    }
    pub fn toggle_like(&self, track_id: u64) -> Result<bool, IndexerError> {
        query::toggle_like(&self.inner.client, track_id)
    }
    pub fn list_liked(&self, limit: usize) -> Result<Vec<Track>, IndexerError> {
        query::list_liked(&self.inner.client, limit)
    }
    pub fn is_liked(&self, track_id: u64) -> Result<bool, IndexerError> {
        query::is_liked(&self.inner.client, track_id)
    }
    pub fn list_history(&self, limit: usize) -> Result<Vec<Track>, IndexerError> {
        query::list_history(&self.inner.client, limit)
    }
    pub fn recommendations(&self) -> Result<query::Recommendations, IndexerError> {
        query::recommendations(&self.inner.client)
    }
    pub fn autoplay_next(&self, seed: u64, exclude: &[u64], limit: usize) -> Result<Vec<(u64, f64)>, IndexerError> {
        query::autoplay_next(&self.inner.client, seed, exclude, limit)
    }
    pub fn behavioral_signals(&self) -> Result<(Vec<i64>, Vec<i64>), IndexerError> {
        self.inner.client.behavioral_signals()
    }
}
```

- [ ] **Step 4: Update error.rs — remove rusqlite variant**

```rust
#[derive(Debug, thiserror::Error)]
pub enum IndexerError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Metadata error: {0}")]
    Metadata(String),
    #[error("Embedding error: {0}")]
    Embedding(String),
    #[error("Indexer has been shut down")]
    Shutdown,
}
```

Remove `Database(#[from] rusqlite::Error)`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/library-indexer/src/lib.rs src-tauri/crates/library-indexer/src/error.rs
git commit -m "refactor(library-indexer): rewrite IndexerHandle for Qdrant-only, remove SQLite error variant"
```

---

## Task 6: Update Tauri Commands

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update Library state and setup — remove db_path, use qdrant_url**

Replace:
```rust
let db_path = data_dir.join("library.db");
```
With:
```rust
let qdrant_url = std::env::var("RUSTIFY_QDRANT_URL")
    .unwrap_or_else(|_| "http://localhost:6333".to_string());
```

Update IndexerConfig construction:
```rust
let config = IndexerConfig {
    qdrant_url,
    music_root: music_root.clone(),
    cache_dir: cache_dir.clone(),
    embed_client: embed_url.as_deref().map(EmbedClient::new),
};
```

Remove the `Qdrant` state wrapper — the `IndexerHandle` now owns the `QdrantClient`.

- [ ] **Step 2: Update filter commands — string params instead of i64 IDs**

```rust
#[tauri::command]
fn lib_list_tracks(
    lib: State<Library>,
    genre: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let filter = TrackFilter { genre, artist, album, limit, ..Default::default() };
    let mut tracks = lib.handle.list_tracks(filter).map_err(err)?;
    resolve_cover_paths(&mut tracks, &lib.cache_dir);
    Ok(tracks)
}

#[tauri::command]
fn lib_list_albums(
    lib: State<Library>,
    artist: Option<String>,
    genre: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Album>, String> {
    let filter = AlbumFilter { artist, genre, limit };
    let mut albums = lib.handle.list_albums(filter).map_err(err)?;
    for album in &mut albums {
        if let Some(rel) = &album.cover_path {
            album.cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(albums)
}

#[tauri::command]
fn lib_list_artists(
    lib: State<Library>,
    genre: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Artist>, String> {
    let filter = ArtistFilter { genre, limit };
    lib.handle.list_artists(filter).map_err(err)
}
```

- [ ] **Step 3: Update track ID params from i64 to u64**

All commands that take `id: i64` change to `id: u64`:

```rust
#[tauri::command]
fn lib_get_track(lib: State<Library>, id: u64) -> Result<Option<Track>, String> { ... }

#[tauri::command]
fn lib_similar(lib: State<Library>, track_id: u64, limit: Option<usize>) -> Result<Vec<SimilarTrack>, String> { ... }

#[tauri::command]
fn lib_toggle_like(lib: State<Library>, track_id: u64) -> Result<bool, String> { ... }

#[tauri::command]
fn lib_record_play(lib: State<Library>, track_id: u64) -> Result<(), String> { ... }
```

- [ ] **Step 4: Remove Qdrant state — semantic_search and mood_search use handle.client()**

```rust
#[tauri::command]
fn lib_semantic_search(
    lib: State<Library>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let client = lib.handle.client();
    let tei = library_indexer::LyricsEmbedClient::new("http://100.123.73.128:8080");
    let vector = tei.embed_text(&query).map_err(err)?;
    let results = client.semantic_search(&vector, limit.unwrap_or(10)).map_err(err)?;
    let mut tracks = Vec::new();
    for (track_id, _score) in results {
        if let Ok(Some(mut t)) = lib.handle.track(track_id as u64) {
            resolve_single_cover(&mut t, &lib.cache_dir);
            tracks.push(t);
        }
    }
    Ok(tracks)
}
```

- [ ] **Step 5: Remove sync_to_qdrant and sync_lyrics_to_qdrant commands**

These are no longer needed — data goes directly to Qdrant during scan.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor(tauri): update commands for Qdrant-only model — string filters, u64 IDs"
```

---

## Task 7: Remove SQLite Dependencies and Files

**Files:**
- Delete: `src-tauri/crates/library-indexer/src/db.rs`
- Delete: `src-tauri/crates/library-indexer/src/search.rs`
- Delete: `src-tauri/crates/library-indexer/src/play_events.rs`
- Delete: `src-tauri/crates/library-indexer/migrations/` (entire directory)
- Delete: `src-tauri/crates/library-indexer/seeds/genres.json`
- Modify: `src-tauri/Cargo.toml` — remove rusqlite
- Modify: `src-tauri/crates/library-indexer/Cargo.toml` — remove rusqlite

- [ ] **Step 1: Delete SQLite source files**

```bash
rm src-tauri/crates/library-indexer/src/db.rs
rm src-tauri/crates/library-indexer/src/search.rs
rm src-tauri/crates/library-indexer/src/play_events.rs
rm -rf src-tauri/crates/library-indexer/migrations/
rm -rf src-tauri/crates/library-indexer/seeds/
```

- [ ] **Step 2: Remove rusqlite from workspace Cargo.toml**

In `src-tauri/Cargo.toml`, remove:
```toml
rusqlite = { version = "0.32", features = ["bundled", "blob", "limits"] }
```

In `src-tauri/crates/library-indexer/Cargo.toml`, remove:
```toml
rusqlite = { workspace = true }
```

- [ ] **Step 3: Run cargo check to verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Fix any remaining references to removed modules/types.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove SQLite — db.rs, search.rs, play_events.rs, migrations, rusqlite dependency"
```

---

## Task 8: Update Frontend for New Types

**Files:**
- Modify: frontend files that reference track.id, genre_id, artist_id, album_id

- [ ] **Step 1: Grep frontend for i64 ID usage**

```bash
grep -rn "genre_id\|artist_id\|album_id\|track_id\|\.id" src/views/ src/js/ --include="*.tsx" --include="*.ts" --include="*.js"
```

- [ ] **Step 2: Update Tauri invoke calls — change integer ID params to string params**

Where the frontend passes `genre_id: number`, change to `genre: string`.
Where it passes `artist_id: number`, change to `artist: string`.
Where it passes `album_id: number`, change to `album: string`.

Track IDs change from number to BigInt or string (u64 can exceed JS safe integer).
Recommendation: serialize as string in Rust (`#[serde(serialize_with = "...")]`) and parse as string in frontend.

- [ ] **Step 3: Test the UI end-to-end**

Start the app and verify:
- Library loads tracks
- Search works
- Play/pause works
- Likes toggle
- History shows
- Album/artist/genre views work

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "feat(frontend): update for Qdrant-only model — string filters, string IDs"
```

---

## Task 9: Verify and Clean Up

- [ ] **Step 1: Full cargo check**

```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1
```

- [ ] **Step 2: Run any existing tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1
```

Remove or update tests that reference SQLite.

- [ ] **Step 3: Verify data/library.db is no longer referenced anywhere**

```bash
grep -rn "library\.db" src-tauri/ --include="*.rs" --include="*.toml"
```

Should return zero results.

- [ ] **Step 4: Delete local library.db if present**

```bash
rm -f data/library.db
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: cleanup — verify no SQLite references remain, remove library.db"
```
