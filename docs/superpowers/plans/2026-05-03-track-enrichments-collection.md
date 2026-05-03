# Track Enrichments Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move user/enrichment data (play_count, liked_at, last_played, dominant_color, mood_tags, activity_tags, energy, valence) out of `rustify_tracks` into a separate `track_enrichments` Qdrant collection so library rescans never destroy it.

**Architecture:** New collection `track_enrichments` with dummy 1-d vectors (Qdrant requirement), same point IDs as `rustify_tracks`. All enrichment reads/writes target this collection. `payload_to_track()` merges data from both collections. Pipeline payload stops including enrichment fields.

**Tech Stack:** Rust, Qdrant REST API (via ureq), serde_json

**QDRANT UNCERTAINTIES TO VERIFY:**
- [ ] **Q1:** Does `scroll` with `order_by` work on a collection with dummy 1-d vectors? (We use `order_by: last_played` in list_history and `order_by: liked_at` in list_liked.) If not, we need to sort client-side.
- [ ] **Q2:** Can `set_payload` create a point that doesn't exist yet? Or do we need to `upsert` first with a dummy vector? (Relevant for new tracks that have no enrichment yet when `record_play` is called.)

These must be checked via Qdrant docs or tested before Task 3.

---

### Task 1: Add `ensure_enrichments_collection` to QdrantClient

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/qdrant_client.rs`

- [ ] **Step 1: Add the ENRICHMENTS_COLLECTION constant**

After the existing `PLAY_EVENTS_COLLECTION` constant (line 145):

```rust
const ENRICHMENTS_COLLECTION: &str = "track_enrichments";
```

- [ ] **Step 2: Add `ensure_enrichments_collection` method**

Add after `ensure_play_events_collection` method (after line ~800). Follow the same pattern:

```rust
    pub fn ensure_enrichments_collection(&self) -> Result<(), IndexerError> {
        let url = format!("{}/collections/{ENRICHMENTS_COLLECTION}", self.base_url);

        match self.agent.get(&url).call() {
            Ok(_) => {
                self.create_enrichment_indices()?;
                return Ok(());
            }
            Err(ureq::Error::Status(404, _)) => {}
            Err(e) => {
                return Err(IndexerError::Embedding(format!(
                    "qdrant get enrichments collection: {e}"
                )));
            }
        }

        let body = json!({
            "vectors": {
                "size": 1,
                "distance": "Cosine"
            }
        });

        self.agent
            .put(&url)
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!(
                "qdrant create enrichments collection: {e}"
            )))?;

        self.create_enrichment_indices()?;
        Ok(())
    }

    fn create_enrichment_indices(&self) -> Result<(), IndexerError> {
        let indices: Vec<(&str, Value)> = vec![
            ("play_count", json!({"type": "integer"})),
            ("last_played", json!({"type": "integer"})),
            ("liked_at", json!({"type": "integer"})),
            ("mood_tags", json!({"type": "keyword"})),
            ("activity_tags", json!({"type": "keyword"})),
            ("energy", json!({"type": "float"})),
            ("valence", json!({"type": "float"})),
        ];

        for (field, schema) in &indices {
            let url = format!("{}/collections/{ENRICHMENTS_COLLECTION}/index", self.base_url);
            let body = json!({
                "field_name": field,
                "field_schema": schema
            });
            match self.agent.put(&url).send_json(&body) {
                Ok(_) | Err(ureq::Error::Status(409, _)) => {}
                Err(e) => {
                    return Err(IndexerError::Embedding(format!(
                        "qdrant create enrichment index {field}: {e}"
                    )));
                }
            }
        }
        Ok(())
    }
```

- [ ] **Step 3: Call it from `Indexer::open`**

In `src-tauri/crates/library-indexer/src/lib.rs`, line 65, after `ensure_play_events_collection`:

```rust
        client.ensure_play_events_collection()?;
        client.ensure_enrichments_collection()?;
