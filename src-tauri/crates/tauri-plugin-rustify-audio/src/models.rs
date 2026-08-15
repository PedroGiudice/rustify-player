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

/// Item da fila NATIVA, do jeito que o servico a enxerga. `origin`/`context_id`
/// sao por ITEM — o wire ja nasce assim para nao mudar quando o enfileirar
/// avulso chegar (hoje o Kotlin devolve o escalar da fila para todos).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub track_id: String,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    #[serde(default)]
    pub duration_ms: i64,
}

/// Resposta de `get_queue` — a unica leitura da fila real do player.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub items: Vec<QueueEntry>,
    /// Indice corrente; `-1` quando a fila esta vazia.
    pub index: i32,
}

/// Resultado de `next`/`previous`. `moved = false` significa que a fila acabou
/// (ou comecou) — sem isso o botao vira no-op mudo na interface.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub moved: bool,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// O wire do Kotlin e camelCase; o Rust e snake_case. Uma renomeacao
    /// silenciosa aqui so apareceria como "fila vazia" no aparelho — este teste
    /// e o que evita descobrir isso depois de um ciclo de build+install.
    #[test]
    fn queue_snapshot_le_o_wire_exato_do_kotlin() {
        let wire = r#"{
            "items": [
                {"trackId": "18446744073709551615", "origin": "station",
                 "contextId": "chill-romance", "durationMs": 214000}
            ],
            "index": 3
        }"#;
        let snap: QueueSnapshot = serde_json::from_str(wire).unwrap();
        assert_eq!(snap.index, 3);
        assert_eq!(snap.items.len(), 1);
        // u64::MAX passa intacto porque trafega como String em toda a cadeia.
        assert_eq!(snap.items[0].track_id, "18446744073709551615");
        assert_eq!(snap.items[0].origin, "station");
        assert_eq!(snap.items[0].context_id.as_deref(), Some("chill-romance"));
        assert_eq!(snap.items[0].duration_ms, 214_000);
    }

    #[test]
    fn queue_entry_tolera_context_id_nulo_e_duracao_ausente() {
        let wire = r#"{"trackId": "7", "origin": "manual", "contextId": null}"#;
        let entry: QueueEntry = serde_json::from_str(wire).unwrap();
        assert_eq!(entry.context_id, None);
        assert_eq!(entry.duration_ms, 0);
    }

    #[test]
    fn queue_snapshot_vazio_tem_indice_negativo() {
        let snap: QueueSnapshot = serde_json::from_str(r#"{"items": [], "index": -1}"#).unwrap();
        assert!(snap.items.is_empty());
        assert_eq!(snap.index, -1);
    }

    #[test]
    fn step_result_le_moved() {
        let step: StepResult = serde_json::from_str(r#"{"moved": false}"#).unwrap();
        assert!(!step.moved);
    }

    /// Serializa de volta com as MESMAS chaves — o contrato vale nas duas
    /// direcoes (o snapshot tambem viaja pro JS).
    #[test]
    fn queue_snapshot_serializa_em_camel_case() {
        let snap = QueueSnapshot {
            items: vec![QueueEntry {
                track_id: "42".into(),
                origin: "manual".into(),
                context_id: None,
                duration_ms: 1000,
            }],
            index: 0,
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"trackId\":\"42\""), "{json}");
        assert!(json.contains("\"durationMs\":1000"), "{json}");
        assert!(json.contains("\"contextId\":null"), "{json}");
    }
}
