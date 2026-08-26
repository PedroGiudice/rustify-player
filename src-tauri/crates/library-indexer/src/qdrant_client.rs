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
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// Vocabulário canônico de mood — os 24 tokens DE FATO anotados na collection
/// `track_enrichments` (extraídos de todas as 1378 tracks anotadas, 2026-07).
/// Ordem alfabética. `MoodFilters::parse` emite exclusivamente estes tokens
/// (nunca português) — o filtro do Qdrant em `mood_search_enrichments` faz
/// match exato contra o payload, então qualquer divergência de vocabulário
/// retorna 0 resultados silenciosamente.
///
/// "chill", "driving", "focus" e "social" também existem em
/// [`ACTIVITY_VOCAB`] — ver a nota de ambiguidade em `MoodFilters::parse`.
pub const MOOD_VOCAB: &[&str] = &[
    "aggressive",
    "anxious",
    "bittersweet",
    "chill",
    "confident",
    "dark",
    "dreamy",
    "driving",
    "energetic",
    "ethereal",
    "focus",
    "groovy",
    "intense",
    "melancholic",
    "nostalgic",
    "peaceful",
    "playful",
    "raw",
    "rebellious",
    "romantic",
    "sensual",
    "social",
    "triumphant",
    "uplifting",
];

/// Vocabulário canônico de activity — os 14 tokens DE FATO anotados em
/// `track_enrichments`. Mesma fonte e mesma regra de `MOOD_VOCAB`.
pub const ACTIVITY_VOCAB: &[&str] = &[
    "chill",
    "cleaning",
    "commute",
    "cooking",
    "driving",
    "focus",
    "gaming",
    "meditation",
    "party",
    "romance",
    "sleep",
    "social",
    "study",
    "workout",
];

#[derive(Debug, Default)]
pub struct MoodFilters {
    pub mood_tags: Vec<String>,
    pub activity_tags: Vec<String>,
    pub genre: Option<String>,
    pub energy_min: Option<f32>,
    pub energy_max: Option<f32>,
    pub valence_min: Option<f32>,
    pub valence_max: Option<f32>,
}

impl MoodFilters {
    pub fn is_empty(&self) -> bool {
        self.mood_tags.is_empty()
            && self.activity_tags.is_empty()
            && self.genre.is_none()
            && self.energy_min.is_none()
            && self.energy_max.is_none()
            && self.valence_min.is_none()
            && self.valence_max.is_none()
    }

    /// Traduz uma query textual (PT/EN livre) para os tokens EXATOS anotados
    /// em `track_enrichments` ([`MOOD_VOCAB`] / [`ACTIVITY_VOCAB`]).
    ///
    /// Duas camadas, nesta ordem:
    /// 1. **Passthrough canônico**: se o token já é um item do vocabulário,
    ///    ele vira a si mesmo. Checado mood-primeiro — isso é o que resolve
    ///    a ambiguidade dos 4 tokens presentes nos dois vocabulários
    ///    ("chill", "driving", "focus", "social"): digitados direto, caem em
    ///    mood (uso mais comum). Nunca os dois buckets a partir do mesmo
    ///    token.
    /// 2. **Aliases PT/EN**: sinônimos que não são o token canônico. Quando
    ///    o alias é claramente de atividade (ex: "dirigir", "relaxar",
    ///    "trabalhar", "churrasco"), resolve pra activity mesmo que o
    ///    resultado seja um dos 4 tokens ambíguos — a alias explícita vence
    ///    o default de ambiguidade.
    pub fn parse(query: &str) -> Self {
        let q = query.to_lowercase();
        let mut f = MoodFilters::default();

        // Bigrams first (order matters — "road trip" before "road")
        let bigram_map: &[(&str, Box<dyn Fn(&mut MoodFilters)>)] = &[
            ("road trip", Box::new(|f: &mut MoodFilters| f.activity_tags.push("driving".into()))),
            ("hip hop", Box::new(|f: &mut MoodFilters| f.genre = Some("Rap & Hip-Hop".into()))),
            ("hip-hop", Box::new(|f: &mut MoodFilters| f.genre = Some("Rap & Hip-Hop".into()))),
            ("alta energia", Box::new(|f: &mut MoodFilters| f.energy_min = Some(0.7))),
            ("high energy", Box::new(|f: &mut MoodFilters| f.energy_min = Some(0.7))),
            ("baixa energia", Box::new(|f: &mut MoodFilters| f.energy_max = Some(0.3))),
            ("low energy", Box::new(|f: &mut MoodFilters| f.energy_max = Some(0.3))),
            ("funk br", Box::new(|f: &mut MoodFilters| f.genre = Some("Funk Brasileiro".into()))),
            ("funk soul", Box::new(|f: &mut MoodFilters| f.genre = Some("Funk & Soul".into()))),
            ("pra cima", Box::new(|f: &mut MoodFilters| f.valence_min = Some(0.7))),
            ("pra baixo", Box::new(|f: &mut MoodFilters| f.valence_max = Some(0.3))),
        ];

        let mut consumed = q.clone();
        for (bigram, apply) in bigram_map {
            if consumed.contains(bigram) {
                apply(&mut f);
                consumed = consumed.replace(bigram, " ");
            }
        }

        let tokens: Vec<&str> = consumed.split_whitespace().collect();
        for tok in &tokens {
            // Passthrough canônico — mood checado primeiro (resolve os 4
            // tokens ambíguos a favor de mood quando digitados direto).
            if MOOD_VOCAB.contains(tok) {
                f.mood_tags.push((*tok).to_string());
                continue;
            }
            if ACTIVITY_VOCAB.contains(tok) {
                f.activity_tags.push((*tok).to_string());
                continue;
            }

            match *tok {
                // ── Activity aliases → token canônico do ACTIVITY_VOCAB ──
                "malhar" | "treino" | "academia" | "correr" | "run" | "running" => {
                    f.activity_tags.push("workout".into())
                }
                "relaxar" | "relax" | "calmo" | "calma" => f.activity_tags.push("chill".into()),
                "dirigir" | "drive" | "carro" => f.activity_tags.push("driving".into()),
                "estudar" | "foco" => f.activity_tags.push("study".into()),
                "festa" | "dançar" | "dance" | "dancing" => f.activity_tags.push("party".into()),
                "dormir" => f.activity_tags.push("sleep".into()),
                "meditar" => f.activity_tags.push("meditation".into()),
                "churrasco" | "bbq" => f.activity_tags.push("social".into()),
                "cozinhar" => f.activity_tags.push("cooking".into()),
                "trabalhar" | "work" => f.activity_tags.push("focus".into()),
                "limpar" | "faxina" => f.activity_tags.push("cleaning".into()),
                "deslocamento" => f.activity_tags.push("commute".into()),
                "jogar" | "jogos" | "game" | "gamer" => f.activity_tags.push("gaming".into()),
                "date" | "encontro" => f.activity_tags.push("romance".into()),
                // ── Mood aliases → token canônico do MOOD_VOCAB ──────────
                "triste" | "sad" => f.mood_tags.push("melancholic".into()),
                "alegre" | "happy" | "feliz" => f.mood_tags.push("uplifting".into()),
                "animado" | "energia" | "energy" => f.mood_tags.push("energetic".into()),
                "agressivo" | "pesado" | "heavy" => f.mood_tags.push("aggressive".into()),
                "romântico" | "amor" | "love" => f.mood_tags.push("romantic".into()),
                "sombrio" | "misterioso" | "mystery" => f.mood_tags.push("dark".into()),
                "nostálgico" | "nostalgia" => f.mood_tags.push("nostalgic".into()),
                "rebelde" | "rebel" => f.mood_tags.push("rebellious".into()),
                "sexy" => f.mood_tags.push("sensual".into()),
                "empoderador" | "empowering" => f.mood_tags.push("confident".into()),
                "intenso" => f.mood_tags.push("intense".into()),
                "suave" | "soft" => f.mood_tags.push("peaceful".into()),
                "ansioso" => f.mood_tags.push("anxious".into()),
                "agridoce" => f.mood_tags.push("bittersweet".into()),
                "sonhador" => f.mood_tags.push("dreamy".into()),
                "etéreo" | "etereo" => f.mood_tags.push("ethereal".into()),
                "brincalhão" | "brincalhao" => f.mood_tags.push("playful".into()),
                "cru" => f.mood_tags.push("raw".into()),
                "triunfante" => f.mood_tags.push("triumphant".into()),
                // ── Genre (single tokens not caught by bigrams) ──────────
                "funk" => {
                    if f.genre.is_none() {
                        f.genre = Some("Funk Brasileiro".into());
                    }
                }
                "rock" => f.genre = Some("Rock".into()),
                "mpb" => f.genre = Some("MPB".into()),
                "rap" => {
                    if f.genre.is_none() {
                        f.genre = Some("Rap & Hip-Hop".into());
                    }
                }
                "eletrônica" | "eletronica" | "electronic" => f.genre = Some("Eletrônica".into()),
                "soul" => {
                    if f.genre.is_none() {
                        f.genre = Some("Funk & Soul".into());
                    }
                }
                "trance" => f.genre = Some("Trance".into()),
                _ => {}
            }
        }

        // Deduplicate tags
        f.mood_tags.sort();
        f.mood_tags.dedup();
        f.activity_tags.sort();
        f.activity_tags.dedup();

        f
    }
}

/// Name of the Qdrant collection.
const COLLECTION: &str = "rustify_tracks";

/// Named vector identifiers. Must match the collection schema.
const VEC_MERT: &str = "mert";
const VEC_LYRICS: &str = "lyrics";

/// MERT-v1-95M output dimensionality.
const MERT_DIM: usize = 768;

/// BGE-M3 output dimensionality for lyrics embeddings.
const LYRICS_DIM: usize = 1024;

/// Name of the play events collection (payload-only, dummy vectors).
const PLAY_EVENTS_COLLECTION: &str = "play_events";

/// Name of the enrichments collection (mood tags, likes, play counts, etc.).
/// Separated from rustify_tracks so library rescans never destroy user/enrichment data.
const ENRICHMENTS_COLLECTION: &str = "track_enrichments";

/// Versão vigente do ESQUEMA DE SINAL — estampada em todo evento novo como
/// `signal_schema`. Incrementar QUANDO a semântica dos sinais/origins mudar
/// (a v0.2.66 teria sido o corte 2→3); a régua usa este campo no lugar do
/// timestamp hardcoded `V3_CUTOFF` para eventos que o possuem.
pub const SIGNAL_SCHEMA: i64 = 3;

/// Identidade de proveniência estampada em cada evento gravado — qual
/// dispositivo e qual versão do app geraram o ponto. Pré-requisito do sync
/// multi-dispositivo (spec 2026-08-13-event-provenance).
#[derive(Clone, Debug)]
pub struct Provenance {
    pub device_id: String,
    pub app_version: String,
}

/// Desfecho de um evento vindo pelo trilho de sync (CMR-220). Separa o que
/// é ACKÁVEL pelo dispositivo de origem — aplicado, no-op por LWW, ou
/// rejeitado por validação (re-enviar não conserta) — do erro de transporte
/// com o Qdrant, que vai em `Err` e NUNCA pode ser ackado: o receiver
/// responde 503 e o lote volta inteiro no próximo tick (upsert idempotente
/// por uuid, like por LWW — replay é seguro).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncedOutcome {
    Applied,
    /// No-op por last-write-wins: o evento é mais velho que o like vigente.
    /// `current` é o clock vigente (`like_updated_at`, fallback `liked_at`).
    Skipped { current: i64 },
    /// Payload inválido — motivo legível pro log.
    Rejected(String),
}