```

- [ ] **Step 4: `cargo check`**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: compiles clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/library-indexer/src/qdrant_client.rs src-tauri/crates/library-indexer/src/lib.rs
git commit -m "feat(indexer): add track_enrichments collection with ensure + indices"
```

---

### Task 2: Add enrichment read/write methods to QdrantClient

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/qdrant_client.rs`

- [ ] **Step 1: Add `get_enrichment` method**

Reads enrichment payload for a single track. Returns empty JSON object if point doesn't exist.

```rust
    pub fn get_enrichment(&self, track_id: u64) -> Result<Value, IndexerError> {
        let url = format!(
            "{}/collections/{ENRICHMENTS_COLLECTION}/points/{track_id}",
            self.base_url
        );
        match self.agent.get(&url).call() {
            Ok(resp) => {
                let data: Value = resp
                    .into_json()
                    .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;
                Ok(data["result"]["payload"].clone())
            }
            Err(ureq::Error::Status(404, _)) => Ok(json!({})),
            Err(e) => Err(IndexerError::Embedding(format!("qdrant get enrichment: {e}"))),
        }
    }
```

- [ ] **Step 2: Add `set_enrichment` method**

Upserts a point in the enrichments collection with the given payload. Uses `upsert` (PUT /points) to ensure the point exists, since `set_payload` may not create new points. (VERIFY Q2 — if set_payload can create, simplify to set_payload.)

```rust
    pub fn set_enrichment(&self, track_id: u64, payload: Value) -> Result<(), IndexerError> {
        let body = json!({
            "points": [{
                "id": track_id,
                "vector": [0.0_f32],
                "payload": payload
            }]
        });
        self.agent
            .put(&format!("{}/collections/{ENRICHMENTS_COLLECTION}/points", self.base_url))
            .query("wait", "true")
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant set enrichment: {e}")))?;
        Ok(())
    }
```

- [ ] **Step 3: Add `merge_enrichment` method**

Reads existing enrichment, merges with new fields, writes back. Used by `record_play` which needs to increment play_count.

```rust
    pub fn merge_enrichment(&self, track_id: u64, updates: Value) -> Result<Value, IndexerError> {
        let mut existing = self.get_enrichment(track_id)?;
        if let (Some(base), Some(patch)) = (existing.as_object_mut(), updates.as_object()) {
            for (k, v) in patch {
                base.insert(k.clone(), v.clone());
            }
        }
        self.set_enrichment(track_id, existing.clone())?;
        Ok(existing)
    }
