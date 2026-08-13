use serde::{Deserialize, Serialize};

/// Item da fila nativa. `track_id` e **String** em toda a cadeia: os ids do
/// acervo sao u64 hash-based e valores acima de 2^53 se corrompem em JS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub track_id: String,
    /// URI tocavel pelo ExoPlayer (`file://`, `content://`, `http(s)://`).
    pub uri: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub artwork_uri: Option<String>,
    #[serde(default)]
    pub duration_ms: i64,
}

/// Substitui a fila inteira do player. `origin`/`context_id` sao carimbados em
/// cada evento gerado por essa fila (mesma semantica do desktop).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetQueueRequest {
    pub items: Vec<QueueItem>,
    #[serde(default)]
    pub start_index: u32,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    #[serde(default = "default_true")]
    pub play_now: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekToRequest {
    pub position_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipToIndexRequest {
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainEventsRequest {
    /// Retorna apenas eventos com `seq` estritamente maior que este valor.
    pub after_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AckEventsRequest {
    /// Marca d'agua de consumo; o journal e compactado ate ela.
    pub upto_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    /// `idle` | `buffering` | `ready` | `ended`
    pub status: String,
    /// Indice na fila; `-1` quando nao ha fila.
    pub index: i32,
    #[serde(default)]
    pub track_id: Option<String>,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub is_playing: bool,
}

/// Linha do journal. Os campos sao **snake_case de proposito**: o schema espelha
/// o payload de `play_events` do desktop (qdrant_client.rs), nao a convencao
/// camelCase dos argumentos de command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayEvent {
    pub seq: i64,
    pub uuid: String,
    /// `track_ended` | `track_skipped`
    pub event_type: String,
    pub track_id: String,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    pub started_at: i64,
    pub timestamp: i64,
    pub end_position_ms: i64,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainEventsResponse {
    pub events: Vec<PlayEvent>,
    /// Maior `seq` ja gravado (mesmo que nenhum evento tenha sido devolvido).
    pub last_seq: i64,
}

/// Payload vazio. O lado Kotlin recebe `{}` — nunca `null`, que quebraria um
/// eventual `invoke.getArgs()`.
#[cfg(target_os = "android")]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(crate) struct EmptyArgs {}
