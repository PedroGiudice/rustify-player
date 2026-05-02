# Implicit Feedback via Qdrant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite-based play event tracking with a dedicated Qdrant collection, and enrich `behavioral_signals()` to produce smarter positives/negatives for the Recommend API.

**Architecture:** A new payload-only Qdrant collection `play_events` stores one point per playback event. At recommendation time, `behavioral_signals()` scrolls this collection with filters to derive weighted positive/negative track IDs. The existing `rustify_tracks` collection and Recommend API usage remain unchanged.

**Tech Stack:** Rust (ureq HTTP client), Qdrant REST API v1.10+, uuid crate for point IDs.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/crates/library-indexer/Cargo.toml` | Modify | Add `uuid` dependency |
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Modify | Add play_events collection methods |
| `src-tauri/crates/library-indexer/src/play_events.rs` | Modify | Replace SQLite functions with Qdrant calls |
| `src-tauri/crates/library-indexer/src/lib.rs` | Modify | Update `insert_play_event` and `behavioral_signals` signatures |
| `src-tauri/src/lib.rs` | Modify | Pass QdrantClient to play event insert in TrackEnded handler |

---

### Task 1: Add uuid dependency to library-indexer

**Files:**
- Modify: `src-tauri/crates/library-indexer/Cargo.toml`

- [ ] **Step 1: Add uuid crate**

```toml
# Under [dependencies], add:
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 2: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles without errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/library-indexer/Cargo.toml
git commit -m "deps(library-indexer): add uuid crate for play_events point IDs"
```

---

### Task 2: Add Qdrant play_events collection methods

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/qdrant_client.rs`

- [ ] **Step 1: Add the collection constant and ensure method**

After the existing `const LYRICS_DIM` line (line 29), add:

```rust
/// Name of the play events collection (payload-only, no vectors).
const PLAY_EVENTS_COLLECTION: &str = "play_events";
```

Add this method to `impl QdrantClient`, after `ensure_collection()`:

```rust
/// Ensure the `play_events` collection exists (payload-only, no vectors).
/// Creates payload indices for efficient filtering.
pub fn ensure_play_events_collection(&self) -> Result<(), IndexerError> {
    let url = format!("{}/collections/{PLAY_EVENTS_COLLECTION}", self.base_url);

    match self.agent.get(&url).call() {
        Ok(_) => return Ok(()),
        Err(ureq::Error::Status(404, _)) => {}
        Err(e) => {
            return Err(IndexerError::Embedding(format!(
                "qdrant get play_events collection: {e}"
            )));
        }
    }

    // Create collection with no vectors (payload-only points)
    let body = json!({
        "vectors": {
            "size": 1,
            "distance": "Cosine"
        }
    });

    self.agent
        .put(&url)
        .send_json(&body)
        .map_err(|e| IndexerError::Embedding(format!("qdrant create play_events: {e}")))?;

    // Create payload indices
    for (field, schema) in [
        ("track_id", json!({"type": "integer"})),
        ("listen_pct", json!({"type": "float"})),
        ("started_at", json!({"type": "keyword"})),
        ("origin", json!({"type": "keyword"})),
    ] {
        let idx_body = json!({
            "field_name": field,
            "field_schema": schema
        });
        let _ = self.agent
            .put(&format!("{}/collections/{PLAY_EVENTS_COLLECTION}/index", self.base_url))
            .send_json(&idx_body);
    }

    Ok(())
}
```

- [ ] **Step 2: Add insert_play_event method**