```

- [ ] **Step 4: Add `scroll_enrichments` method**

For list_history and list_liked which need to scroll the enrichments collection with filter+ordering, then return IDs.

```rust
    pub fn scroll_enrichments(
        &self,
        filter: Option<Value>,
        order_by: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(u64, Value)>, IndexerError> {
        let mut body = json!({
            "limit": limit,
            "with_payload": true,
            "with_vector": false
        });
        if let Some(f) = filter {
            body["filter"] = f;
        }
        if let Some(key) = order_by {
            body["order_by"] = json!({ "key": key, "direction": "desc" });
        }

        let resp: Value = self
            .agent
            .post(&format!("{}/collections/{ENRICHMENTS_COLLECTION}/points/scroll", self.base_url))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant scroll enrichments: {e}")))?
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

- [ ] **Step 5: Add `mood_search_enrichments` method**

Moves the mood_search filter logic to target enrichments collection. Returns track IDs.

```rust
    pub fn mood_search_enrichments(&self, filters: &MoodFilters, limit: usize) -> Result<Vec<i64>, IndexerError> {
        let mut must = Vec::new();

        for tag in &filters.mood_tags {
            must.push(json!({"key": "mood_tags", "match": {"value": tag}}));
        }
        for tag in &filters.activity_tags {
            must.push(json!({"key": "activity_tags", "match": {"value": tag}}));
        }
        if let Some(genre) = &filters.genre {
            // genre lives in rustify_tracks, not enrichments — skip here
            // TODO: cross-collection genre filter requires two-pass query
            let _ = genre;
        }
        if let Some(min) = filters.energy_min {
            must.push(json!({"key": "energy", "range": {"gte": min}}));
        }
        if let Some(max) = filters.energy_max {
            must.push(json!({"key": "energy", "range": {"lte": max}}));
        }
        if let Some(min) = filters.valence_min {
            must.push(json!({"key": "valence", "range": {"gte": min}}));
        }
        if let Some(max) = filters.valence_max {
            must.push(json!({"key": "valence", "range": {"lte": max}}));
        }

        if must.is_empty() {
            return Ok(Vec::new());
        }

        let body = json!({
            "filter": {"must": must},
            "limit": limit,
            "with_payload": false,
            "with_vector": false
        });

        let resp: Value = self
            .agent
            .post(&format!("{}/collections/{ENRICHMENTS_COLLECTION}/points/scroll", self.base_url))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant mood search enrichments: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        let mut ids = Vec::new();
        if let Some(points) = resp["result"]["points"].as_array() {
            for p in points {
                if let Some(id) = p["id"].as_i64() {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
    }
```

**NOTE:** `genre` filter is skipped here because genre lives in `rustify_tracks`. If the mood query includes a genre, it needs a two-pass approach: first get IDs from enrichments (mood/energy/valence), then filter those IDs against rustify_tracks for genre. This is acceptable for now — most mood queries won't combine genre+mood. Log as future improvement.

- [ ] **Step 6: `cargo check`**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/library-indexer/src/qdrant_client.rs
git commit -m "feat(indexer): add enrichment CRUD + scroll + mood_search methods"
```

---

### Task 3: Verify Qdrant uncertainties (Q1 & Q2)

**Files:** None (research task)

- [ ] **Step 1: Check Q1 — order_by on dummy-vector collection**

Search Qdrant docs for whether `order_by` in scroll requires specific vector configuration or just a payload index. Test empirically on cmr-auto if docs are unclear:

```bash
# Create test, set a payload, try scroll with order_by
ssh cmr-auto@100.102.249.9 "curl -s -X POST http://localhost:6333/collections/track_enrichments/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{\"limit\": 1, \"order_by\": {\"key\": \"last_played\", \"direction\": \"desc\"}}'"
```

If it fails, update `scroll_enrichments` to not use `order_by` and sort results client-side in Rust.

- [ ] **Step 2: Check Q2 — set_payload on nonexistent points**

```bash
# Try set_payload on a point ID that doesn't exist in track_enrichments
ssh cmr-auto@100.102.249.9 "curl -s -X POST http://localhost:6333/collections/track_enrichments/points/payload \
  -H 'Content-Type: application/json' \
  -d '{\"payload\": {\"test\": 1}, \"points\": [999999999]}'"
```

If it silently succeeds (creates the point), we can simplify `set_enrichment` to use `set_payload` instead of full upsert. If it fails or is a no-op, keep the upsert approach.

- [ ] **Step 3: Document findings and adjust code if needed**

Update Task 2 methods based on findings. Commit any adjustments.

---

### Task 4: Migrate query.rs functions to use enrichments collection

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/query.rs`

- [ ] **Step 1: Add `resolve_tracks_with_enrichments` helper**

At the top of query.rs, after `payload_to_track`. This function takes a list of `(track_id, enrichment_payload)` pairs, fetches the track payloads from rustify_tracks, and merges them into Track structs.

```rust
fn resolve_tracks_with_enrichments(
    client: &QdrantClient,
    enriched: &[(u64, Value)],
) -> Vec<Track> {
    let mut tracks = Vec::new();
    for (id, enr) in enriched {
        if let Ok(Some(point)) = client.get_point(*id) {
            let payload = &point["payload"];
            let mut track = payload_to_track(*id, payload);
            // Overlay enrichment fields
            track.play_count = enr["play_count"].as_u64().unwrap_or(0) as u32;
            track.last_played = enr["last_played"].as_i64();
            track.liked_at = enr["liked_at"].as_i64();
            tracks.push(track);
        }
    }
    tracks
}
```

- [ ] **Step 2: Migrate `record_play`**

Change from `set_payload` on rustify_tracks to `merge_enrichment` on track_enrichments:

```rust
pub fn record_play(client: &QdrantClient, track_id: u64) -> Result<(), IndexerError> {
    let existing = client.get_enrichment(track_id)?;
    let current_count = existing["play_count"].as_u64().unwrap_or(0);
    let now = unix_now();

    client.set_enrichment(track_id, json!({
        "play_count": current_count + 1,
        "last_played": now
    }))
}
```

- [ ] **Step 3: Migrate `list_history`**

Scroll enrichments collection instead of rustify_tracks:

```rust
pub fn list_history(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "last_played", "range": {"gt": 0}}]
    });
    let enriched = client.scroll_enrichments(Some(filter), Some("last_played"), limit)?;
    Ok(resolve_tracks_with_enrichments(client, &enriched))
}
```

- [ ] **Step 4: Migrate `toggle_like`, `is_liked`, `list_liked`**

```rust
pub fn toggle_like(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    let existing = client.get_enrichment(track_id)?;
    let currently_liked = existing["liked_at"].as_i64().is_some();

    if currently_liked {
        client.set_enrichment(track_id, json!({"liked_at": null}))?;
        Ok(false)
    } else {
        let now = unix_now();
        client.set_enrichment(track_id, json!({"liked_at": now}))?;
        Ok(true)
    }
}

pub fn is_liked(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    let enr = client.get_enrichment(track_id)?;
    Ok(enr["liked_at"].as_i64().is_some())
}

pub fn list_liked(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "liked_at", "range": {"gt": 0}}]
    });
    let enriched = client.scroll_enrichments(Some(filter), Some("liked_at"), limit)?;
    Ok(resolve_tracks_with_enrichments(client, &enriched))
}
```

- [ ] **Step 5: Update `payload_to_track` to stop reading enrichment fields from track payload**

In `payload_to_track`, change the enrichment field lines to always use defaults (they'll be overlaid by the caller when needed):

```rust
        play_count: p["play_count"].as_u64().unwrap_or(0) as u32,
        last_played: p["last_played"].as_i64(),
        liked_at: p["liked_at"].as_i64(),
```

Keep these as-is — they read from whatever payload is passed. The enrichment overlay happens in `resolve_tracks_with_enrichments`. This ensures backwards compatibility during migration.

- [ ] **Step 6: `cargo check`**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/library-indexer/src/query.rs
git commit -m "refactor(query): migrate play/like/history/mood to enrichments collection"
```

---

### Task 5: Migrate mood_search and get_track_color in lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/crates/library-indexer/src/qdrant_client.rs` (remove old `mood_search`)

- [ ] **Step 1: Update `lib_mood_search` to use enrichments**

```rust
#[tauri::command]
fn lib_mood_search(
    lib: State<Library>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let client = lib.handle.client();
    let filters = library_indexer::MoodFilters::parse(&query);
    if filters.is_empty() {
        return Ok(Vec::new());
    }

    // If query has genre filter, do two-pass: enrichments first, then filter by genre
    let ids = client.mood_search_enrichments(&filters, limit.unwrap_or(50)).map_err(err)?;

    let mut tracks = Vec::new();
    for track_id in ids {
        if let Ok(Some(mut t)) = lib.handle.track(track_id as u64) {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
            // Genre post-filter (genre lives in rustify_tracks)
            if let Some(ref genre_filter) = filters.genre {
                if let Some(ref track_genre) = t.genre_name {
                    if track_genre != genre_filter {
                        continue;
                    }
                } else {
                    continue;
                }
            }
            tracks.push(t);
        }
    }
    Ok(tracks)
}
```

- [ ] **Step 2: Update `get_track_color` to use enrichments**

```rust
#[tauri::command]
fn get_track_color(lib: State<Library>, track_id: String) -> Result<String, String> {
    let tid = parse_id(&track_id)?;
    let client = lib.handle.client();

    // Read from enrichments collection
    let enr = client.get_enrichment(tid).map_err(err)?;
    if let Some(color) = enr["dominant_color"].as_str().filter(|s| !s.is_empty()) {
        return Ok(color.to_string());
    }

    // Fallback: compute from cached cover
    let payload = client.get_payload(tid as i64).map_err(err)?;
    if let Some(rel) = payload["cover_path"].as_str() {
        let cover_file = lib.cache_dir.join(rel);
        if cover_file.exists() {
            let source = library_indexer::CoverSource::FolderFile(cover_file);
            if let Some(hex) = library_indexer::dominant_color(&source) {
                client.set_enrichment(tid, serde_json::json!({"dominant_color": hex})).ok();
                return Ok(hex);
            }
        }
    }

    Ok(String::new())
}
```

- [ ] **Step 3: Remove old `mood_search` from qdrant_client.rs**

Delete the `mood_search` method (lines ~464-514) since it's replaced by `mood_search_enrichments`.

- [ ] **Step 4: `cargo check`**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/crates/library-indexer/src/qdrant_client.rs
git commit -m "refactor(lib): mood_search and get_track_color use enrichments collection"
```

---

### Task 6: Remove enrichment fields from pipeline payload

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/pipeline.rs`

- [ ] **Step 1: Remove enrichment fields from scan payload**

In `pipeline.rs` around line 390-402, remove these lines from the JSON payload:

```rust
        // REMOVE these lines:
        // "dominant_color": dominant_color,
        // "play_count": 0,
        // "last_played": null,
        // "liked_at": null,
```

Also remove the `dominant_color` variable computation earlier in the function if it exists.

- [ ] **Step 2: `cargo check`**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Fix any compilation errors from removed fields.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/library-indexer/src/pipeline.rs
git commit -m "fix(pipeline): stop writing enrichment fields in scan payload

Enrichment data (play_count, liked_at, last_played, dominant_color)
now lives in track_enrichments collection. Rescan no longer destroys it."
```

---

### Task 7: One-time migration of existing data

**Files:**
- Create: `scripts/migrate-enrichments.py`

This script reads existing enrichment fields from `rustify_tracks` and writes them to `track_enrichments`. Idempotent — safe to run multiple times.

- [ ] **Step 1: Write migration script**

```python
#!/usr/bin/env python3
"""One-time migration: copy enrichment fields from rustify_tracks to track_enrichments.

Idempotent — skips points that already have enrichment data.
Run on the machine where Qdrant is running (cmr-auto).

Usage:
    python3 scripts/migrate-enrichments.py [--qdrant-url http://localhost:6333]
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
        enr = {k: v for k, v in payload.items() if k in FIELDS and v is not None}
        if not enr or enr == {"play_count": 0}:
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
```

- [ ] **Step 2: Commit the script**

```bash
git add scripts/migrate-enrichments.py
git commit -m "chore: add one-time enrichment migration script"
```

- [ ] **Step 3: Run migration on cmr-auto**

```bash
scp scripts/migrate-enrichments.py cmr-auto@100.102.249.9:/tmp/
ssh cmr-auto@100.102.249.9 "python3 /tmp/migrate-enrichments.py"
```

Expected output: `Migrated: ~930, Skipped: ~50`

---

### Task 8: Verify end-to-end

- [ ] **Step 1: `cargo check` full project**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Build and release**

```bash
./scripts/release.sh
```

- [ ] **Step 3: Install on cmr-auto and test**

On cmr-auto:
```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.2.0_amd64.deb
```

**Test checklist:**
- [ ] Play a track → verify play_count increments (check via Qdrant API on track_enrichments)
- [ ] Like a track → verify liked_at set in track_enrichments
- [ ] History view → shows recently played tracks
- [ ] Liked view → shows liked tracks
- [ ] NowPlaying → background changes per album (dominant_color from enrichments)
- [ ] Rescan library → verify enrichment fields survive (play_count, liked_at, dominant_color still in track_enrichments)

- [ ] **Step 4: Final commit if any fixes needed**