/// Synchronous HTTP client for the Qdrant REST API.
///
/// Cheap to clone — the inner `ureq::Agent` shares connection pools via `Arc`.
#[derive(Clone, Debug)]
pub struct QdrantClient {
    agent: ureq::Agent,
    base_url: String,
    provenance: Option<Provenance>,
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
            provenance: None,
        }
    }

    /// Attach provenance — every event written afterwards carries
    /// `device_id`/`app_version`. Clients without it (health probe, scripts)
    /// still work; they only stamp `signal_schema`.
    pub fn with_provenance(mut self, provenance: Provenance) -> Self {
        self.provenance = Some(provenance);
        self
    }

    /// Device id vigente, se o client tem provenance anexada.
    pub fn device_id(&self) -> Option<&str> {
        self.provenance.as_ref().map(|p| p.device_id.as_str())
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
                    self.create_payload_indices()?;
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

        self.create_payload_indices()?;

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

    pub fn count_with_filter(&self, filter: Value) -> Result<u64, IndexerError> {
        let url = format!("{}/collections/{COLLECTION}/points/count", self.base_url);
        let body = json!({ "filter": filter, "exact": true });
        let resp: Value = self
            .agent
            .post(&url)
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant count: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;
        Ok(resp["result"]["count"].as_u64().unwrap_or(0))
    }

    /// Scroll through all point IDs in the collection.
    ///
    /// Uses pagination (1 000 IDs per page) until `next_page_offset` is null.
    /// Returns a flat `Vec<u64>` of all track IDs present in Qdrant, useful
    /// for diffing against the SQLite library to find tracks that need
    /// embedding or have been removed.
    pub fn scroll_ids(&self) -> Result<Vec<u64>, IndexerError> {
        let mut all_ids: Vec<u64> = Vec::new();
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
                    if let Some(id) = p["id"].as_u64() {
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
    pub fn upsert_batch(&self, points: &[(u64, &[f32], Value)]) -> Result<(), IndexerError> {
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
    pub fn upsert_lyrics_batch(&self, points: &[(u64, &[f32])]) -> Result<(), IndexerError> {
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
            .put(&format!("{}/collections/{COLLECTION}/points/vectors", self.base_url))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant update lyrics vectors: {e}")))?;
        Ok(())
    }

    /// Query recommendations via the Qdrant Recommendations API.
    ///
    /// Uses the `/points/query` endpoint with `strategy: best_score`
    /// (Qdrant v1.6+): each candidate is scored by its BEST match against
    /// any single positive, instead of by similarity to the AVERAGE of all
    /// positives. The MERT taste space is multi-cluster — averaging an
    /// eclectic history collapses onto the dominant cluster (measured: a
    /// psytrance seed drowned by a rap-heavy history returned 0/15
    /// electronic tracks). With best_score every taste cluster keeps its own
    /// gravity; with a single positive the ordering is identical to average.
    /// Repeating a positive (the old SEED_WEIGHT trick) does NOT change the
    /// max — weighting by repetition is meaningless under this strategy.
    ///
    /// `exclude_ids` is a hard exclusion filter (`must_not has_id`), distinct
    /// from `negative_ids` which penalizes candidates close to a negative
    /// example. Use `exclude_ids` for "don't return these specific points"
    /// (e.g. recently played) and `negative_ids` for "diverge from this taste".
    ///
    /// Returns `Vec<(point_id, score)>` ordered by descending relevance score.
    /// NOTE: best_score values are NOT comparable across queries (and the
    /// MERT space is anisotropic) — treat the result as a RANK, never as an
    /// absolute similarity.
    /// Returns an empty vec when `positive_ids` is empty (nothing to anchor on).
    pub fn recommend(
        &self,
        positive_ids: &[u64],
        negative_ids: &[u64],
        exclude_ids: &[u64],
        limit: usize,
    ) -> Result<Vec<(u64, f64)>, IndexerError> {
        if positive_ids.is_empty() {
            return Ok(vec![]);
        }

        let body = build_recommend_body(positive_ids, negative_ids, exclude_ids, limit);

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
                if let (Some(id), Some(score)) = (p["id"].as_u64(), p["score"].as_f64()) {
                    results.push((id, score));
                }
            }
        }

        Ok(results)
    }

    /// Search tracks by semantic similarity using the lyrics named vector.
    /// Takes a pre-computed query embedding (1024d BGE-M3) and returns
    /// track IDs ordered by descending similarity score.
    pub fn semantic_search(
        &self,
        query_vector: &[f32],
        limit: usize,
    ) -> Result<Vec<(u64, f64)>, IndexerError> {
        let body = json!({
            "query": query_vector,
            "using": VEC_LYRICS,
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
            .map_err(|e| IndexerError::Embedding(format!("qdrant semantic search: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        let mut results = Vec::new();
        if let Some(points) = resp["result"]["points"].as_array() {
            for p in points {
                if let (Some(id), Some(score)) = (p["id"].as_u64(), p["score"].as_f64()) {
                    results.push((id, score));
                }
            }
        }

        Ok(results)
    }

    // mood_search removed — replaced by mood_search_enrichments (targets track_enrichments collection)

    pub fn get_payload(&self, point_id: u64) -> Result<Value, IndexerError> {
        let resp: Value = self
            .agent
            .get(&format!(
                "{}/collections/{COLLECTION}/points/{point_id}",
                self.base_url
            ))
            .call()
            .map_err(|e| IndexerError::Embedding(format!("qdrant get point: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        Ok(resp["result"]["payload"].clone())
    }

    // sync_embeddings removed — pipeline writes directly to Qdrant.
    // ──────────────────────────────────────────────────────────────────────────
    // Full-metadata payload management
    // ──────────────────────────────────────────────────────────────────────────

    /// Create payload indices for full-metadata storage.
    /// Idempotent — Qdrant ignores duplicate index creation (409).
    pub fn create_payload_indices(&self) -> Result<(), IndexerError> {
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
            match self.agent.put(&url).send_json(&body) {
                Ok(_) | Err(ureq::Error::Status(409, _)) => {}
                Err(e) => {
                    return Err(IndexerError::Embedding(format!(
                        "qdrant create index {field}: {e}"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Partial update of payload fields on one or more points.
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

    /// Scroll points with optional filter, ordering, and field selection.
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

    /// Scroll ALL points matching `filter` returning only selected payload fields.
    /// Pages through 1000 at a time until exhausted.
    pub fn scroll_all_with_filter(
        &self,
        filter: Value,
        fields: &[&str],
    ) -> Result<Vec<(u64, Value)>, IndexerError> {
        let mut all: Vec<(u64, Value)> = Vec::new();
        let mut offset: Option<Value> = None;
        let include = json!({ "include": fields });

        loop {
            let mut body = json!({
                "limit": 1000,
                "with_payload": include,
                "with_vector": false,
                "filter": filter,
            });
            if let Some(ref off) = offset {
                body["offset"] = off.clone();
            }

            let resp: Value = self
                .agent
                .post(&format!("{}/collections/{COLLECTION}/points/scroll", self.base_url))
                .send_json(&body)
                .map_err(|e| IndexerError::Embedding(format!("qdrant scroll_filtered: {e}")))?
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

    /// Scroll ALL points returning selected payload fields plus whether each
    /// point already carries the `"lyrics"` named vector.
    ///
    /// Qdrant has no server-side filter for "point lacks a given named vector"
    /// (feature requests qdrant#2737 / qdrant#5264 are still open), so the only
    /// way to know is to request `with_vector: ["lyrics"]` and inspect the
    /// response. We do NOT pull the `mert` vector (768 floats × N points would
    /// bloat the scroll for nothing) — only the presence flag for `lyrics`.
    ///
    /// Returns `(point_id, payload, has_lyrics_vector)`.
    pub fn scroll_all_lyrics_state(
        &self,
        fields: &[&str],
    ) -> Result<Vec<(u64, Value, bool)>, IndexerError> {
        let mut all: Vec<(u64, Value, bool)> = Vec::new();
        let mut offset: Option<Value> = None;
        let include = json!({ "include": fields });

        loop {
            let mut body = json!({
                "limit": 1000,
                "with_payload": include,
                "with_vector": [VEC_LYRICS],
            });
            if let Some(ref off) = offset {
                body["offset"] = off.clone();
            }

            let resp: Value = self
                .agent
                .post(&format!("{}/collections/{COLLECTION}/points/scroll", self.base_url))
                .send_json(&body)
                .map_err(|e| IndexerError::Embedding(format!("qdrant scroll_lyrics: {e}")))?
                .into_json()
                .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

            if let Some(points) = resp["result"]["points"].as_array() {
                for p in points {
                    let id = p["id"].as_u64().unwrap_or(0);
                    let payload = p.get("payload").cloned().unwrap_or(Value::Null);
                    // `vector` chega como {"lyrics": [...]} quando presente; a
                    // chave some (ou o array é vazio) quando o ponto não tem.
                    let has_lyrics = p["vector"][VEC_LYRICS]
                        .as_array()
                        .is_some_and(|v| !v.is_empty());
                    all.push((id, payload, has_lyrics));
                }
            }

            match resp["result"].get("next_page_offset") {
                Some(Value::Null) | None => break,
                Some(v) => offset = Some(v.clone()),
            }
        }

        Ok(all)
    }

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

    /// Scroll ALL points with their FULL payload, paging 1000 at a time.
    ///
    /// Used by client-side search, which needs every field of each `Track`
    /// (to be able to play it) and must be robust against partial full-text
    /// index coverage — Qdrant's `match:{text}` fallback is case-sensitive on
    /// segments that lack the text index, which silently broke the palette.
    pub fn scroll_all_full(&self) -> Result<Vec<(u64, Value)>, IndexerError> {
        let mut all: Vec<(u64, Value)> = Vec::new();
        let mut offset: Option<Value> = None;

        loop {
            let mut body = json!({
                "limit": 1000,
                // Tudo menos `embedded_lyrics` (LRC completo, ~1-4 KB/faixa): a
                // busca só lê title/artist/album + os campos de playback, e este
                // scroll roda no hot path da palette (a cada tecla).
                "with_payload": { "exclude": ["embedded_lyrics"] },
                "with_vector": false
            });
            if let Some(ref off) = offset {
                body["offset"] = off.clone();
            }

            let resp: Value = self
                .agent
                .post(&format!("{}/collections/{COLLECTION}/points/scroll", self.base_url))
                .send_json(&body)
                .map_err(|e| IndexerError::Embedding(format!("qdrant scroll_full: {e}")))?
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

    /// Upsert tracks with full metadata payload and optional MERT vector.
    pub fn upsert_tracks(&self, points: &[(u64, Value, Option<Vec<f32>>)]) -> Result<(), IndexerError> {
        if points.is_empty() {
            return Ok(());
        }
        let zero_vec = vec![0.0_f32; MERT_DIM];
        for chunk in points.chunks(100) {
            let pts: Vec<Value> = chunk.iter().map(|(id, payload, vector)| {
                let mert_vec = vector.as_deref().unwrap_or(&zero_vec);
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

    /// Expose base_url for pipeline embed result upserts.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Raw PUT request (for vector updates from pipeline).
    pub fn raw_put(&self, url: &str, body: &Value) -> Result<(), IndexerError> {
        self.agent
            .put(url)
            .query("wait", "true")
            .send_json(body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant raw_put: {e}")))?;
        Ok(())
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Play Events collection (payload-only, dummy 1-d vector)
    // ──────────────────────────────────────────────────────────────────────────

    /// Ensure the `play_events` collection exists with payload indices.
    ///
    /// Idempotent: safe to call on every startup. Reconciles three states:
    ///   1. Collection absent  → create it, then create indices.
    ///   2. Collection present, indices present  → no-op (409 tolerated).
    ///   3. Collection present, `started_at` index has wrong type (legacy
    ///      `keyword`)  → drop the index, migrate string payloads to int,
    ///      re-create as `integer`. This unblocks `behavioral_signals()`
    ///      which uses `order_by: started_at` (needs a range-capable index).
    pub fn ensure_play_events_collection(&self) -> Result<(), IndexerError> {
        let url = format!(
            "{}/collections/{PLAY_EVENTS_COLLECTION}",
            self.base_url
        );

        let exists = match self.agent.get(&url).call() {
            Ok(_) => true,
            Err(ureq::Error::Status(404, _)) => false,
            Err(e) => {
                return Err(IndexerError::Embedding(format!(
                    "qdrant get play_events collection: {e}"
                )));
            }
        };

        if !exists {
            // Create with dummy 1-d cosine vector (Qdrant requires at least one vector config)
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
                    "qdrant create play_events collection: {e}"
                )))?;
        } else {
            // Upgrade legacy `started_at:keyword` index (incompatible com
            // o order_by usado por behavioral_signals).
            self.upgrade_play_events_started_at_index()?;
            // Sweep idempotente: pega qualquer ponto antigo que ainda
            // tenha started_at como string mesmo após o upgrade do
            // índice. Necessário pra cobrir o caso em que o índice já
            // foi promovido (0.2.27+) mas a migração concorrente
            // deixou 10-20% de pontos pra trás. Custo: 1 scroll de
            // started_at, instantâneo em coleções pequenas.
            self.migrate_started_at_string_to_int()?;
        }

        self.create_play_events_indices()?;

        Ok(())
    }

    /// Create payload indices for `play_events`. Idempotent — 409 means the
    /// index already exists with the same schema, which is the desired state.
    fn create_play_events_indices(&self) -> Result<(), IndexerError> {
        let indices = [
            ("track_id", json!({"type": "integer"})),
            ("listen_pct", json!({"type": "float"})),
            ("started_at", json!({"type": "integer"})),
            ("event_type", json!({"type": "keyword"})),
            ("origin", json!({"type": "keyword"})),
            // context_id (Fase 2 do session-awareness): criado no boot, antes
            // de qualquer ponto ter o campo — cobertura 100% desde o primeiro
            // write, evita o problema de index parcial pós-dados (ver
            // ~/.claude/rules/qdrant-bulk-ops.md).
            ("context_id", json!({"type": "keyword"})),
            // Proveniência (spec 2026-08-13): mesmos motivos do context_id —
            // índice nasce antes do primeiro ponto estampado.
            ("device_id", json!({"type": "keyword"})),
            ("signal_schema", json!({"type": "integer"})),
        ];

        for (field, schema) in &indices {
            let index_url = format!(
                "{}/collections/{PLAY_EVENTS_COLLECTION}/index",
                self.base_url
            );
            let index_body = json!({
                "field_name": field,
                "field_schema": schema
            });
            match self.agent.put(&index_url).send_json(&index_body) {
                Ok(_) | Err(ureq::Error::Status(409, _)) => {}
                Err(e) => {
                    return Err(IndexerError::Embedding(format!(
                        "qdrant create index {field}: {e}"
                    )));
                }
            }
        }

        Ok(())
    }

    /// Detect and repair the legacy `started_at: keyword` index by dropping
    /// the index, coercing string payloads to integer, and letting
    /// `create_play_events_indices` rebuild it as `integer` on the next call.
    ///
    /// No-op when the index is already `integer` or absent.
    fn upgrade_play_events_started_at_index(&self) -> Result<(), IndexerError> {
        let url = format!(
            "{}/collections/{PLAY_EVENTS_COLLECTION}",
            self.base_url
        );
        let info: Value = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| IndexerError::Embedding(format!("qdrant get play_events: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        let data_type = info["result"]["payload_schema"]["started_at"]["data_type"]
            .as_str()
            .map(|s| s.to_lowercase());

        if data_type.as_deref() != Some("keyword") {
            return Ok(());
        }

        tracing::warn!("play_events: legacy started_at:keyword index detected — migrating to integer");

        // Drop the legacy index first; Qdrant rejects creating an index with
        // a different type on top of an existing one.
        let drop_url = format!(
            "{}/collections/{PLAY_EVENTS_COLLECTION}/index/started_at",
            self.base_url
        );
        match self.agent.delete(&drop_url).call() {
            Ok(_) | Err(ureq::Error::Status(404, _)) => {}
            Err(e) => {
                return Err(IndexerError::Embedding(format!(
                    "qdrant drop legacy started_at index: {e}"
                )));
            }
        }

        // Migrate payloads: any point whose `started_at` is a JSON string gets
        // rewritten to its integer parse.
        self.migrate_started_at_string_to_int()?;

        Ok(())
    }

    /// Scroll the `play_events` collection and rewrite any `started_at`
    /// stored as a string into its parsed `i64` value.
    ///
    /// Two phases — read then write. Mutating payload mid-scroll causes
    /// Qdrant to reshuffle segment storage and the paginated cursor may
    /// skip points whose ID falls behind the new write position. A
    /// previous version of this migration left ~17% of points untouched
    /// for this reason. Coletando tudo primeiro garante cobertura total.
    fn migrate_started_at_string_to_int(&self) -> Result<(), IndexerError> {
        let scroll_url = format!(
            "{}/collections/{PLAY_EVENTS_COLLECTION}/points/scroll",
            self.base_url
        );
        let set_url = format!(
            "{}/collections/{PLAY_EVENTS_COLLECTION}/points/payload",
            self.base_url
        );

        // Phase 1 — read-only scroll to collect (id, parsed_int) tuples
        // for every point whose `started_at` is currently a string.
        let mut pending: Vec<(Value, i64)> = Vec::new();
        let mut offset: Option<Value> = None;
        let mut scanned: u64 = 0;

        loop {
            let mut body = json!({
                "limit": 500,
                "with_payload": ["started_at"],
                "with_vector": false
            });
            if let Some(ref off) = offset {
                body["offset"] = off.clone();
            }

            let resp: Value = self
                .agent
                .post(&scroll_url)
                .send_json(&body)
                .map_err(|e| IndexerError::Embedding(format!(
                    "qdrant scroll play_events for migration: {e}"
                )))?
                .into_json()
                .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

            let points = resp["result"]["points"].as_array().cloned().unwrap_or_default();
            for p in &points {
                scanned += 1;
                let Some(id) = p.get("id").cloned() else { continue };
                let Value::String(s) = &p["payload"]["started_at"] else { continue };
                let Ok(parsed) = s.parse::<i64>() else { continue };
                pending.push((id, parsed));
            }

            offset = match resp["result"]["next_page_offset"].clone() {
                Value::Null => None,
                v => Some(v),
            };
            if offset.is_none() {
                break;
            }
        }

        // Phase 2 — write set_payload for every collected point. Order
        // doesn't matter; we already have a stable snapshot of IDs.
        let mut migrated: u64 = 0;
        for (id, parsed) in &pending {
            let patch = json!({
                "payload": { "started_at": parsed },
                "points": [id]
            });
            self.agent
                .post(&set_url)
                .send_json(&patch)
                .map_err(|e| IndexerError::Embedding(format!(
                    "qdrant set_payload started_at: {e}"
                )))?;
            migrated += 1;
        }

        tracing::info!(
            scanned, migrated,
            "play_events: started_at string→int migration complete"
        );
        Ok(())
    }

    /// Insert a single play event into the `play_events` collection.
    ///
    /// `event_type` is `"track_ended"` for natural EOS or `"track_skipped"` when
    /// playback was interrupted. The `behavioral_signals()` derivation accepts
    /// both as evidence — `listen_pct` is the discriminator that separates a
    /// completion from a rejection.
    ///
    /// `timestamp` is the unix epoch when the event was logged (i.e. when the
    /// track ended/was skipped). `started_at` is when playback began. Both are
    /// integers — string ISO format was retired.
    ///
    /// `context_id` identifica a RODADA de audição (ex.: uma sessão de
    /// station) — aditivo, gravado no payload só quando `Some`. Pontos
    /// antigos e eventos fora de uma rodada rastreada continuam sem o
    /// campo; não é migração retroativa, é cobertura desde a Fase 2 do
    /// session-awareness. Habilita skip-rate por posição-na-rodada.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_play_event(
        &self,
        event_type: &str,
        track_id: u64,
        origin: &str,
        started_at: i64,
        timestamp: i64,
        end_position_ms: u64,
        duration_ms: u64,
        context_id: Option<&str>,
    ) -> Result<(), IndexerError> {
        let point_id = uuid::Uuid::new_v4().to_string();

        let payload = build_play_event_payload(
            event_type,
            track_id,
            origin,
            started_at,
            timestamp,
            end_position_ms,
            duration_ms,
            context_id,
            self.provenance.as_ref(),
        );

        let body = json!({
            "points": [{
                "id": point_id,
                "vector": [0.0],
                "payload": payload
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

    pub fn insert_raw_event(&self, payload: &Value) -> Result<(), IndexerError> {
        let point_id = uuid::Uuid::new_v4().to_string();
        // O backend é a autoridade da proveniência: estampa por cima do que
        // vier do frontend via log_event.
        let mut payload = payload.clone();
        stamp_provenance(&mut payload, self.provenance.as_ref());
        let payload = &payload;
        let body = json!({
            "points": [{
                "id": point_id,
                "vector": [0.0],
                "payload": payload
            }]
        });
        self.agent
            .put(&format!(
                "{}/collections/{PLAY_EVENTS_COLLECTION}/points",
                self.base_url
            ))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant insert event: {e}")))?;
        Ok(())
    }

    /// Upsert IDEMPOTENTE de um evento sincado de OUTRO dispositivo (fase 2
    /// do sync — união de conjuntos). `point_id` é o UUID que nasceu no
    /// dispositivo de origem: re-enviar o mesmo evento sobrescreve o mesmo
    /// ponto, nunca duplica. A proveniência NÃO é re-estampada — o carimbo
    /// do dispositivo de origem É o dado; estampar aqui destruiria o
    /// breakdown by_device da régua.
    ///
    /// Payload inválido → `Ok(Rejected)` (ackável); falha de HTTP/transporte
    /// com o Qdrant → `Err` (o receiver aborta o lote com 503).
    pub fn insert_synced_event(
        &self,
        point_id: &str,
        payload: &Value,
    ) -> Result<SyncedOutcome, IndexerError> {
        if let Some(reason) = synced_event_error(payload) {
            return Ok(SyncedOutcome::Rejected(reason.to_string()));
        }
        let body = json!({
            "points": [{
                "id": point_id,
                "vector": [0.0],
                "payload": payload
            }]
        });
        self.agent
            .put(&format!(
                "{}/collections/{PLAY_EVENTS_COLLECTION}/points",
                self.base_url
            ))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant insert synced event: {e}")))?;
        Ok(SyncedOutcome::Applied)
    }

    /// Like/unlike sincado de OUTRO dispositivo → `track_enrichments`, com
    /// last-write-wins por `like_updated_at` ([`synced_like_patch`]). NUNCA
    /// vira ponto em `play_events`. Mesma validação de proveniência do
    /// [`Self::insert_synced_event`] — o `device_id` do evento é o
    /// `liked_device` gravado. Patch `None` (evento mais velho que o like
    /// vigente) = `Skipped` sem escrita. Payload inválido → `Rejected`
    /// (ackável); falha de HTTP/transporte com o Qdrant → `Err`.
    pub fn apply_synced_like(&self, payload: &Value) -> Result<SyncedOutcome, IndexerError> {
        let rejeitado = |reason: &str| Ok(SyncedOutcome::Rejected(reason.to_string()));
        if let Some(reason) = synced_event_error(payload) {
            return rejeitado(reason);
        }
        // Campos abaixo já validados por synced_event_error.
        let event_type = payload["event_type"].as_str().unwrap_or_default();
        if !matches!(event_type, "like" | "unlike") {
            return rejeitado("event_type não é like/unlike");
        }
        // LWW sem timestamp não ordena — rejeita em vez de inventar 0
        // (liked_at=0 contaria como like pro is_liked). 0 e negativo idem:
        // like em ts=0 perderia pra QUALQUER unlike.
        let ts = match payload.get("timestamp").and_then(Value::as_i64) {
            Some(ts) if ts > 0 => ts,
            _ => return rejeitado("timestamp ausente ou <= 0"),
        };
        let track_id = payload["track_id"].as_u64().unwrap_or_default();
        let device_id = payload["device_id"].as_str().unwrap_or_default();
        let existing = self.get_enrichment(track_id)?;
        match synced_like_patch(&existing, event_type, ts, device_id) {
            Some(patch) => {
                self.set_enrichment(track_id, patch)?;
                Ok(SyncedOutcome::Applied)
            }
            None => Ok(SyncedOutcome::Skipped { current: like_clock(&existing) }),
        }
    }

    /// Scroll the `play_events` collection with a filter, ordered by `started_at` descending.
    ///
    /// Returns the payload of each matching point (up to `limit`).
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

    /// Derive behavioral signals (positives and negatives) from play events.
    ///
    /// v3 — a derivação em si é pura ([`derive_behavioral_signals`]); aqui só
    /// vive o I/O. Contrato (balanço líquido por track):
    /// - Cada evento vira peso CONTÍNUO `clamp((lp − 0.30)/0.50, −0.6, 1.0)`
    ///   — 60% de escuta = +0.6 (envolvimento real, não zero como no
    ///   threshold binário antigo); skip imediato = −0.6. Lado positivo
    ///   ganha piso de atenção (90s: full de skit de 40s ≈ 0.44) e desconto
    ///   0.6 pra origens passivas (anti-feedback-loop); skips não têm
    ///   desconto. Tudo com decay de meia-vida 14d, somado num SALDO único
    ///   por track — escutas boas e skips da mesma track se compensam.
    /// - **Positives:** saldo > 0 e peso positivo acumulado >= 0.55 (60%
    ///   ativo qualifica sozinho; passivo/skit exige recorrência), top 25
    ///   por saldo, distintos + likes explícitos (top 10), cap 35.
    /// - **Negatives:** saldo <= −0.30, mais rejeitadas primeiro, cap 40 —
    ///   skip único EXPIRA sozinho pelo decay (~2 semanas); aversão
    ///   recorrente permanece.
    pub fn behavioral_signals(&self) -> Result<(Vec<u64>, Vec<u64>), IndexerError> {
        // event_type accepts both natural completion and interrupted plays —
        // listen_pct is the actual discriminator. We just need to keep
        // search/click events out of the play-affinity derivation.
        // origin="album_seq" fica fora dos dois lados: deixar um álbum rolar
        // não é sinal por track ("playlist" ENTRA, com desconto passivo).
        let event_type_filter = json!({
            "key": "event_type",
            "match": { "any": ["track_ended", "track_skipped"] }
        });

        let pos_filter = json!({
            "must": [
                event_type_filter.clone(),
                { "key": "listen_pct", "range": { "gte": POSITIVE_MIN_LISTEN_PCT } }
            ],
            "must_not": [
                { "key": "origin", "match": { "value": "album_seq" } }
            ]
        });
        let pos_payloads = self.scroll_play_events(pos_filter, 300)?;

        let neg_filter = json!({
            "must": [
                event_type_filter,
                { "key": "listen_pct", "range": { "lt": 0.30 } }
            ],
            "must_not": [
                { "key": "origin", "match": { "value": "album_seq" } }
            ]
        });
        let neg_payloads = self.scroll_play_events(neg_filter, 300)?;

        // Likes explícitos são o sinal mais honesto disponível; falha aqui
        // não pode derrubar os sinais comportamentais.
        let liked = self.recent_likes(10).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "behavioral_signals: recent_likes falhou — seguindo sem likes");
            Vec::new()
        });

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        Ok(derive_behavioral_signals(
            &pos_payloads,
            &neg_payloads,
            &liked,
            now,
        ))
    }

    /// Track ids com like explícito, mais recentes primeiro (por `liked_at`).
    /// Ordenação client-side — `order_by` no Qdrant exigiria índice range em
    /// `liked_at`. Página única de 1000 com payload restrito a `liked_at`
    /// (o enrichment inteiro seria tráfego inútil no hot path do autoplay);
    /// acima de 1000 likes o top-N degradaria pra um subconjunto — hoje o
    /// acervo inteiro tem 1746 tracks.
    fn recent_likes(&self, limit: usize) -> Result<Vec<u64>, IndexerError> {
        let body = json!({
            "filter": { "must": [{ "key": "liked_at", "range": { "gt": 0 } }] },
            "limit": 1000,
            "with_payload": { "include": ["liked_at"] },
            "with_vector": false
        });
        let resp: Value = self
            .agent
            .post(&format!(
                "{}/collections/{ENRICHMENTS_COLLECTION}/points/scroll",
                self.base_url
            ))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant scroll likes: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;

        let mut likes: Vec<(u64, i64)> = Vec::new();
        if let Some(points) = resp["result"]["points"].as_array() {
            for p in points {
                if let (Some(id), Some(at)) = (p["id"].as_u64(), p["payload"]["liked_at"].as_i64())
                {
                    likes.push((id, at));
                }
            }
        }
        likes.sort_by(|a, b| b.1.cmp(&a.1));
        likes.truncate(limit);
        Ok(likes.into_iter().map(|(id, _)| id).collect())
    }

    // sync_lyrics removed — pipeline will handle lyrics embedding directly.

    // -----------------------------------------------------------------------
    // Track enrichments collection
    // -----------------------------------------------------------------------

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
                // Payload ausente/`result` null vale como {} — record_play,
                // toggle_like e set_enrichment fazem `as_object_mut()` no
                // que volta daqui; com Null o merge perdia o patch inteiro.
                let payload = data["result"]["payload"].clone();
                Ok(if payload.is_object() { payload } else { json!({}) })
            }
            Err(ureq::Error::Status(404, _)) => Ok(json!({})),
            Err(e) => Err(IndexerError::Embedding(format!("qdrant get enrichment: {e}"))),
        }
    }

    /// Batch-retrieve enrichment payloads for a set of track IDs in a single
    /// call (`POST /collections/track_enrichments/points`).
    ///
    /// Returns `{track_id → payload}`. Points absent from the collection
    /// simply don't appear in the map — callers treat a missing entry as
    /// "no enrichment" (neutral vibe). IDs are u64 ALWAYS (hash-based,
    /// values above `i64::MAX` are common).
    pub fn get_enrichments_batch(
        &self,
        ids: &[u64],
    ) -> Result<HashMap<u64, Value>, IndexerError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let body = json!({ "ids": ids, "with_payload": true });
        let resp: Value = self
            .agent
            .post(&format!(
                "{}/collections/{ENRICHMENTS_COLLECTION}/points",
                self.base_url
            ))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant get enrichments batch: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("qdrant json: {e}")))?;
        Ok(parse_id_payload_map(&resp))
    }

    pub fn set_enrichment(&self, track_id: u64, payload: Value) -> Result<(), IndexerError> {
        let existing = self.get_enrichment(track_id)?;
        let mut merged = existing;
        if let (Some(base), Some(patch)) = (merged.as_object_mut(), payload.as_object()) {
            for (k, v) in patch {
                base.insert(k.clone(), v.clone());
            }
        }

        let body = json!({
            "points": [{
                "id": track_id,
                "vector": [0.0_f32],
                "payload": merged
            }]
        });
        self.agent
            .put(&format!("{}/collections/{ENRICHMENTS_COLLECTION}/points", self.base_url))
            .query("wait", "true")
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("qdrant set enrichment: {e}")))?;
        Ok(())
    }

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

    pub fn mood_search_enrichments(&self, filters: &MoodFilters, limit: usize) -> Result<Vec<u64>, IndexerError> {
        let mut must = Vec::new();

        for tag in &filters.mood_tags {
            must.push(json!({"key": "mood_tags", "match": {"value": tag}}));
        }
        for tag in &filters.activity_tags {
            must.push(json!({"key": "activity_tags", "match": {"value": tag}}));
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
                if let Some(id) = p["id"].as_u64() {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
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

/// Build the `/points/query` body for the Recommendations API.
///
/// Always sets `"strategy": "best_score"`: with a single positive the
/// ordering is identical to `average_vector`; with multiple positives it
/// avoids centroid collapse (the MERT space is multi-cluster — averaging an
/// eclectic taste lands in a "middle" that represents no cluster); with
/// negatives, a candidate close to a strong skip is penalized individually.
///
/// `exclude_ids` becomes a hard `must_not has_id` filter (only when
/// non-empty); `negative_ids` is omitted when empty.
/// Origens "passivas": a track tocou porque o SISTEMA escolheu (autoplay/
/// station) ou porque uma playlist rolou sozinha. Escuta completa vinda daí
/// vale menos que escolha ativa — sem o desconto, o autoplay reforça o que
/// ele mesmo tocou (feedback loop).
const PASSIVE_ORIGINS: &[&str] = &["autoplay", "station", "playlist"];
/// Piso de listen_pct pra um evento entrar no lado positivo; abaixo disso
/// é rejeição (lado dos negatives).
const POSITIVE_MIN_LISTEN_PCT: f64 = 0.30;
/// Rampa do peso positivo: w = clamp((lp − 0.30)/0.50, 0, 1). O sinal é
/// CONTÍNUO — ouvir 60% de uma música é envolvimento real (w = 0.6), não
/// zero como no threshold binário antigo (>= 0.9 ou nada); 80%+ satura em
/// peso cheio.
const POSITIVE_RAMP_SPAN: f64 = 0.50;
/// Peso acumulado (com desconto de origem, SEM decay) pra uma track
/// qualificar como positive: um 60% ativo qualifica sozinho (0.6); escuta
/// passiva parcial precisa de recorrência (0.6·0.6 = 0.36); escutas rasas
/// não somam qualificação por contagem (2×35% = 0.2).
const QUALIFY_FLOOR: f64 = 0.55;
/// Piso do peso negativo: skip imediato (lp=0) vale −0.6 contra +1.0 de um
/// full listen — rejeitar é sinal mais barato/impulsivo que 4 minutos de
/// atenção, então não pesa simétrico.
const NEGATIVE_WEIGHT_FLOOR: f64 = -0.6;
/// Saldo líquido (com decay) abaixo do qual a track vira negative. Um skip
/// único envelhece e EXPIRA sozinho (−0.6 cai a −0.30 em ~14 dias);
/// aversão recorrente permanece.
const NEGATIVE_NET_THRESHOLD: f64 = -0.30;
/// Piso de atenção pro lado positivo: abaixo de 90s ouvidos o peso é
/// proporcional ao tempo (full listen de um skit de 40s = 0.44, não 1.0).
/// Nunca bonifica faixas longas — o fator satura em 1.
const FULL_ATTENTION_MS: f64 = 90_000.0;
/// Desconto aplicado ao peso de eventos de origem passiva.
const PASSIVE_WEIGHT: f64 = 0.6;
/// Meia-vida do decay temporal dos positives, em dias.
const HALF_LIFE_DAYS: f64 = 14.0;
/// Máximo de positives comportamentais (antes dos likes).
const MAX_BEHAVIORAL_POSITIVES: usize = 25;
/// Máximo de positives totais (comportamentais + likes explícitos).
const MAX_TOTAL_POSITIVES: usize = 35;
/// Máximo de negatives.
const MAX_NEGATIVES: usize = 40;

/// Validação PURA de um evento vindo pelo trilho de sync: evento sem
/// proveniência completa não entra — o objetivo do sync é exatamente o
/// breakdown por dispositivo, e um ponto sem carimbo seria indistinguível
/// de dado legado.
pub(crate) fn synced_event_error(payload: &Value) -> Option<&'static str> {
    if payload
        .get("device_id")
        .and_then(Value::as_str)
        .map_or(true, str::is_empty)
    {
        return Some("sem device_id");
    }
    if payload.get("signal_schema").and_then(Value::as_i64).is_none() {
        return Some("sem signal_schema");
    }
    if payload
        .get("event_type")
        .and_then(Value::as_str)
        .map_or(true, str::is_empty)
    {
        return Some("sem event_type");
    }
    if payload.get("track_id").and_then(Value::as_u64).is_none() {
        return Some("track_id ausente ou não-u64");
    }
    None
}

/// Patch PURO de um like/unlike sincado sobre o enrichment vigente —
/// last-write-wins por `like_updated_at` (fallback `liked_at` pros likes
/// legados que nasceram sem o campo). LWW ESTRITO: só `ts` MENOR que o
/// vigente é no-op; igual APLICA — double-tap like→unlike no mesmo segundo
/// chega na ordem do seq, e replay do mesmo evento reescreve o mesmo valor
/// (idempotente). `existing` não-objeto (Null etc.) vale como `{}`. Unlike
/// zera com null (mesma convenção do `toggle_like`). Outro event_type → None.
pub(crate) fn synced_like_patch(
    existing: &Value,
    event_type: &str,
    ts: i64,
    device_id: &str,
) -> Option<Value> {
    let liked = match event_type {
        "like" => true,
        "unlike" => false,
        _ => return None,
    };
    if ts < like_clock(existing) {
        return None;
    }
    Some(if liked {
        json!({ "liked_at": ts, "liked_device": device_id, "like_updated_at": ts })
    } else {
        json!({ "liked_at": null, "liked_device": null, "like_updated_at": ts })
    })
}

/// Clock vigente do like num enrichment: `like_updated_at`, fallback
/// `liked_at` (likes legados nasceram sem o campo), 0 sem nada.
fn like_clock(existing: &Value) -> i64 {
    existing
        .get("like_updated_at")
        .and_then(Value::as_i64)
        .or_else(|| existing.get("liked_at").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// Estampa a proveniência num payload de evento: `signal_schema` sempre;
/// `device_id`/`app_version` quando o client tem [`Provenance`] anexada.
fn stamp_provenance(payload: &mut Value, provenance: Option<&Provenance>) {
    payload["signal_schema"] = json!(SIGNAL_SCHEMA);
    if let Some(p) = provenance {
        payload["device_id"] = json!(p.device_id);
        payload["app_version"] = json!(p.app_version);
    }
}

/// Montagem PURA do payload de um play event — separada do HTTP para ser
/// testável. `listen_pct` deriva de `end_position_ms / duration_ms`
/// (clamp 0..1; duração zero → 0.0).
#[allow(clippy::too_many_arguments)]
pub fn build_play_event_payload(
    event_type: &str,
    track_id: u64,
    origin: &str,
    started_at: i64,
    timestamp: i64,
    end_position_ms: u64,
    duration_ms: u64,
    context_id: Option<&str>,
    provenance: Option<&Provenance>,
) -> Value {
    let listen_pct = if duration_ms == 0 {
        0.0_f64
    } else {
        (end_position_ms as f64 / duration_ms as f64).clamp(0.0, 1.0)
    };

    let mut payload = json!({
        "event_type": event_type,
        "timestamp": timestamp,
        "track_id": track_id,
        "origin": origin,
        "started_at": started_at,
        "end_position_ms": end_position_ms,
        "duration_ms": duration_ms,
        "listen_pct": listen_pct
    });
    if let Some(cid) = context_id {
        payload["context_id"] = json!(cid);
    }
    stamp_provenance(&mut payload, provenance);
    payload
}

/// Derivação PURA dos sinais comportamentais — ver contrato no doc de
/// [`QdrantClient::behavioral_signals`]. `pos_payloads`/`neg_payloads` vêm
/// ordenados por `started_at` desc (mais recentes primeiro); `liked_recent`
/// já vem limitado e ordenado por recência do like.
pub(crate) fn derive_behavioral_signals(
    pos_payloads: &[Value],
    neg_payloads: &[Value],
    liked_recent: &[u64],
    now: i64,
) -> (Vec<u64>, Vec<u64>) {
    // Balanço líquido por track: escutas somam, skips subtraem, tudo com o
    // mesmo decay — o SALDO decide o lado (o "percentual geral" da track,
    // acumulado no tempo). Peso contínuo através do piso de 30%:
    // clamp((lp − 0.30)/0.50, −0.6, 1.0).
    struct Acc {
        net: f64,
        raw_pos: f64,
        last_at: i64,
    }
    let mut acc: HashMap<u64, Acc> = HashMap::new();
    for p in pos_payloads.iter().chain(neg_payloads.iter()) {
        let Some(tid) = p["track_id"].as_u64() else {
            continue;
        };
        let started = p["started_at"].as_i64().unwrap_or(0);
        let age_days = (now - started).max(0) as f64 / 86_400.0;
        let decay = 0.5_f64.powf(age_days / HALF_LIFE_DAYS);
        let lp = p["listen_pct"].as_f64().unwrap_or(0.0);
        let w = ((lp - POSITIVE_MIN_LISTEN_PCT) / POSITIVE_RAMP_SPAN)
            .clamp(NEGATIVE_WEIGHT_FLOOR, 1.0);
        let e = acc.entry(tid).or_insert(Acc {
            net: 0.0,
            raw_pos: 0.0,
            last_at: i64::MIN,
        });
        if w > 0.0 {
            // Piso de atenção (só no lado positivo): full listen de um skit
            // de 40s não é o compromisso de 4 minutos. Payload sem duração
            // (fixtures/legado) = atenção plena.
            let listened_ms = p["end_position_ms"]
                .as_f64()
                .or_else(|| p["duration_ms"].as_f64().map(|d| d * lp))
                .unwrap_or(f64::INFINITY);
            let attention = (listened_ms / FULL_ATTENTION_MS).min(1.0);
            let origin = p["origin"].as_str().unwrap_or("");
            let origin_w = if PASSIVE_ORIGINS.contains(&origin) {
                PASSIVE_WEIGHT
            } else {
                1.0
            };
            let w = w * attention * origin_w;
            e.net += w * decay;
            e.raw_pos += w;
        } else {
            // Skip: sem desconto de origem — rejeição de sugestão é
            // exatamente o erro que o autoplay precisa aprender.
            e.net += w * decay;
        }
        e.last_at = e.last_at.max(started);
    }

    // Positives: qualificação por peso positivo acumulado E saldo líquido
    // positivo; rank por saldo. Saldo positivo fora do top-25 NUNCA vira
    // negative (os lados são disjuntos por construção: net > 0 vs ≤ −0.30).
    let mut qualified: Vec<(u64, f64, i64)> = acc
        .iter()
        .filter(|(_, a)| a.raw_pos >= QUALIFY_FLOOR && a.net > 0.0)
        .map(|(tid, a)| (*tid, a.net, a.last_at))
        .collect();
    qualified.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.2.cmp(&a.2))
            .then(a.0.cmp(&b.0))
    });
    qualified.truncate(MAX_BEHAVIORAL_POSITIVES);
    let mut positives: Vec<u64> = qualified.iter().map(|(tid, ..)| *tid).collect();

    // Negatives: saldo abaixo do limiar, mais rejeitadas primeiro. O decay
    // faz um skip único expirar sozinho; aversão recorrente permanece.
    let mut negs: Vec<(u64, f64, i64)> = acc
        .iter()
        .filter(|(_, a)| a.net <= NEGATIVE_NET_THRESHOLD)
        .map(|(tid, a)| (*tid, a.net, a.last_at))
        .collect();
    negs.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.2.cmp(&a.2))
            .then(a.0.cmp(&b.0))
    });
    negs.truncate(MAX_NEGATIVES);
    let negatives: Vec<u64> = negs.into_iter().map(|(tid, ..)| tid).collect();

    let mut pos_seen: HashSet<u64> = positives.iter().copied().collect();

    // Likes explícitos: apendados sem duplicar nem contrariar um negative
    // (skip recente > like antigo).
    let neg_set: HashSet<u64> = negatives.iter().copied().collect();
    for tid in liked_recent {
        if positives.len() >= MAX_TOTAL_POSITIVES {
            break;
        }
        if !neg_set.contains(tid) && pos_seen.insert(*tid) {
            positives.push(*tid);
        }
    }

    (positives, negatives)
}

pub(crate) fn build_recommend_body(
    positive_ids: &[u64],
    negative_ids: &[u64],
    exclude_ids: &[u64],
    limit: usize,
) -> Value {
    let mut recommend = json!({
        "positive": positive_ids,
        "strategy": "best_score"
    });
    if !negative_ids.is_empty() {
        recommend["negative"] = json!(negative_ids);
    }

    let mut body = json!({
        "query": { "recommend": recommend },
        "using": VEC_MERT,
        "limit": limit,
        "with_payload": false
    });
    if !exclude_ids.is_empty() {
        body["filter"] = json!({
            "must_not": [{ "has_id": exclude_ids }]
        });
    }
    body
}

/// Extract `{point_id → payload}` from a Qdrant batch-retrieve response
/// (`result` is an array of points with `id` and `payload`).
///
/// Point IDs are ALWAYS u64 (hash-based, values above `i64::MAX` are common
/// in this library) — `as_u64`, never `as_i64`. Points absent from the
/// response simply don't appear in the map.
fn parse_id_payload_map(resp: &Value) -> HashMap<u64, Value> {
    let mut map = HashMap::new();
    if let Some(points) = resp["result"].as_array() {
        for p in points {
            if let Some(id) = p["id"].as_u64() {
                map.insert(id, p.get("payload").cloned().unwrap_or(Value::Null));
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_recommend_body_inclui_strategy_best_score_e_positives() {
        // ID acima de i64::MAX no meio dos positives — u64 no wire sempre.
        let big: u64 = 18_446_744_073_709_551_000;
        let body = build_recommend_body(&[big, 42], &[], &[], 10);
        assert_eq!(body["query"]["recommend"]["strategy"], json!("best_score"));
        assert_eq!(body["query"]["recommend"]["positive"], json!([big, 42]));
        assert_eq!(body["using"], json!("mert"));
        assert_eq!(body["limit"], json!(10));
        assert_eq!(body["with_payload"], json!(false));
    }

    #[test]
    fn build_recommend_body_omite_negatives_vazio_e_inclui_quando_presente() {
        let sem = build_recommend_body(&[1], &[], &[], 5);
        assert!(
            sem["query"]["recommend"].get("negative").is_none(),
            "negative não deve aparecer quando vazio"
        );
        let com = build_recommend_body(&[1], &[9], &[], 5);
        assert_eq!(com["query"]["recommend"]["negative"], json!([9]));
    }

    #[test]
    fn build_recommend_body_filtro_must_not_so_com_exclude() {
        let sem = build_recommend_body(&[1], &[], &[], 5);
        assert!(sem.get("filter").is_none(), "sem exclude → sem filter");
        let com = build_recommend_body(&[1], &[], &[7, 8], 5);
        assert_eq!(com["filter"]["must_not"][0]["has_id"], json!([7, 8]));
    }

    // ── build_play_event_payload — proveniência (spec 2026-08-13) ──────────

    #[test]
    fn payload_com_provenance_estampa_os_tres_campos() {
        let p = Provenance {
            device_id: "cmr-auto".into(),
            app_version: "0.2.72".into(),
        };
        let payload = build_play_event_payload(
            "track_ended",
            42,
            "autoplay",
            1_700_000_000,
            1_700_000_200,
            180_000,
            200_000,
            Some("ctx-1"),
            Some(&p),
        );
        assert_eq!(payload["device_id"], json!("cmr-auto"));
        assert_eq!(payload["app_version"], json!("0.2.72"));
        assert_eq!(payload["signal_schema"], json!(SIGNAL_SCHEMA));
        // campos pré-existentes preservados
        assert_eq!(payload["event_type"], json!("track_ended"));
        assert_eq!(payload["track_id"], json!(42));
        assert_eq!(payload["context_id"], json!("ctx-1"));
        assert!((payload["listen_pct"].as_f64().unwrap() - 0.9).abs() < 1e-9);
    }

    #[test]
    fn payload_sem_provenance_estampa_so_signal_schema() {
        let payload = build_play_event_payload(
            "track_skipped",
            7,
            "queue",
            100,
            110,
            0,
            0,
            None,
            None,
        );
        assert_eq!(payload["signal_schema"], json!(SIGNAL_SCHEMA));
        assert!(payload.get("device_id").is_none());
        assert!(payload.get("app_version").is_none());
        assert!(payload.get("context_id").is_none());
        assert_eq!(payload["listen_pct"], json!(0.0), "duração zero → 0.0");
    }

    #[test]
    fn synced_event_exige_proveniencia_completa() {
        let ok = json!({
            "event_type": "track_ended", "track_id": 12755931536157556u64,
            "device_id": "sm-s921b", "app_version": "0.1.0",
            "signal_schema": 3, "origin": "playlist",
            "started_at": 1, "timestamp": 2,
        });
        assert_eq!(synced_event_error(&ok), None);

        let mut sem_device = ok.clone();
        sem_device["device_id"] = json!("");
        assert_eq!(synced_event_error(&sem_device), Some("sem device_id"));

        let mut sem_schema = ok.clone();
        sem_schema.as_object_mut().unwrap().remove("signal_schema");
        assert_eq!(synced_event_error(&sem_schema), Some("sem signal_schema"));

        // track_id string (como viaja no JSON do celular sem conversão) é
        // rejeitado — o flush converte pra u64 ANTES do upsert.
        let mut tid_string = ok.clone();
        tid_string["track_id"] = json!("12755931536157556");
        assert_eq!(
            synced_event_error(&tid_string),
            Some("track_id ausente ou não-u64")
        );
    }

    #[test]
    fn synced_like_patch_like_em_vazio_grava_liked_at_device_e_updated_at() {
        let patch = synced_like_patch(&json!({}), "like", 1_700_000_000, "s24").unwrap();
        assert_eq!(
            patch,
            json!({
                "liked_at": 1_700_000_000,
                "liked_device": "s24",
                "like_updated_at": 1_700_000_000
            })
        );
    }

    #[test]
    fn synced_like_patch_unlike_mais_velho_que_like_vigente_e_noop() {
        let existing = json!({
            "liked_at": 200, "liked_device": "cmr-auto", "like_updated_at": 200
        });
        assert_eq!(synced_like_patch(&existing, "unlike", 199, "s24"), None);
    }

    #[test]
    fn synced_like_patch_unlike_mais_novo_zera_liked_at() {
        let existing = json!({
            "liked_at": 200, "liked_device": "cmr-auto", "like_updated_at": 200,
            "play_count": 3
        });
        let patch = synced_like_patch(&existing, "unlike", 201, "s24").unwrap();
        // mesma convenção de null do toggle_like; o patch NÃO toca em play_count
        assert_eq!(
            patch,
            json!({"liked_at": null, "liked_device": null, "like_updated_at": 201})
        );
    }

    #[test]
    fn synced_like_patch_replay_do_mesmo_evento_reaplica_mesmo_valor() {
        let existing = json!({
            "liked_at": 200, "liked_device": "s24", "like_updated_at": 200
        });
        // ts == last aplica: replay do mesmo evento reescreve o mesmo valor
        let patch = synced_like_patch(&existing, "like", 200, "s24").unwrap();
        assert_eq!(patch, existing);
        // double-tap like→unlike no mesmo segundo chega na ordem do seq
        let patch = synced_like_patch(&existing, "unlike", 200, "s24").unwrap();
        assert_eq!(patch["liked_at"], json!(null));
        assert_eq!(patch["like_updated_at"], json!(200));
    }

    #[test]
    fn synced_like_patch_legado_sem_updated_at_usa_liked_at() {
        // likes legados só têm liked_at (vários sem liked_device)
        let existing = json!({"liked_at": 500});
        assert_eq!(synced_like_patch(&existing, "unlike", 499, "s24"), None);
        let patch = synced_like_patch(&existing, "unlike", 500, "s24").unwrap();
        assert_eq!(patch["liked_at"], json!(null));
        assert_eq!(patch["like_updated_at"], json!(500));
    }

    #[test]
    fn synced_like_patch_existing_null_vira_vazio() {
        // get_enrichment normaliza payload não-objeto pra {} (CMR-220), mas a
        // função pura segue defensiva: Null vale como {}
        let patch = synced_like_patch(&Value::Null, "like", 7, "s24").unwrap();
        assert_eq!(patch["liked_at"], json!(7));
        assert_eq!(patch["liked_device"], json!("s24"));
        // outro event_type nunca vira patch
        assert_eq!(synced_like_patch(&Value::Null, "track_ended", 7, "s24"), None);
    }

    /// Motivo da rejeição, ou panic se o outcome não for `Rejected`.
    fn rejected_reason(outcome: Result<SyncedOutcome, IndexerError>) -> String {
        match outcome {
            Ok(SyncedOutcome::Rejected(reason)) => reason,
            other => panic!("esperava Rejected, veio {other:?}"),
        }
    }

    #[test]
    fn apply_synced_like_exige_proveniencia() {
        // A validação roda ANTES de qualquer request — porta fechada basta.
        // Rejeição é Ok(Rejected): o dispositivo ACKA (re-enviar não conserta).
        let client = QdrantClient::new("http://127.0.0.1:1");
        let sem_device = json!({
            "event_type": "like", "track_id": 1u64, "timestamp": 10, "signal_schema": 3
        });
        let reason = rejected_reason(client.apply_synced_like(&sem_device));
        assert!(reason.contains("device_id"), "{reason}");

        let tipo_vazio = json!({
            "event_type": "", "track_id": 1u64, "timestamp": 10,
            "signal_schema": 3, "device_id": "s24"
        });
        rejected_reason(client.apply_synced_like(&tipo_vazio));

        // play event roteado errado não pode virar Ok silencioso
        let nao_like = json!({
            "event_type": "track_ended", "track_id": 1u64, "timestamp": 10,
            "signal_schema": 3, "device_id": "s24"
        });
        let reason = rejected_reason(client.apply_synced_like(&nao_like));
        assert!(reason.contains("event_type"), "{reason}");
    }

    #[test]
    fn apply_synced_like_rejeita_timestamp_ausente_ou_nao_positivo() {
        // LWW sem timestamp não tem como ordenar — rejeita em vez de inventar
        // 0 (liked_at=0 conta como like pro is_liked). 0 e negativo idem: um
        // like em ts=0 perderia pra QUALQUER unlike e liked_at=0 é ambíguo.
        let client = QdrantClient::new("http://127.0.0.1:1");
        let base = json!({
            "event_type": "like", "track_id": 1u64, "signal_schema": 3, "device_id": "s24"
        });
        let mut ts_zero = base.clone();
        ts_zero["timestamp"] = json!(0);
        let mut ts_negativo = base.clone();
        ts_negativo["timestamp"] = json!(-5);
        let mut ts_string = base.clone();
        ts_string["timestamp"] = json!("10");
        for payload in [base, ts_zero, ts_negativo, ts_string] {
            assert_eq!(
                rejected_reason(client.apply_synced_like(&payload)),
                "timestamp ausente ou <= 0",
                "{payload}"
            );
        }
    }

    /// Qdrant fake mínimo (std): responde `body` com 200 a qualquer request
    /// e devolve a porta. Só o suficiente pra exercitar o parse do
    /// get_enrichment e a distinção validação × transporte.
    fn fake_qdrant(body: &'static str) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let header_end = loop {
                    let Ok(n) = s.read(&mut chunk) else { break None };
                    if n == 0 {
                        break None;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(pos + 4);
                    }
                };
                let Some(header_end) = header_end else { continue };
                let content_length: usize = String::from_utf8_lossy(&buf[..header_end])
                    .lines()
                    .filter_map(|l| l.split_once(':'))
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.trim().parse().ok())
                    .unwrap_or(0);
                while buf.len() < header_end + content_length {
                    let Ok(n) = s.read(&mut chunk) else { break };
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    fn like_valido(ts: i64) -> Value {
        json!({
            "event_type": "like", "track_id": 12755931536157556u64, "timestamp": ts,
            "signal_schema": 3, "device_id": "s24", "app_version": "0.2.77"
        })
    }

    #[test]
    fn get_enrichment_payload_nao_objeto_vira_vazio() {
        // `result` null / payload ausente → {}. record_play, toggle_like e
        // set_enrichment fazem `as_object_mut()` no que volta daqui: com Null
        // o merge do set_enrichment perdia o patch inteiro e gravava null.
        let port = fake_qdrant(r#"{"result":null}"#);
        let client = QdrantClient::new(format!("http://127.0.0.1:{port}"));
        assert_eq!(client.get_enrichment(1).unwrap(), json!({}));

        let port = fake_qdrant(r#"{"result":{"payload":{"play_count":3}}}"#);
        let client = QdrantClient::new(format!("http://127.0.0.1:{port}"));
        assert_eq!(client.get_enrichment(1).unwrap(), json!({"play_count": 3}));
    }

    #[test]
    fn apply_synced_like_mais_velho_que_o_vigente_e_skipped_com_o_clock() {
        // like vigente em 200; evento sincado em 100 → no-op por LWW, mas
        // ACKÁVEL (Ok), com o clock vigente pro log do receiver.
        let port = fake_qdrant(
            r#"{"result":{"payload":{"liked_at":200,"liked_device":"cmr-auto","like_updated_at":200}}}"#,
        );
        let client = QdrantClient::new(format!("http://127.0.0.1:{port}"));
        assert_eq!(
            client.apply_synced_like(&like_valido(100)).unwrap(),
            SyncedOutcome::Skipped { current: 200 }
        );
        // mais novo que o vigente → aplica (GET + PUT no mesmo fake)
        assert_eq!(
            client.apply_synced_like(&like_valido(300)).unwrap(),
            SyncedOutcome::Applied
        );
    }

    #[test]
    fn transporte_falho_e_err_e_nao_rejected() {
        // Porta fechada = Qdrant fora do ar. Payload VÁLIDO → Err (o receiver
        // responde 503 e o S24 NÃO acka); nunca Rejected, que seria ackado e
        // perderia o like/play pra sempre.
        let client = QdrantClient::new("http://127.0.0.1:1");
        assert!(client.apply_synced_like(&like_valido(10)).is_err());

        let mut play = like_valido(10);
        play["event_type"] = json!("track_ended");
        assert!(client
            .insert_synced_event("11111111-2222-3333-4444-555555555555", &play)
            .is_err());
        // ...enquanto payload inválido segue Rejected mesmo com Qdrant fora
        let sem_device = json!({ "event_type": "track_ended", "track_id": 1u64, "signal_schema": 3 });
        let reason = rejected_reason(
            client.insert_synced_event("11111111-2222-3333-4444-555555555555", &sem_device),
        );
        assert!(reason.contains("device_id"), "{reason}");
    }

    #[test]
    fn stamp_provenance_sobrescreve_campos_vindos_do_frontend() {
        // log_event aceita payload arbitrário do frontend; o backend é a
        // autoridade — valores forjados são sobrescritos.
        let p = Provenance {
            device_id: "cmr-auto".into(),
            app_version: "0.2.72".into(),
        };
        let mut payload = json!({
            "event_type": "ui_event",
            "timestamp": 1,
            "device_id": "forjado",
            "signal_schema": 999
        });
        stamp_provenance(&mut payload, Some(&p));
        assert_eq!(payload["device_id"], json!("cmr-auto"));
        assert_eq!(payload["signal_schema"], json!(SIGNAL_SCHEMA));
        assert_eq!(payload["event_type"], json!("ui_event"));
    }

    // ── derive_behavioral_signals — derivação pura dos sinais ──────────────
    //
    // Contrato v3: positives DISTINTOS (sem repetição por peso — inócua sob
    // best_score), selecionados por score com decay temporal (meia-vida 14d)
    // e desconto 0.6 pra origens passivas (autoplay/station/playlist);
    // negatives distintos por recência com cap 40; conflito pos/neg resolvido
    // pela recência do evento mais recente de cada lado; likes explícitos
    // apendados aos positives sem duplicar.

    const DAY: i64 = 86_400;
    const NOW: i64 = 1_700_000_000;

    fn ev(tid: u64, lp: f64, origin: &str, started_at: i64) -> Value {
        json!({
            "track_id": tid,
            "listen_pct": lp,
            "origin": origin,
            "started_at": started_at
        })
    }

    #[test]
    fn derive_positives_distintos_e_qualificacao() {
        // track 1: 3 full listens → qualifica, aparece UMA vez (sem peso por
        // repetição). track 2: 1 escuta rasa (0.40, peso ~0.2) → fora.
        // track 3: 1 full listen → qualifica sozinho.
        let pos = vec![
            ev(1, 1.0, "manual", NOW - DAY),
            ev(1, 1.0, "manual", NOW - 2 * DAY),
            ev(1, 1.0, "manual", NOW - 3 * DAY),
            ev(2, 0.40, "manual", NOW - DAY),
            ev(3, 1.0, "manual", NOW - DAY),
        ];
        let (positives, negatives) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert_eq!(positives.iter().filter(|id| **id == 1).count(), 1, "sem repetição");
        assert!(positives.contains(&3));
        assert!(!positives.contains(&2), "escuta única rasa não qualifica");
        assert!(negatives.is_empty());
    }

    // ── nuance de listen_pct: sinal contínuo, não threshold binário ────────
    //
    // Ouvir 60% de uma música é envolvimento real — o antigo corte binário
    // (>= 0.9 vale 1, abaixo vale 0) descartava a banda média inteira.
    // Peso w(lp) = clamp((lp − 0.30) / 0.50): 40% → 0.2, 60% → 0.6,
    // 80%+ → 1.0. Qualificação = peso acumulado (com desconto de origem,
    // sem decay) >= 0.55.

    #[test]
    fn derive_escuta_unica_de_60pct_ativa_qualifica() {
        let pos = vec![ev(10, 0.60, "manual", NOW)];
        let (positives, _) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert!(positives.contains(&10), "60% ativo é sinal positivo por si");
    }

    #[test]
    fn derive_escuta_parcial_pesa_menos_que_full_no_ranking() {
        // Mesmo decay e origem: full listen deve rankear acima de 60%.
        let pos = vec![
            ev(20, 0.60, "manual", NOW),
            ev(21, 1.0, "manual", NOW),
        ];
        let (positives, _) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert_eq!(positives, vec![21, 20]);
    }

    #[test]
    fn derive_60pct_passivo_exige_recorrencia() {
        // 60% vindo do próprio autoplay: peso 0.6·0.6 = 0.36 < 0.55 — não
        // qualifica sozinho (anti-feedback-loop), qualifica ao repetir.
        let uma = vec![ev(30, 0.60, "autoplay", NOW)];
        let (positives, _) = derive_behavioral_signals(&uma, &[], &[], NOW);
        assert!(!positives.contains(&30), "passivo parcial único não qualifica");

        let duas = vec![
            ev(30, 0.60, "autoplay", NOW),
            ev(30, 0.65, "autoplay", NOW - DAY),
        ];
        let (positives, _) = derive_behavioral_signals(&duas, &[], &[], NOW);
        assert!(positives.contains(&30), "recorrência passiva qualifica");
    }

    #[test]
    fn derive_escutas_rasas_nao_somam_qualificacao_por_count() {
        // Duas escutas de 35% (peso ~0.1 cada) não viram positivo só por
        // serem duas — o critério é peso acumulado, não contagem.
        let pos = vec![
            ev(40, 0.35, "manual", NOW),
            ev(40, 0.35, "manual", NOW - DAY),
        ];
        let (positives, _) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert!(!positives.contains(&40));
    }

    #[test]
    fn derive_decay_prioriza_recente_sobre_count_antigo() {
        // 3 fulls há 60 dias (score ~3·0.052) perdem de 2 fulls de hoje (~2.0).
        let pos = vec![
            ev(1, 1.0, "manual", NOW - 60 * DAY),
            ev(1, 1.0, "manual", NOW - 60 * DAY),
            ev(1, 1.0, "manual", NOW - 61 * DAY),
            ev(2, 1.0, "manual", NOW),
            ev(2, 1.0, "manual", NOW - DAY),
        ];
        let (positives, _) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert_eq!(positives[0], 2, "recência com decay vence count antigo");
        assert!(positives.contains(&1));
    }

    #[test]
    fn derive_desconto_origem_passiva() {
        // Mesmo count/idade: plays passivos (autoplay) valem 0.6 — escolha
        // ativa (manual) rankeia acima.
        let pos = vec![
            ev(1, 1.0, "autoplay", NOW),
            ev(1, 1.0, "autoplay", NOW),
            ev(2, 1.0, "manual", NOW),
            ev(2, 1.0, "manual", NOW),
        ];
        let (positives, _) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert_eq!(positives, vec![2, 1]);
    }

    // ── balanço líquido por track: escutas somam, skips subtraem ───────────
    //
    // O saldo (com decay) decide o lado — não há mais regra de "conflito":
    // a mesma track pode ter escutas boas e skips, e o que vale é o
    // percentual geral acumulado dela.

    #[test]
    fn derive_balanco_liquido_decide_o_lado() {
        // track 1: 2 fulls recentes + 1 skip recente → saldo positivo
        //   (+1 +1 −0.6 = +1.4) → positive apesar do skip.
        // track 2: 1 full de 30 dias (+0.23 após decay) + 2 skips recentes
        //   (−1.2) → saldo bem negativo → negative apesar do full antigo.
        let pos = vec![
            ev(1, 1.0, "manual", NOW),
            ev(1, 1.0, "manual", NOW - DAY),
            ev(2, 1.0, "manual", NOW - 30 * DAY),
        ];
        let neg = vec![
            ev(1, 0.0, "queue", NOW),
            ev(2, 0.0, "queue", NOW),
            ev(2, 0.0, "queue", NOW - DAY),
        ];
        let (positives, negatives) = derive_behavioral_signals(&pos, &neg, &[], NOW);
        assert!(positives.contains(&1), "saldo positivo vence 1 skip");
        assert!(!negatives.contains(&1));
        assert!(negatives.contains(&2), "2 skips recentes afundam full antigo");
        assert!(!positives.contains(&2));
    }

    #[test]
    fn derive_skip_unico_antigo_envelhece_e_sai_dos_negatives() {
        // Skip único de 20 dias: −0.6·0.5^(20/14) ≈ −0.22 — acima do piso
        // de −0.30: a aversão de UM skip expira sozinha (~2,5 semanas).
        // Skips REPETIDOS antigos permanecem (2×−0.22 ≈ −0.44).
        let neg = vec![
            ev(1, 0.0, "queue", NOW - 20 * DAY),
            ev(2, 0.0, "queue", NOW - 20 * DAY),
            ev(2, 0.0, "queue", NOW - 21 * DAY),
        ];
        let (_, negatives) = derive_behavioral_signals(&[], &neg, &[], NOW);
        assert!(!negatives.contains(&1), "skip único antigo expira");
        assert!(negatives.contains(&2), "aversão recorrente permanece");
    }

    #[test]
    fn derive_negatives_dedup_recencia_e_cap_40() {
        // 45 tracks distintas com skips (mais recentes primeiro) + repetições
        // da primeira: dedup preserva a primeira ocorrência, cap em 40.
        let mut neg = Vec::new();
        for i in 0..45u64 {
            neg.push(ev(100 + i, 0.02, "queue", NOW - i as i64));
        }
        neg.push(ev(100, 0.02, "queue", NOW - 100));
        let (_, negatives) = derive_behavioral_signals(&[], &neg, &[], NOW);
        assert_eq!(negatives.len(), 40);
        assert_eq!(negatives[0], 100);
        assert_eq!(negatives.iter().filter(|id| **id == 100).count(), 1);
    }

    #[test]
    fn derive_likes_apendados_sem_duplicar_nem_contrariar_negatives() {
        // like 5 é novo → entra; like 1 já é positive comportamental → não
        // duplica; like 9 está nos negatives → fica fora.
        let pos = vec![ev(1, 1.0, "manual", NOW), ev(1, 1.0, "manual", NOW)];
        let neg = vec![ev(9, 0.02, "queue", NOW)];
        let (positives, negatives) = derive_behavioral_signals(&pos, &neg, &[5, 1, 9], NOW);
        assert_eq!(positives.iter().filter(|id| **id == 1).count(), 1);
        assert!(positives.contains(&5));
        assert!(!positives.contains(&9));
        assert!(negatives.contains(&9));
    }

    #[test]
    fn derive_saldo_positivo_fora_do_top25_nao_vira_negative() {
        // 26 tracks de saldo positivo; a track 999 (full de 5 dias + skip
        // de 20 dias, saldo ≈ +0.56) fica fora do top-25 por score — mas
        // saldo positivo NUNCA vira negative por causa do truncate.
        let mut pos = Vec::new();
        for i in 0..25u64 {
            pos.push(ev(500 + i, 1.0, "manual", NOW));
            pos.push(ev(500 + i, 1.0, "manual", NOW - DAY));
        }
        pos.push(ev(999, 1.0, "manual", NOW - 5 * DAY));
        let neg = vec![ev(999, 0.05, "queue", NOW - 20 * DAY)];
        let (positives, negatives) = derive_behavioral_signals(&pos, &neg, &[], NOW);
        assert!(!positives.contains(&999), "fora do top-25 por score");
        assert!(!negatives.contains(&999), "saldo positivo jamais vira negative");
    }

    // ── piso de atenção: full listen de skit não é compromisso ─────────────

    fn ev_dur(tid: u64, lp: f64, origin: &str, started_at: i64, duration_ms: u64) -> Value {
        json!({
            "track_id": tid,
            "listen_pct": lp,
            "origin": origin,
            "started_at": started_at,
            "duration_ms": duration_ms,
            "end_position_ms": (lp * duration_ms as f64) as u64
        })
    }

    #[test]
    fn derive_full_de_skit_curto_nao_qualifica_sozinho() {
        // Skit de 40s ouvido inteiro: 40s de atenção → peso 1.0·(40/90) ≈
        // 0.44 < 0.55 — não qualifica sozinho (com recorrência, sim).
        // Música de 3min ouvida inteira qualifica normal.
        let uma = vec![ev_dur(50, 1.0, "manual", NOW, 40_000)];
        let (positives, _) = derive_behavioral_signals(&uma, &[], &[], NOW);
        assert!(!positives.contains(&50), "skit full único não qualifica");

        let musica = vec![ev_dur(51, 1.0, "manual", NOW, 180_000)];
        let (positives, _) = derive_behavioral_signals(&musica, &[], &[], NOW);
        assert!(positives.contains(&51), "3min full qualifica");

        let duas = vec![
            ev_dur(50, 1.0, "manual", NOW, 40_000),
            ev_dur(50, 1.0, "manual", NOW - DAY, 40_000),
        ];
        let (positives, _) = derive_behavioral_signals(&duas, &[], &[], NOW);
        assert!(positives.contains(&50), "skit recorrente qualifica");
    }

    #[test]
    fn derive_piso_de_atencao_nao_bonifica_faixas_longas() {
        // 60% de 8min (288s ouvidos) e 60% de 3min (108s) — ambos acima do
        // piso de 90s: peso IGUAL (0.6). Duração absoluta não bonifica.
        let pos = vec![
            ev_dur(60, 0.60, "manual", NOW, 480_000),
            ev_dur(61, 0.60, "manual", NOW, 180_000),
        ];
        let (positives, _) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert!(positives.contains(&60));
        assert!(positives.contains(&61));
    }

    #[test]
    fn derive_cap_25_comportamentais_e_desempate_deterministico() {
        // 30 tracks qualificadas com score idêntico → 25 no resultado, e o
        // desempate final é por track_id (determinístico entre execuções —
        // o HashMap não pode decidir a ordem).
        let mut pos = Vec::new();
        for i in 0..30u64 {
            pos.push(ev(200 + i, 1.0, "manual", NOW));
        }
        let (positives, _) = derive_behavioral_signals(&pos, &[], &[], NOW);
        assert_eq!(positives.len(), 25);
        let mut sorted = positives.clone();
        sorted.sort();
        assert_eq!(positives, sorted, "empate total → ordem por track_id");
    }

    #[test]
    fn parse_id_payload_map_ids_u64_grandes_e_pontos_ausentes() {
        let big: u64 = 18_446_744_073_709_551_000;
        let resp = json!({
            "result": [
                { "id": big, "payload": { "energy": 0.8 } },
                { "id": 42, "payload": null }
            ]
        });
        let map = parse_id_payload_map(&resp);
        assert_eq!(map.len(), 2);
        assert_eq!(map[&big]["energy"], json!(0.8));
        assert!(map.contains_key(&42));
        // Ponto não retornado pelo Qdrant simplesmente não aparece no map.
        assert!(!map.contains_key(&99));
        // Resposta sem result → map vazio, sem panic.
        assert!(parse_id_payload_map(&json!({})).is_empty());
    }

    // ── MoodFilters::parse — vocabulário real (fix "workout retorna 0") ────
    //
    // O vocabulário canônico é o que está DE FATO anotado em track_enrichments
    // (24 moods + 14 activities, extraídos da collection real). O parser
    // antigo emitia tags em português que não existiam nos dados — qualquer
    // termo cujo alias não coincidisse acidentalmente com o inglês (ex:
    // "sensual") retornava 0 resultados. Estes testes travam a saída em
    // inglês, idêntica aos tokens anotados.

    /// Dos 4 tokens presentes em AMBOS os vocabulários (driving/chill/focus/
    /// social), o canônico digitado direto resolve para mood — ver docs de
    /// `MoodFilters::parse`.
    const AMBIGUOUS_TOKENS: &[&str] = &["driving", "chill", "focus", "social"];

    #[test]
    fn mood_e_activity_vocab_tem_o_tamanho_esperado() {
        assert_eq!(MOOD_VOCAB.len(), 24, "MOOD_VOCAB deveria ter os 24 moods anotados em track_enrichments");
        assert_eq!(ACTIVITY_VOCAB.len(), 14, "ACTIVITY_VOCAB deveria ter as 14 activities anotadas em track_enrichments");
    }

    #[test]
    fn parse_todos_os_moods_canonicos_caem_em_mood_tags_com_token_identico() {
        for tag in MOOD_VOCAB {
            let f = MoodFilters::parse(tag);
            assert_eq!(
                f.mood_tags,
                vec![tag.to_string()],
                "mood '{tag}' digitado direto deveria virar mood_tags=[{tag}]"
            );
            assert!(
                f.activity_tags.is_empty(),
                "mood '{tag}' nao deveria vazar pra activity_tags"
            );
        }
    }

    #[test]
    fn parse_activities_nao_ambiguas_caem_em_activity_tags_com_token_identico() {
        for tag in ACTIVITY_VOCAB {
            if AMBIGUOUS_TOKENS.contains(tag) {
                continue; // cobertas pelo teste de ambiguidade abaixo
            }
            let f = MoodFilters::parse(tag);
            assert_eq!(
                f.activity_tags,
                vec![tag.to_string()],
                "activity '{tag}' digitada direto deveria virar activity_tags=[{tag}]"
            );
            assert!(
                f.mood_tags.is_empty(),
                "activity '{tag}' nao deveria vazar pra mood_tags"
            );
        }
    }

    #[test]
    fn parse_tokens_ambiguos_digitados_direto_preferem_mood() {
        // "driving", "chill", "focus" e "social" existem nos dois vocabulários.
        // Regra: o token canônico digitado direto prefere mood (uso mais
        // comum); aliases claramente de atividade (ex: "dirigir", "relaxar")
        // é que resolvem pra activity — ver teste seguinte.
        for tag in AMBIGUOUS_TOKENS {
            let f = MoodFilters::parse(tag);
            assert_eq!(
                f.mood_tags,
                vec![tag.to_string()],
                "token ambíguo '{tag}' digitado direto deve preferir mood"
            );
            assert!(
                f.activity_tags.is_empty(),
                "token ambíguo '{tag}' nao deve duplicar em activity_tags quando digitado direto"
            );
        }
    }

    #[test]
    fn parse_aliases_de_atividade_resolvem_ambiguo_para_activity() {
        // Mesma string final do teste anterior (chill/driving/focus/social),
        // mas via alias inequivocamente de atividade — aqui vai pra activity,
        // nao pra mood. Nao empurra pros dois buckets a partir do mesmo token.
        let casos = [
            ("relaxar", "chill"),
            ("calmo", "chill"),
            ("dirigir", "driving"),
            ("carro", "driving"),
            ("trabalhar", "focus"),
            ("churrasco", "social"),
            ("bbq", "social"),
        ];
        for (alias, esperado) in casos {
            let f = MoodFilters::parse(alias);
            assert_eq!(
                f.activity_tags,
                vec![esperado.to_string()],
                "alias '{alias}' deveria virar activity_tags=[{esperado}]"
            );
            assert!(
                f.mood_tags.is_empty(),
                "alias '{alias}' nao deveria vazar pra mood_tags"
            );
        }
    }

    #[test]
    fn parse_workout_bug_original_retorna_activity_tags_workout() {
        // Caso relatado: "workout" produzia activity_tags=["malhar"] (PT) e
        // 0 faixas, porque track_enrichments so tem "workout" (EN).
        let f = MoodFilters::parse("workout");
        assert_eq!(f.activity_tags, vec!["workout".to_string()]);
        assert!(f.mood_tags.is_empty());
    }

    #[test]
    fn parse_dark_retorna_mood_tags_dark() {
        let f = MoodFilters::parse("dark");
        assert_eq!(f.mood_tags, vec!["dark".to_string()]);
    }

    #[test]
    fn parse_aliases_pt_mapeiam_pro_token_ingles_dos_dados() {
        assert_eq!(MoodFilters::parse("sombrio").mood_tags, vec!["dark".to_string()]);
        assert_eq!(MoodFilters::parse("misterioso").mood_tags, vec!["dark".to_string()]);
        assert_eq!(MoodFilters::parse("malhar").activity_tags, vec!["workout".to_string()]);
        assert_eq!(MoodFilters::parse("treino").activity_tags, vec!["workout".to_string()]);
        assert_eq!(MoodFilters::parse("triste").mood_tags, vec!["melancholic".to_string()]);
        assert_eq!(MoodFilters::parse("alegre").mood_tags, vec!["uplifting".to_string()]);
        assert_eq!(MoodFilters::parse("agressivo").mood_tags, vec!["aggressive".to_string()]);
        assert_eq!(MoodFilters::parse("romântico").mood_tags, vec!["romantic".to_string()]);
        assert_eq!(MoodFilters::parse("nostalgia").mood_tags, vec!["nostalgic".to_string()]);
        assert_eq!(MoodFilters::parse("rebelde").mood_tags, vec!["rebellious".to_string()]);
        assert_eq!(MoodFilters::parse("sexy").mood_tags, vec!["sensual".to_string()]);
        assert_eq!(MoodFilters::parse("empoderador").mood_tags, vec!["confident".to_string()]);
        assert_eq!(MoodFilters::parse("estudar").activity_tags, vec!["study".to_string()]);
        assert_eq!(MoodFilters::parse("foco").activity_tags, vec!["study".to_string()]);
        assert_eq!(MoodFilters::parse("festa").activity_tags, vec!["party".to_string()]);
        assert_eq!(MoodFilters::parse("dormir").activity_tags, vec!["sleep".to_string()]);
        assert_eq!(MoodFilters::parse("meditar").activity_tags, vec!["meditation".to_string()]);
        assert_eq!(MoodFilters::parse("cozinhar").activity_tags, vec!["cooking".to_string()]);
    }

    #[test]
    fn parse_road_trip_bigram_mapeia_activity_driving_nao_placeholder_antigo() {
        // Bug antigo: "road trip" virava activity_tags=["road_trip"], uma
        // tag que nunca existiu em track_enrichments.
        let f = MoodFilters::parse("road trip");
        assert_eq!(f.activity_tags, vec!["driving".to_string()]);
    }

    #[test]
    fn parse_genero_bigram_ainda_funciona_pos_fix() {
        // Bigrams de genre/energy/valence nao fazem parte do fix — regressao.
        assert_eq!(MoodFilters::parse("funk br").genre, Some("Funk Brasileiro".to_string()));
        assert_eq!(MoodFilters::parse("hip hop").genre, Some("Rap & Hip-Hop".to_string()));
        assert_eq!(MoodFilters::parse("alta energia").energy_min, Some(0.7));
    }

    #[test]
    fn parse_dedup_e_sort_mantidos_para_multiplos_tokens() {
        let f = MoodFilters::parse("dark dark uplifting");
        assert_eq!(f.mood_tags, vec!["dark".to_string(), "uplifting".to_string()]);
    }
}
