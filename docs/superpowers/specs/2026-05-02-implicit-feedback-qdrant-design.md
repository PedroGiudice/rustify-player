# Implicit Feedback via Qdrant

## Objetivo

Capturar sinais de interação do usuário (skips, repeats, completions) e usá-los para enriquecer as recomendações do autoplay. Substitui o modelo binário atual (completed/skipped < 5s) por derivação rica a partir de eventos granulares.

## Arquitetura

```
TrackEnded event (GStreamer → Rust)
  ├── Grava ponto na collection "play_events" (Qdrant)
  └── lib_autoplay_next()
        └── behavioral_signals()
              ├── Scroll play_events (Qdrant filter + limit)
              ├── Deriva positives/negatives/exclusions (Rust)
              └── client.recommend() na collection "tracks"
```

Single source of truth: Qdrant. Sem SQLite no fluxo de interação.

## Collection: play_events

Pontos payload-only (sem vetor). Um ponto por evento de playback.

### Schema do payload

| Campo | Tipo | Descrição |
|-------|------|-----------|
| track_id | integer | FK lógica pro ponto na collection tracks |
| origin | keyword | manual, autoplay, shuffle, album_seq |
| started_at | keyword (ISO 8601) | Início do playback |
| end_position_ms | integer | Posição onde parou (ms) |
| duration_ms | integer | Duração total da track (ms) |
| listen_pct | float | end_position_ms / duration_ms (0.0–1.0) |

### Índices de payload

- `track_id`: integer index (filter por track)
- `listen_pct`: float index (range filter)
- `started_at`: keyword index (ordering por recência)
- `origin`: keyword index (exclusão de album_seq)

### Point ID

UUID v4 gerado no Rust (uuid crate). Sem significado semântico.

## Derivação de sinais (behavioral_signals)

Executado on-demand a cada chamada de recomendação.

### Positives (seeds pro Recommend)

1. Scroll últimos 100 eventos onde `listen_pct >= 0.8`
2. Extrair `track_id` distintos, limit 30
3. Repeat detection: track_ids que aparecem 3+ vezes → duplicados na lista (peso extra no centroide)
4. Track atual é sempre positives[0]

### Negatives (afasta do centroide)

1. Scroll últimos 50 eventos onde `listen_pct < 0.15` AND `origin != album_seq`
2. Extrair `track_id` distintos, limit 15

### Exclusão hard (must_not filter no Recommend)

Track_ids cujos últimos 3 eventos são todos `listen_pct < 0.15` → excluídos completamente via filter condition no Recommend request.

## Mudanças no código

### library-indexer crate

- `play_events.rs`: reescrever `insert_play_event()` → chama Qdrant upsert na collection play_events
- `play_events.rs`: reescrever `behavioral_signals()` → scroll Qdrant + agregação Rust
- `qdrant_client.rs`: novos métodos `insert_play_event()`, `scroll_play_events(filter, limit)`

### src-tauri/src/lib.rs

- TrackEnded handler: chamar novo `insert_play_event` que vai pro Qdrant (em vez de indexer SQL)
- `lib_autoplay_next`: sem mudança de interface, `behavioral_signals()` muda internamente

### Startup

- Criar collection `play_events` se não existir (payload-only, sem vector config)
- Criar payload indices

## O que morre

- Tabela SQLite `play_events` (migration 008): para de ser alimentada
- Queries SQL em `behavioral_signals()` e `insert_play_event()`

## Thresholds

| Sinal | Threshold | Racional |
|-------|-----------|----------|
| Completed | listen_pct >= 0.8 | 80% é "ouviu" (permite skip de outro no final) |
| Skip forte | listen_pct < 0.15 | ~30s numa track de 3:30. Padrão Spotify. |
| Repeat | 3+ completions nos últimos 50 eventos | Repetição intencional vs casual |
| Skip streak (exclusão) | 3 skips consecutivos | Rejeição persistente |

## Não-escopo (futuro)

- Padrões temporais (hora do dia)
- Contextualização por playlist/mood de origem
- Decay temporal nos pesos (recency bias além da ordenação)
- UI de "favoritos implícitos"