```rust
/// Insert a single play event into the play_events collection.
pub fn insert_play_event(
    &self,
    track_id: i64,
    origin: &str,
    started_at: &str,
    end_position_ms: Option<i64>,
    duration_ms: i64,
) -> Result<(), IndexerError> {
    let listen_pct = end_position_ms
        .map(|pos| (pos as f64) / (duration_ms as f64))
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);

    let point_id = uuid::Uuid::new_v4().to_string();

    let body = json!({
        "points": [{
            "id": point_id,
            "vector": [0.0],
            "payload": {
                "track_id": track_id,
                "origin": origin,
                "started_at": started_at,
                "end_position_ms": end_position_ms,
                "duration_ms": duration_ms,
                "listen_pct": listen_pct
            }
        }]
    });

    self.agent
        .put(&format!(
            "{}/collections/{PLAY_EVENTS_COLLECTION}/points",
            self.base_url
        ))
        .send_json(&body)
        .map_err(|e| IndexerError::Embedding(format!("qdrant insert play_event: {e}")))?;

    Ok(())
}
```

- [ ] **Step 3: Add scroll_play_events method**

```rust
/// Scroll play_events with a filter condition. Returns payloads ordered by started_at DESC.
/// Used by behavioral_signals to derive positives/negatives.
pub fn scroll_play_events(
    &self,
    filter: Value,
    limit: usize,
) -> Result<Vec<Value>, IndexerError> {
    let body = json!({
        "filter": filter,
        "limit": limit,
        "with_payload": true,
        "with_vector": false,
        "order_by": {
            "key": "started_at",
            "direction": "desc"
        }
    });

    let resp: Value = self
        .agent
        .post(&format!(
            "{}/collections/{PLAY_EVENTS_COLLECTION}/points/scroll",
            self.base_url
        ))
        .send_json(&body)
        .map_err(|e| IndexerError::Embedding(format!("qdrant scroll play_events: {e}")))?
        .into_json()
        .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

    let mut payloads = Vec::new();
    if let Some(points) = resp["result"]["points"].as_array() {
        for p in points {
            if let Some(payload) = p.get("payload") {
                payloads.push(payload.clone());
            }
        }
    }

    Ok(payloads)
}

/// Derive positive and negative track IDs from Qdrant play_events.
///
/// Positives: tracks with listen_pct >= 0.8 from recent events (limit 30 distinct).
/// Repeat bonus: tracks appearing 3+ times get duplicated in the list.
/// Negatives: tracks with listen_pct < 0.15 (excl. album_seq), limit 15 distinct.
pub fn behavioral_signals(&self) -> Result<(Vec<i64>, Vec<i64>), IndexerError> {
    // Positives: recent completed plays
    let pos_filter = json!({
        "must": [{
            "key": "listen_pct",
            "range": { "gte": 0.8 }
        }]
    });
    let pos_events = self.scroll_play_events(pos_filter, 100)?;

    let mut pos_counts: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    for ev in &pos_events {
        if let Some(tid) = ev["track_id"].as_i64() {
            *pos_counts.entry(tid).or_insert(0) += 1;
        }
    }

    // Build positives: distinct track_ids, limit 30. Repeat 3+ → duplicate entry.
    let mut positives: Vec<i64> = Vec::new();
    let mut sorted_pos: Vec<(i64, usize)> = pos_counts.into_iter().collect();
    sorted_pos.sort_by(|a, b| b.1.cmp(&a.1));
    for (tid, count) in sorted_pos.into_iter().take(30) {
        positives.push(tid);
        if count >= 3 {
            positives.push(tid); // duplicate for weight
        }
    }

    // Negatives: recent skips (listen_pct < 0.15, not album_seq)
    let neg_filter = json!({
        "must": [
            { "key": "listen_pct", "range": { "lt": 0.15 } },
            { "must_not": [{ "key": "origin", "match": { "value": "album_seq" } }] }
        ]
    });
    let neg_events = self.scroll_play_events(neg_filter, 50)?;

    let mut neg_seen = std::collections::HashSet::new();
    let mut negatives: Vec<i64> = Vec::new();
    for ev in &neg_events {
        if let Some(tid) = ev["track_id"].as_i64() {
            if neg_seen.insert(tid) {
                negatives.push(tid);
                if negatives.len() >= 15 {
                    break;
                }
            }
        }
    }

    Ok((positives, negatives))
}
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles (play_events.rs still exists with old code, that's fine — will be updated in Task 3)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/library-indexer/src/qdrant_client.rs
git commit -m "feat(qdrant): add play_events collection methods and behavioral_signals"
```

