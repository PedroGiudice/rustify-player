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
use serde_json::{json, Value};
use std::time::Duration;

/// Name of the Qdrant collection.
const COLLECTION: &str = "rustify_tracks";

/// Named vector identifier. Must match the collection schema.
const VECTOR_NAME: &str = "mert";

/// MERT-v1-95M output dimensionality.
const VECTOR_SIZE: usize = 768;

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

    /// Ensure the `rustify_tracks` collection exists with the correct schema.
    ///
    /// - If the collection already exists, returns `Ok(())` immediately.
    /// - If it does not exist (404), creates it with a single named vector
    ///   `"mert"` of size 768 with cosine distance.
    /// - Any other HTTP error is surfaced as [`IndexerError::Embedding`].
    pub fn ensure_collection(&self) -> Result<(), IndexerError> {
        let url = format!("{}/collections/{COLLECTION}", self.base_url);

        match self.agent.get(&url).call() {
            Ok(_) => return Ok(()),
            Err(ureq::Error::Status(404, _)) => {}
            Err(e) => {
                return Err(IndexerError::Embedding(format!(
                    "qdrant get collection: {e}"
                )));
            }
        }

        let body = json!({
            "vectors": {
                VECTOR_NAME: {
                    "size": VECTOR_SIZE,
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
                    "vector": { VECTOR_NAME: vec },
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
            "using": VECTOR_NAME,
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
}
