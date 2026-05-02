# Expanded Event Tracking — Design Spec

## Decisões

- **Storage:** Tudo no Qdrant, collection `play_events`. Sem SQLite pra eventos.
- **Granularidade:** 1 ponto por evento atômico, campo `event_type` no payload.
- **Emissão:** Frontend JS via `invoke("log_event", {...})` fire-and-forget.
- **Backend:** Rust command genérico, valida minimamente, upserta no Qdrant.
- **Schema:** Livre. Sem enum tipado. Validação mínima: `event_type` + `timestamp` presentes.
- **Retrocompatibilidade:** `behavioral_signals()` continua filtrando por `event_type: "track_ended"` + `listen_pct`.

## Arquitetura

```
Frontend (JS)                    Rust (Tauri)              Qdrant
─────────────────               ──────────────            ──────────
user action  ──invoke──>  log_event(payload: Value)
                            - valida event_type + timestamp
                            - gera UUID v4
                            - upsert point ──────────> play_events collection
                            - return Ok
```

## Tauri Command

```rust
#[tauri::command]
fn log_event(qdrant: State<Qdrant>, payload: serde_json::Value) -> Result<(), String> {
    let event_type = payload.get("event_type")
        .and_then(|v| v.as_str())
        .ok_or("missing event_type")?;
    if event_type.is_empty() {
        return Err("empty event_type".into());
    }
    payload.get("timestamp").ok_or("missing timestamp")?;

    let client = qdrant.0.as_ref().ok_or("Qdrant not available")?;
    client.insert_raw_event(&payload).map_err(|e| e.to_string())
}
```

## Qdrant Client Method

```rust
pub fn insert_raw_event(&self, payload: &Value) -> Result<(), IndexerError> {
    let point_id = uuid::Uuid::new_v4().to_string();
    let body = json!({
        "points": [{
            "id": point_id,
            "vector": [0.0],
            "payload": payload
        }]
    });
    self.agent
        .put(&format!("{}/collections/{PLAY_EVENTS_COLLECTION}/points", self.base_url))
        .send_json(&body)
        .map_err(|e| IndexerError::Embedding(format!("qdrant insert event: {e}")))?;
    Ok(())
}
```

## Payload Mínimo (todo evento)

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `event_type` | string | sim | Identificador do evento |
| `timestamp` | integer | sim | Unix epoch seconds |
| `track_id` | integer | quando aplicável | Track em contexto |
| `session_id` | string | sim | UUID gerado no app start |

## Event Types — Primeira Leva

| event_type | Campos extras | Trigger no JS |
|------------|---------------|---------------|
| `track_ended` | duration_ms, end_position_ms, listen_pct, origin | TrackEnded payload |
| `skip` | position_ms, duration_ms, origin, next_track_id | next/skip antes de 95% |
| `previous` | position_ms, prev_track_id | Botão previous |
| `seek` | from_ms, to_ms, direction (fwd/bwd) | Seekbar drag end |
| `pause` | position_ms | Pause |
| `resume` | position_ms | Play após pause |
| `volume_change` | old_vol, new_vol | Volume slider change end |
| `queue_add` | source (manual/station/album) | Add to queue |
| `queue_remove` | was_played | Remove from queue |
| `queue_reorder` | old_pos, new_pos | Drag reorder |
| `shuffle_toggle` | enabled, queue_size | Shuffle button |
| `repeat_change` | mode (off/one/all) | Repeat button |
| `search_query` | query_text, results_count | Search submit |
| `search_click` | query_text, result_position | Click no resultado |
| `view_change` | from_view, to_view | Navegação entre views |
| `session_start` | — | App open |
| `session_end` | duration_ms, tracks_played | App close / beforeunload |

## session_id

Gerado com `crypto.randomUUID()` no boot do frontend. Passa em todo evento. Permite agrupar ações numa sessão.

## Frontend: Helper de Emissão

```javascript
const SESSION_ID = crypto.randomUUID();

function logEvent(eventType, data = {}) {
  invoke("log_event", {
    payload: {
      event_type: eventType,
      timestamp: Math.floor(Date.now() / 1000),
      session_id: SESSION_ID,
      ...data,
    },
  }).catch((err) => console.warn("[events]", eventType, err));
}
```

Uso: `logEvent("skip", { track_id: 158, position_ms: 45000, duration_ms: 240000, origin: "queue" })`

## Migração do `insert_play_event` Existente

O command `lib_record_play` e a função `insert_play_event()` em play_events.rs continuam existindo para o `record_play` (SQLite history de plays). O upsert no Qdrant migra para usar `log_event` com `event_type: "track_ended"` emitido pelo frontend, eliminando o dual-path atual (Rust emitindo pro Qdrant no TrackEnded do state loop).

Etapa: remover o upsert Qdrant do `insert_play_event()` e do state loop. O frontend passa a emitir `logEvent("track_ended", {...})` no handler de TrackEnded.

## behavioral_signals() — Sem Breaking Change

A query existente filtra por `listen_pct >= 0.8`. Basta adicionar filtro `event_type == "track_ended"` ao `pos_filter` e `neg_filter` pra ignorar os novos event types. Mudança de 1 linha em cada filtro.

## Implementação (resumo de steps)

1. Criar `insert_raw_event()` no qdrant_client.rs
2. Criar command `log_event` em lib.rs, registrar no handler
3. Criar helper `logEvent()` no frontend (arquivo dedicado ou no player-bar.js)
4. Emitir `session_start` no boot
5. Migrar TrackEnded: frontend emite `track_ended` via logEvent, remover upsert Qdrant do state loop
6. Instrumentar eventos de transporte (skip, previous, seek, pause, resume)
7. Instrumentar volume
8. Instrumentar queue (add, remove, reorder)
9. Instrumentar shuffle/repeat
10. Instrumentar search e navegação
11. Instrumentar session_end (beforeunload)
12. Adicionar filtro `event_type == "track_ended"` no behavioral_signals()
