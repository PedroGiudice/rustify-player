//! REST client for the Qdrant vector database.
//!
//! Wraps the Qdrant HTTP API (v1.17+) for the `rustify_tracks` collection,
//! which stores MERT-768 named vectors for similarity-based recommendations.
//!
//! The collection uses a single named vector `"mert"` with cosine distance.
//! Point IDs are track IDs from the SQLite library database (integers).
//!
//! All methods are synchronous and blocking — Qdrant calls happen on the
//! embedding worker thread, never on the main thread.

use crate::error::IndexerError;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

/// Name of the Qdrant collection.
const COLLECTION: &str = "rustify_tracks";

/// Named vector identifiers. Must match the collection schema.
const VEC_MERT: &str = "mert";
const VEC_LYRICS: &str = "lyrics";

/// MERT-v1-95M output dimensionality.
const MERT_DIM: usize = 768;

/// BGE-M3 output dimensionality for lyrics embeddings.
const LYRICS_DIM: usize = 1024;

/// Synchronous HTTP client for the Qdrant REST API.
///
/// Cheap to clone — the inner `ureq::Agent` shares connection pools via `Arc`.
#[derive(Clone, Debug)]
pub struct QdrantClient {
    agent: ureq::Agent,
    base_url: String,
}

impl QdrantClient {
    /// Construct a client pointing at `base_url`
    /// (e.g. `"http://localhost:6333"`).
    ///
    /// Trailing slashes are stripped.
    pub fn new(base_url: impl Into<String>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(3))
            .timeout_read(Duration::from_secs(30))
            .build();
        Self {
            agent,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// Returns `true` if Qdrant is reachable and healthy.
    ///
    /// Uses the `/healthz` endpoint; a non-200 or connection failure returns
    /// `false` without propagating an error — callers use this as a quick
    /// gate before dispatching work.
    pub fn is_healthy(&self) -> bool {
        self.agent
            .get(&format!("{}/healthz", self.base_url))
            .call()
            .is_ok()
    }

    /// Ensure the `rustify_tracks` collection exists with the full schema
    /// (named vectors: "mert" 768d + "lyrics" 1024d, both cosine).
    ///
    /// If the collection exists but is missing the "lyrics" vector (older
    /// schema), it is deleted and recreated. Data is re-synced on next startup.
    pub fn ensure_collection(&self) -> Result<(), IndexerError> {
        let url = format!("{}/collections/{COLLECTION}", self.base_url);

        match self.agent.get(&url).call() {
            Ok(resp) => {
                let info: Value = resp.into_json()
                    .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;
                let vectors = &info["result"]["config"]["params"]["vectors"];
                if vectors.get(VEC_LYRICS).is_some() {
                    return Ok(());
                }
                tracing::info!("Qdrant collection missing 'lyrics' vector — recreating");
                let _ = self.agent.delete(&url).call();
            }
            Err(ureq::Error::Status(404, _)) => {}
            Err(e) => {
                return Err(IndexerError::Embedding(format!(
                    "qdrant get collection: {e}"
                )));
            }
        }

        let body = json!({
            "vectors": {
                VEC_MERT: {
                    "size": MERT_DIM,
                    "distance": "Cosine"
                },
                VEC_LYRICS: {
                    "size": LYRICS_DIM,
                    "distance": "Cosine"
                }
            }
        });

        self.agent
            .put(&url)
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant create collection: {e}")))?;

        Ok(())
    }

    /// Returns the number of points currently stored in the collection.
    ///
    /// Returns `0` if the `points_count` field is absent from the response.
    pub fn collection_point_count(&self) -> Result<u64, IndexerError> {
        let url = format!("{}/collections/{COLLECTION}", self.base_url);
        let resp: Value = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| IndexerError::Embedding(format!("qdrant collection info: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        Ok(resp["result"]["points_count"].as_u64().unwrap_or(0))
    }

    /// Scroll through all point IDs in the collection.
    ///
    /// Uses pagination (1 000 IDs per page) until `next_page_offset` is null.
    /// Returns a flat `Vec<i64>` of all track IDs present in Qdrant, useful
    /// for diffing against the SQLite library to find tracks that need
    /// embedding or have been removed.
    pub fn scroll_ids(&self) -> Result<Vec<i64>, IndexerError> {
        let mut all_ids: Vec<i64> = Vec::new();
        let mut offset: Option<Value> = None;

        loop {
            let mut body = json!({
                "limit": 1000,
                "with_payload": false,
                "with_vector": false
            });
            if let Some(ref off) = offset {
                body["offset"] = off.clone();
            }

            let resp: Value = self
                .agent
                .post(&format!(
                    "{}/collections/{COLLECTION}/points/scroll",
                    self.base_url
                ))
                .send_json(&body)
                .map_err(|e| IndexerError::Embedding(format!("qdrant scroll: {e}")))?
                .into_json()
                .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

            if let Some(points) = resp["result"]["points"].as_array() {
                for p in points {
                    if let Some(id) = p["id"].as_i64() {
                        all_ids.push(id);
                    }
                }
            }

            match resp["result"].get("next_page_offset") {
                Some(Value::Null) | None => break,
                Some(v) => offset = Some(v.clone()),
            }
        }

        Ok(all_ids)
    }

    /// Upsert a batch of points into the collection.
    ///
    /// Each entry is `(track_id, mert_vector, payload)` where:
    /// - `track_id` is the SQLite row ID (used as the Qdrant point ID).
    /// - `mert_vector` must have exactly 768 elements.
    /// - `payload` is arbitrary JSON metadata (title, artist, etc.).
    ///
    /// A no-op if `points` is empty.
    pub fn upsert_batch(&self, points: &[(i64, &[f32], Value)]) -> Result<(), IndexerError> {
        if points.is_empty() {
            return Ok(());
        }

        let pts: Vec<Value> = points
            .iter()
            .map(|(id, vec, payload)| {
                json!({
                    "id": id,
                    "vector": { VEC_MERT: vec },
                    "payload": payload
                })
            })
            .collect();

        let body = json!({ "points": pts });

        self.agent
            .put(&format!(
                "{}/collections/{COLLECTION}/points",
                self.base_url
            ))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant upsert: {e}")))?;

        Ok(())
    }

    /// Upsert lyrics embeddings for existing points.
    /// Updates only the "lyrics" named vector — other vectors and payload untouched.
    pub fn upsert_lyrics_batch(&self, points: &[(i64, &[f32])]) -> Result<(), IndexerError> {
        if points.is_empty() {
            return Ok(());
        }
        let pts: Vec<Value> = points
            .iter()
            .map(|(id, vec)| {
                json!({
                    "id": id,
                    "vector": { VEC_LYRICS: vec }
                })
            })
            .collect();
        let body = json!({ "points": pts });
        self.agent
            .put(&format!("{}/collections/{COLLECTION}/points", self.base_url))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant upsert lyrics: {e}")))?;
        Ok(())
    }

    /// Query recommendations via the Qdrant Recommendations API.
    ///
    /// Uses the `/points/query` endpoint (Qdrant v1.10+) with the
    /// `{"query": {"recommend": {"positive": [...], "negative": [...]}}}` form.
    ///
    /// Returns `Vec<(point_id, score)>` ordered by descending relevance score.
    /// Returns an empty vec when `positive_ids` is empty (nothing to anchor on).
    pub fn recommend(
        &self,
        positive_ids: &[i64],
        negative_ids: &[i64],
        limit: usize,
    ) -> Result<Vec<(i64, f64)>, IndexerError> {
        if positive_ids.is_empty() {
            return Ok(vec![]);
        }

        let mut recommend = json!({
            "positive": positive_ids
        });
        if !negative_ids.is_empty() {
            recommend["negative"] = json!(negative_ids);
        }

        let body = json!({
            "query": { "recommend": recommend },
            "using": VEC_MERT,
            "limit": limit,
            "with_payload": false
        });

        let resp: Value = self
            .agent
            .post(&format!(
                "{}/collections/{COLLECTION}/points/query",
                self.base_url
            ))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant recommend: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        let mut results = Vec::new();
        if let Some(points) = resp["result"]["points"].as_array() {
            for p in points {
                if let (Some(id), Some(score)) = (p["id"].as_i64(), p["score"].as_f64()) {
                    results.push((id, score));
                }
            }
        }

        Ok(results)
    }

    /// Sync all tracks with MERT embeddings from SQLite to Qdrant.
    ///
    /// Incremental: fetches all point IDs already present in Qdrant and skips
    /// those, so repeated calls are cheap. Upserts in batches of 100.
    ///
    /// Returns the number of points actually upserted.
    pub fn sync_embeddings(&self, conn: &Connection) -> Result<usize, IndexerError> {
        self.ensure_collection()?;

        let existing: HashSet<i64> = self.scroll_ids()?.into_iter().collect();

        let mut stmt = conn.prepare(
            "SELECT t.id, t.title, t.duration_ms, t.embedding,
                    a.name, g.name
             FROM tracks t
             LEFT JOIN artists a ON t.artist_id = a.id
             LEFT JOIN genres g ON t.genre_id = g.id
             WHERE t.embedding_status = 'done' AND t.embedding IS NOT NULL",
        )?;

        let rows: Vec<(i64, String, i64, Vec<u8>, Option<String>, Option<String>)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let new_rows: Vec<_> = rows
            .into_iter()
            .filter(|(id, ..)| !existing.contains(id))
            .collect();

        if new_rows.is_empty() {
            return Ok(0);
        }

        let mut total = 0usize;
        for chunk in new_rows.chunks(100) {
            let mut points: Vec<(i64, Vec<f32>, Value)> = Vec::new();
            for (id, title, duration_ms, embedding_blob, artist, genre) in chunk {
                let vec = bytes_to_f32(embedding_blob);
                if vec.len() != MERT_DIM {
                    tracing::warn!(
                        track_id = id,
                        got = vec.len(),
                        expected = MERT_DIM,
                        "skipping track: unexpected embedding dimension"
                    );
                    continue;
                }
                let payload = json!({
                    "title": title,
                    "artist": artist.as_deref().unwrap_or(""),
                    "genre": genre.as_deref().unwrap_or(""),
                    "duration_ms": duration_ms,
                });
                points.push((*id, vec, payload));
            }

            let refs: Vec<(i64, &[f32], Value)> = points
                .iter()
                .map(|(id, vec, payload)| (*id, vec.as_slice(), payload.clone()))
                .collect();

            self.upsert_batch(&refs)?;
            total += refs.len();
        }

        Ok(total)
    }
    /// Embed lyrics via TEI BGE-M3 and upsert to Qdrant as "lyrics" named vector.
    /// Incremental: skips tracks that already have a lyrics vector in Qdrant.
    pub fn sync_lyrics(
        &self,
        conn: &Connection,
        lyrics_client: &crate::embed_client::LyricsEmbedClient,
    ) -> Result<usize, IndexerError> {
        self.ensure_collection()?;

        // Scroll existing points and check which have lyrics vectors
        let mut has_lyrics: HashSet<i64> = HashSet::new();
        let mut offset: Option<Value> = None;
        loop {
            let mut body = json!({
                "limit": 1000,
                "with_payload": false,
                "with_vector": [VEC_LYRICS]
            });
            if let Some(off) = &offset {
                body["offset"] = off.clone();
            }
            let resp: Value = self.agent
                .post(&format!("{}/collections/{COLLECTION}/points/scroll", self.base_url))
                .send_json(&body)
                .map_err(|e| IndexerError::Embedding(format!("qdrant scroll: {e}")))?
                .into_json()
                .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;
            if let Some(points) = resp["result"]["points"].as_array() {
                for p in points {
                    let vec = &p["vector"][VEC_LYRICS];
                    if vec.is_array() && !vec.as_array().unwrap().is_empty() {
                        if let Some(id) = p["id"].as_i64() {
                            has_lyrics.insert(id);
                        }
                    }
                }
            }
            match resp["result"].get("next_page_offset") {
                Some(Value::Null) | None => break,
                Some(v) => offset = Some(v.clone()),
            }
        }

        // Get tracks with lyrics from SQLite (embedded text or LRC sidecar)
        let mut stmt = conn.prepare(
            "SELECT id, embedded_lyrics, lrc_path FROM tracks
             WHERE embedded_lyrics IS NOT NULL AND LENGTH(embedded_lyrics) > 20
                OR lrc_path IS NOT NULL"
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let embedded: Option<String> = row.get(1)?;
                let lrc_path: Option<String> = row.get(2)?;
                // Prefer embedded_lyrics; fall back to LRC sidecar text
                let text = if let Some(ref e) = embedded {
                    if e.len() > 20 { Some(e.clone()) } else { None }
                } else {
                    None
                };
                let text = text.or_else(|| {
                    lrc_path.and_then(|p| {
                        let path = std::path::Path::new(&p);
                        crate::lyrics::parse_lrc_file(path).ok().map(|lines| {
                            lines.iter()
                                .filter(|l| !l.header)
                                .map(|l| l.line.as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                    })
                    .filter(|t| t.len() > 20)
                });
                Ok(text.map(|t| (id, t)))
            })?
            .filter_map(|r| r.ok().flatten())
            .collect::<Vec<(i64, String)>>();

        let new_rows: Vec<_> = rows.into_iter()
            .filter(|(id, _)| !has_lyrics.contains(id))
            .collect();

        if new_rows.is_empty() {
            return Ok(0);
        }

        tracing::info!(count = new_rows.len(), "embedding lyrics via TEI BGE-M3");
        let mut total = 0;
        for chunk in new_rows.chunks(50) {
            let mut points: Vec<(i64, Vec<f32>)> = Vec::new();
            for (id, lyrics) in chunk {
                match lyrics_client.embed_text(lyrics) {
                    Ok(vec) => points.push((*id, vec)),
                    Err(e) => {
                        tracing::warn!(track_id = id, ?e, "lyrics embed failed, skipping");
                    }
                }
            }
            let refs: Vec<(i64, &[f32])> = points.iter()
                .map(|(id, vec)| (*id, vec.as_slice()))
                .collect();
            self.upsert_lyrics_batch(&refs)?;
            total += refs.len();
        }

        Ok(total)
    }
}

/// Convert a little-endian `f32` byte blob (as stored in SQLite) to a vector
/// of floats. Trailing bytes that don't form a complete `f32` are silently
/// discarded.
fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
