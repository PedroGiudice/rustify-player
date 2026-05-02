# Contexto: Implicit Feedback, Smart Station, Semantic Search

**Data:** 2026-05-02
**Sessao:** main (commits diretos)
**Duracao:** ~3h

---

## O que foi feito

### 1. Implicit Feedback via Qdrant play_events
Collection `play_events` no Qdrant (payload-only, sem vetor) armazena eventos de playback. Cada TrackEnded grava um ponto com: `track_id`, `origin`, `started_at`, `end_position_ms`, `duration_ms`, `listen_pct`.

`behavioral_signals()` reescrita: lê do Qdrant (scroll + filter) em vez de SQLite. Positives = top 30 tracks com `listen_pct >= 0.8`, repeat bonus (3+ aparicoes = entrada duplicada). Negatives = 15 tracks com `listen_pct < 0.15` excluindo `album_seq`.

Dual-write mantido: SQLite ainda recebe o insert (History view consome). Fallback graceful se Qdrant indisponível.

### 2. Fix EOS no audio engine
`check_eos()` usava polling por posição (`pos >= dur` a cada 50ms) — frágil, GStreamer nem sempre reporta posição final exata. Substituído por `PlaySignalAdapter::connect_end_of_stream` via crossbeam channel. `tick()` agora itera `glib::MainContext::default()` para despachar signals.

### 3. Smart Station "Your Mix"
Card "Your Mix" na view de Stations. Ao clicar, inicia playback infinito usando `lib_autoplay_next` com `track_id=0` (sem seed explícito, usa behavioral_signals como seeds). Queue se replenish automaticamente quando `<= 2 tracks` restantes. `setQueue()` desativa smart station (qualquer ação explícita do usuário sobrescreve).

### 4. Semantic Search por Lyrics
Novo Tauri command `lib_semantic_search`: embeda query via TEI BGE-M3 (`LyricsEmbedClient`), busca no Qdrant named vector `lyrics` (cosine similarity), retorna tracks ordenados por score.

Frontend: busca global (Ctrl+K) roda textual + semântica em paralelo (`Promise.all`). Resultados semânticos aparecem como seção "By Lyrics", deduplicados contra matches textuais. Se TEI indisponível, seção não aparece (`.catch(() => [])`).

**Limitação identificada:** embedding match de lyrics funciona para queries de *conteúdo* ("música sobre saudade") mas não para queries de *mood/contexto* ("músicas pra começar o dia"). Para isso, precisa de LLM.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/library-indexer/Cargo.toml` | Modificado | +uuid dep |
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Modificado | +260 linhas: play_events collection, behavioral_signals, semantic_search |
| `src-tauri/crates/library-indexer/src/play_events.rs` | Modificado | dual-write Qdrant+SQLite, behavioral_signals removida (vive em qdrant_client) |
| `src-tauri/crates/library-indexer/src/lib.rs` | Modificado | signatures atualizadas: insert_play_event e behavioral_signals aceitam Option<&QdrantClient> |
| `src-tauri/src/lib.rs` | Modificado | +lib_semantic_search, QdrantClient movido antes do event-listener spawn, ensure_play_events_collection no startup |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | EOS via signal adapter em vez de polling |
| `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs` | Modificado | #[allow(dead_code)] em duration() |
| `src/js/components/player-bar.js` | Modificado | +smartStationActive, replenishSmartStation(), setQueue desativa smart station |
| `src/js/views/stations.js` | Modificado | +card "Your Mix" com js-smart-station handler |
| `src/js/components/search-bar.js` | Modificado | busca semântica em paralelo, seção "By Lyrics" |
| `docs/superpowers/specs/2026-05-02-implicit-feedback-qdrant-design.md` | Criado | spec do sistema de implicit feedback |
| `docs/superpowers/plans/2026-05-02-implicit-feedback-qdrant.md` | Criado | plano de implementação (5 tasks, executado) |

## Commits desta sessao

```
f9485bc feat(search): add semantic search by lyrics via BGE-M3 embeddings
f4f742c fix(player): deactivate smart station when setQueue is called
4d7d91d feat(stations): add "Your Mix" smart station with infinite playback
32c938f fix(engine): use GStreamer EOS signal instead of position polling
218c6b6 feat: wire Qdrant play_events into event loop and behavioral_signals
8b686e0 feat(qdrant): add play_events collection and behavioral_signals methods
7ffbec3 docs: implementation plan for implicit feedback via Qdrant
a786e68 docs: spec for implicit feedback via Qdrant play_events collection
```

## Decisoes tomadas

- **play_events no Qdrant, não SQLite**: single source of truth para behavioral signals. SQLite mantido apenas para History view (read-only). | Descartado: SQLite-only (overhead de manter dual-storage, risco de dessincronização)
- **Derivação on-demand**: behavioral_signals() faz scroll+filter no Qdrant a cada recomendação em vez de materializar agregados. | Descartado: payloads pré-computados na collection tracks (mais estado pra manter)
- **EOS via GStreamer signal, não polling**: polling por posição era causa raiz de tracks não avançando. | Descartado: manter polling com tolerância (ex: pos >= dur - 500ms) — hack frágil
- **Semantic search como seção adicional**: não substitui busca textual, aparece como "By Lyrics" nos resultados. | Descartado: substituir busca textual por semântica
- **LLM pra queries de mood/contexto**: embedding match de lyrics não resolve "músicas pra começar o dia". Próximo passo é integrar Ollama com catálogo no prompt e output = array de track IDs.

## Metricas

| Metrica | Valor |
|---------|-------|
| Tracks na biblioteca | 983 |
| Lyrics embeddings no Qdrant | 431 |
| Gêneros no Qdrant | 10 (Eletrônica 27%, Rap 25%, Funk BR 17%, Funk&Soul 10%, Rock 10%, MPB 9%) |
| Latência semantic search | ~150ms (embed) + ~30ms (Qdrant) = ~180ms total |
| Modelos Ollama disponíveis | qwen3:14b, qwen3:4b, qwen3:4b-nothink, qwen3:1.7b, deepseek-r1:8b, qwen2.5-coder:14b |

## Pendencias identificadas

1. **Integração Ollama para queries de mood/contexto** (alta) — embedding match não resolve "músicas pra começar o dia". Design discutido: catálogo via scroll Qdrant (ID|título|artista|gênero|duração) no prompt, modelo responde com array JSON de track IDs. Pré-filtro via embedding match (top 50 candidatas) para reduzir prompt size. Modelo recomendado: qwen3:4b-nothink.
2. **Testar EOS fix na cmr-auto** (alta) — release publicado mas ainda não confirmado se tracks avançam automaticamente
3. **Testar smart station "Your Mix"** (alta) — funcionalidade nova, precisa validação de UX
4. **Filtrar tracks < 30s do semantic search** (baixa) — interlúdios de 4s aparecem nos resultados