---

### Task 3: Update play_events.rs and lib.rs (library-indexer crate)

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/play_events.rs`
- Modify: `src-tauri/crates/library-indexer/src/lib.rs`

- [ ] **Step 1: Rewrite play_events.rs**

Replace entire contents of `src-tauri/crates/library-indexer/src/play_events.rs`:

```rust
use crate::error::IndexerError;
use crate::qdrant_client::QdrantClient;
use rusqlite::{params, Connection};

/// Insert a play event into both SQLite (legacy, for history view) and Qdrant.
pub fn insert_play_event(
    conn: &Connection,
    qdrant: Option<&QdrantClient>,
    track_id: i64,
    origin: &str,
    started_at: &str,
    ended_at: Option<&str>,
    end_position_ms: Option<i64>,
    duration_ms: i64,
) -> Result<(), IndexerError> {
    // SQLite insert kept for history view (read-only consumer)
    conn.execute(
        "INSERT INTO play_events (track_id, origin, started_at, ended_at, end_position_ms, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![track_id, origin, started_at, ended_at, end_position_ms, duration_ms],
    )?;

    // Qdrant insert for behavioral signals
    if let Some(client) = qdrant {
        if let Err(e) = client.insert_play_event(track_id, origin, started_at, end_position_ms, duration_ms) {
            tracing::warn!(?e, track_id, "failed to insert play_event to Qdrant");
        }
    }

    Ok(())
}

