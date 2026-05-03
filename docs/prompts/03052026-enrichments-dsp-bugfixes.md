# Retomada: Track Enrichments + DSP Fixes

## Contexto rapido

Sessao extensa de bugfixes e refactor arquitetural no Rustify Player. Principal
mudanca: nova collection Qdrant `track_enrichments` que isola dados de
usuario/enrichment do scan de library — o rescan nao destroi mais likes,
play counts, mood tags, ou dominant_color. Tambem corrigido: DSP bypass
cumulativo, preset save, history loading, autoplay (i64→u64 em toda a cadeia
de IDs). Mudancas nao commitadas.

## Arquivos principais

- `src-tauri/crates/library-indexer/src/qdrant_client.rs` — CRUD enrichments, i64→u64
- `src-tauri/crates/library-indexer/src/query.rs` — play/like/history via enrichments
- `src-tauri/crates/audio-engine/src/output/dsp.rs` — bypass state tracking
- `src/store/dsp.ts` — per-key debounce, reentrant guard
- `src/views/Signal.tsx` — preset save/create
- `docs/contexto/03052026-enrichments-dsp-bugfixes.md` — contexto detalhado
- `docs/superpowers/specs/2026-05-03-track-enrichments-collection-design.md` — spec
- `scripts/migrate-enrichments.py` — migracao one-time (ja executada na cmr-auto)

<session_metadata>
branch: main
last_commit: 454a0ef (pre-sessao)
uncommitted_changes: 16 files
enrichments_migrated: 934 tracks na cmr-auto
play_events: collection recriada (limpa)
mood_tags: NAO populados (Gemini precisa re-rodar)
</session_metadata>

## Proximos passos (por prioridade)

### 1. Commitar todas as mudancas
**Onde:** root do repo
**O que:** `git add` dos 16 arquivos modificados + novos, commit
**Por que:** tudo esta uncommitted — risco de perda
**Verificar:** `git status` limpo

### 2. Re-rodar Gemini mood classifier
**Onde:** `scripts/` — adaptar `gemini_mood_classifier.py` (versao antiga, usa SQLite)
**O que:** batch de 983 tracks via Gemini, gravar mood_tags/activity_tags/energy/valence na `track_enrichments` collection. SALVAR output JSON em `data/mood-classifications.json` e commitar.
**Por que:** mood tags foram perdidos no rescan anterior. Stations (CMR-61) estao bloqueadas.
**Verificar:** `curl -s POST http://localhost:6333/collections/track_enrichments/points/scroll -d '{"limit":1,"with_payload":{"include":["mood_tags"]}}' | jq '.result.points[0].payload.mood_tags'`

### 3. Validar preset save no app
**Onde:** Signal.tsx, tela Signal no app
**O que:** criar preset, modificar EQ, salvar, recarregar app, verificar que preset persiste
**Por que:** usuario reportou que "nao salva" — fix aplicado mas nao validado end-to-end
**Verificar:** localStorage no DevTools: `rustify-dsp-presets`

### 4. Genre filter two-pass no mood_search (baixa)
**Onde:** `src-tauri/src/lib.rs`, `lib_mood_search`
**O que:** quando query inclui genero, filtrar por mood na enrichments, depois post-filtrar por genero na rustify_tracks (ja parcialmente implementado)
**Por que:** mood queries com genero retornam vazio porque genero nao esta na enrichments collection
**Verificar:** buscar "rock energia" na search bar, verificar que retorna tracks de rock

## Como verificar

```bash
cargo check --manifest-path src-tauri/Cargo.toml  # compilacao limpa
# Na cmr-auto apos instalar:
# Tocar musica → history deve aparecer
# Like → liked view deve mostrar
# Autoplay → deve recomendar proxima ao fim da track
# Signal → bypass toggle nao degrada audio
```
