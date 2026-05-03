# Contexto: Track Enrichments + DSP Fixes + Bugfix Batch

**Data:** 2026-05-03
**Sessao:** main (mudancas nao commitadas)
**Duracao:** ~3h

---

## O que foi feito

### 1. Track Enrichments Collection (CMR-61)

Nova collection Qdrant `track_enrichments` separa dados de usuario/enrichment
do scan de library. O rescan (`upsert_tracks`) nunca mais destrói dados de
playback, likes, mood tags, ou dominant_color.

**Campos migrados:**
- `play_count`, `last_played`, `liked_at` (user behavior)
- `dominant_color` (cover analysis)
- `mood_tags`, `activity_tags`, `energy`, `valence` (Gemini classifier)

**Metodos novos no QdrantClient:**
- `ensure_enrichments_collection()` + `create_enrichment_indices()`
- `get_enrichment(track_id)` / `set_enrichment(track_id, payload)` (com merge)
- `scroll_enrichments(filter, order_by, limit)`
- `mood_search_enrichments(filters, limit)`

**Query.rs migrado:** `record_play`, `list_history`, `toggle_like`, `is_liked`,
`list_liked` — todos leem/escrevem na `track_enrichments`.

**Pipeline.rs limpo:** removidos `play_count: 0`, `last_played: null`,
`liked_at: null`, `dominant_color` do payload de scan.

### 2. Migracao i64 → u64 para point IDs

Track IDs são u64 (hash-based, valores > i64::MAX comuns). Toda a cadeia
usava i64, causando overflow silencioso → IDs negativos → recommend falhava
com 400.

Migrado end-to-end: `scroll_ids`, `recommend`, `behavioral_signals`,
`mood_search_enrichments`, `upsert_batch`, `upsert_lyrics_batch`,
`get_payload`, `semantic_search`, `insert_play_event`.

Regra documentada em `.claude/rules/qdrant-ids-u64.md`.

### 3. DSP Bypass Fix (CMR-56)

`set_bypassed(false)` habilitava limiter e EQ incondicionalmente — mesmo que
o usuario tivesse desligado. Cada toggle adicionava compressão cumulativa.

Fix: `DspFilterBin` agora guarda `eq_was_enabled`, `limiter_was_enabled`,
`bass_was_bypassed`. Metodos `set_eq_enabled`, `set_limiter_enabled`,
`set_bass_bypass` atualizam esses flags. `set_bypassed(false)` restaura.

### 4. DSP Debounce Fix (CMR-56)

- `ipcDebounced` agora usa Map de timers por chave (antes: timer global
  compartilhado que cancelava mudancas em bandas diferentes)
- `applyFullDspState` tem guard de reentrada (se chamado durante execucao,
  enfileira e re-executa com estado atualizado)
- `safe_db_to_linear()` no backend: rejeita NaN/infinity, clamp [-60, +24] dB

### 5. Preset Fix (CMR-57)

- `applyPresetToState` esperava mode como string, savePreset salvava como
  numero. Fix: handle both types
- Save agora sobrescreve preset ativo (sem prompt); botao "New" para criar
- Preset agora inclui `bypass` no save

### 6. History Fix (CMR-55)

- `ensure_collection` fazia early return pulando `create_payload_indices`.
  Sem index em `last_played`, o `order_by` do scroll falhava
- History view agora tem error boundary (nao trava navegacao)

### 7. Settings: Restart (CMR-58)

- `restart_app` Tauri command via `app.restart()`
- Botao "Restart Now" aparece apos instalar update

### 8. Background/Cover Art Deploy

- 30 WebP backgrounds convertidos de recolor-v5-kmeans e deployados em
  `~/.local/share/rustify-player/media/bg/` na cmr-auto
- `palette.json` gerado com cores medias RGB
- `dominant_color` populado em 916/983 tracks via batch script

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Modificado | +enrichments collection, +CRUD, i64→u64, -old mood_search |
| `src-tauri/crates/library-indexer/src/query.rs` | Modificado | play/like/history → enrichments, +resolve helper |
| `src-tauri/crates/library-indexer/src/lib.rs` | Modificado | +ensure_enrichments, behavioral_signals u64 |
| `src-tauri/crates/library-indexer/src/pipeline.rs` | Modificado | removidos enrichment fields do scan payload |
| `src-tauri/crates/audio-engine/src/output/dsp.rs` | Modificado | bypass state tracking, safe_db_to_linear, mut methods |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | &mut para set_eq_enabled/limiter/bass |
| `src-tauri/src/lib.rs` | Modificado | mood_search→enrichments, get_track_color→enrichments, +restart_app, i64→u64 |
| `src/store/dsp.ts` | Modificado | per-key debounce, reentrant guard |
| `src/views/Signal.tsx` | Modificado | preset save fix, +createPreset, mode type handling |
| `src/views/History.tsx` | Modificado | +error boundary |
| `src/views/Settings.tsx` | Modificado | +restart button |
| `src/tauri.ts` | Modificado | +restartApp |
| `scripts/migrate-enrichments.py` | Criado | one-time migration script |
| `.claude/rules/qdrant-ids-u64.md` | Criado | regra de projeto |
| `docs/superpowers/specs/2026-05-03-track-enrichments-collection-design.md` | Criado | spec |
| `docs/superpowers/plans/2026-05-03-track-enrichments-collection.md` | Criado | plano |

## Decisoes tomadas

- **Collection separada (B) vs merge no pipeline (A):** Escolhido B — isolamento total. O scan nunca toca na enrichments collection. Custo: round-trip extra no Qdrant ao resolver tracks.
- **i64→u64 completo vs cast pontual:** Completo — previne regressoes futuras. Documentado como regra de projeto.
- **Bypass state tracking vs applyFullState no toggle:** State tracking no backend — mais robusto, nao depende do frontend chamar re-apply.
- **Preset save overwrite vs prompt:** Overwrite automatico do preset ativo; botao "New" separado para criacao.
- **play_events limpos:** Collection recriada do zero (62 eventos com IDs antigos/negativos, dados insignificantes).

## Pendencias identificadas

1. **Mood tags nao populados** (alta) — Gemini classifier precisa re-rodar. Output anterior perdido (nao salvo). ~$1-2 de custo. Salvar JSON no repo desta vez.
2. **Stations nao funcionam** (alta) — CMR-61. Dependem de mood_tags que nao existem na enrichments collection. Bloqueado pelo item 1.
3. **Preset save "nao salva"** (media) — usuario reportou que nao salva. O fix de overwrite foi aplicado mas precisa validar no app.
4. **Genre filter no mood_search** (baixa) — genre vive em rustify_tracks, mood_search filtra enrichments. Precisa two-pass query. Funcional sem genre filter por enquanto.
5. **CMR-59: EQ automatico por genero** (baixa) — no backlog, nao tocado.
6. **Commit pendente** — nenhum commit foi feito nesta sessao. Todas as mudancas estao uncommitted.