/// Returns `Vec<(track_id, score)>` ordered by rank.
/// Checks `track_recommendations` first; returns empty if none found.
pub fn autoplay_next(
    conn: &Connection,
    seed_track_id: i64,
    exclude_ids: &[i64],
    limit: usize,
) -> Result<Vec<(i64, f64)>, IndexerError> {
    let exclude_csv = if exclude_ids.is_empty() {
        "0".to_string()
    } else {
        exclude_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",")
    };

    let sql = format!(
        "SELECT recommended_track_id, score
         FROM track_recommendations
         WHERE seed_track_id = ?1
           AND strategy = 'mert'
           AND recommended_track_id NOT IN ({exclude_csv})
         ORDER BY rank
         LIMIT ?2"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![seed_track_id, limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}
```

- [ ] **Step 2: Update IndexerHandle in lib.rs**

In `src-tauri/crates/library-indexer/src/lib.rs`, update the `insert_play_event` method signature to accept an optional QdrantClient:

Find the existing `insert_play_event` method (around line 235-244) and replace with:

```rust
pub fn insert_play_event(
    &self,
    qdrant: Option<&QdrantClient>,
    track_id: i64,
    origin: &str,
    started_at: &str,
    ended_at: Option<&str>,
    end_position_ms: Option<i64>,
    duration_ms: i64,
) -> Result<(), IndexerError> {
    self.inner.pool.with(|conn| {
        play_events::insert_play_event(conn, qdrant, track_id, origin, started_at, ended_at, end_position_ms, duration_ms)
    })
}
```

Update the `behavioral_signals` method to use Qdrant when available, falling back to SQLite:

```rust
pub fn behavioral_signals(&self, qdrant: Option<&QdrantClient>) -> Result<(Vec<i64>, Vec<i64>), IndexerError> {
    if let Some(client) = qdrant {
        return client.behavioral_signals();
    }
    // Fallback to SQLite (legacy)
    self.inner.pool.with(|conn| {
        let mut pos_stmt = conn.prepare(
            "SELECT DISTINCT track_id FROM play_events
             WHERE completed = 1 AND origin IN ('manual', 'autoplay')
             ORDER BY started_at DESC LIMIT 50",
        )?;
        let positives: Vec<i64> = pos_stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let mut neg_stmt = conn.prepare(
            "SELECT DISTINCT track_id FROM play_events
             WHERE completed = 0
               AND end_position_ms IS NOT NULL
               AND end_position_ms < 5000
               AND origin != 'album_seq'
             ORDER BY started_at DESC LIMIT 20",
        )?;
        let negatives: Vec<i64> = neg_stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok((positives, negatives))
    })
}
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compilation errors in `src-tauri/src/lib.rs` (callers not updated yet — expected, fixed in Task 4)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/library-indexer/src/play_events.rs src-tauri/crates/library-indexer/src/lib.rs
git commit -m "feat(play_events): dual-write to Qdrant + SQLite, Qdrant-first behavioral_signals"
```

---

### Task 4: Update callers in src-tauri/src/lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update behavioral_signals() call in lib_autoplay_next**

At line 251, change:

```rust
match lib.handle.behavioral_signals() {
```

to:

```rust
match lib.handle.behavioral_signals(qdrant.0.as_ref()) {
```

- [ ] **Step 2: Update insert_play_event call in TrackEnded handler**

At line 1559, change:

```rust
if let Err(e) = indexer.insert_play_event(
    track_id,
    &origin,
    &started_at,
    Some(&ended_at),
    end_pos,
    duration,
) {
```

to:

```rust
if let Err(e) = indexer.insert_play_event(
    qdrant_for_events.as_ref(),
    track_id,
    &origin,
    &started_at,
    Some(&ended_at),
    end_pos,
    duration,
) {
```

Note: `qdrant_for_events` needs to be captured before the event loop. In the setup section where `event_loop` is called (around line 1452), we need to pass the QdrantClient into the event loop. Find where `event_loop` is defined and add a parameter:

In the `event_loop` function signature (line 1452-1461), add parameter:

```rust
qdrant_for_events: &Option<QdrantClient>,
```

And at the call site, pass `&qdrant_client_opt` (the Option<QdrantClient> before it's managed).

- [ ] **Step 3: Add ensure_play_events_collection to startup**

After line 1429 (`ensure_collection()` call), add:

```rust
if let Err(e) = qdrant_client.ensure_play_events_collection() {
    tracing::warn!(?e, "failed to ensure play_events collection");
}
```

- [ ] **Step 4: Verify full compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles without errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: wire Qdrant play_events into TrackEnded handler and autoplay"
```

---

### Task 5: Test end-to-end

**Files:** None (manual verification)

- [ ] **Step 1: Build and run the app**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: successful build

- [ ] **Step 2: Verify play_events collection is created**

After app startup, check Qdrant:

```bash
curl -s http://localhost:6333/collections/play_events | jq '.result.status'
```

Expected: `"green"`

- [ ] **Step 3: Play a track, verify event is inserted**

Play a track in the app, then:

```bash
curl -s -X POST http://localhost:6333/collections/play_events/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit": 5, "with_payload": true}' | jq '.result.points[0].payload'
```

Expected: JSON with `track_id`, `origin`, `started_at`, `listen_pct` fields

- [ ] **Step 4: Verify behavioral_signals uses Qdrant**

After a few plays/skips, trigger autoplay and check logs for:
`"autoplay: Qdrant recommendations"` (not falling through to Layer 2/3/4)

- [ ] **Step 5: Commit (if any log/debug adjustments needed)**

```bash
git add -A
git commit -m "fix: adjustments from e2e testing of play_events Qdrant integration"
```

---

## Post-Implementation Notes

- SQLite `play_events` table remains for the History view (read-only). Can be removed in a future cleanup once History view reads from Qdrant too.
- The SQLite fallback in `behavioral_signals()` ensures the app works without Qdrant (graceful degradation).
- Future: add exclusion logic (skip_streak >= 3 → `must_not` filter in Recommend call).
