# Contexto: Migracao SolidJS — V2 Completa

**Data:** 2026-05-02
**Branch:** `feature/solid-migration` (nao mergeada, nao commitada)
**Sessao:** ~4h, frontend-heavy

---

## O que foi feito

### 1. Correcao de tipos no tauri.ts
Todos os IDs mudaram de `string` para `number` (compativel com `i64` do Rust/serde). Campos faltantes adicionados: `track_number`, `genre_name`, `last_played` em Track; `album_artist_name`, `artist_id` em Album. Signature de `playerPlay` e `playerSetOrigin` corrigida (`trackId: number | null`).

Wrappers IPC adicionados: `libGetArtist`, `libGetAlbumsByArtist`, `libListMoods`, `libListMoodTracks`, `checkForUpdate`, `installUpdate`.

### 2. Todas as 14 views migradas para SolidJS
Views que eram stubs ("Pendente migracao") ou tinham markup inventado pelo Claude Design foram reescritas com as classes CSS reais do vanilla JS.

| View | Tipo de trabalho |
|------|-----------------|
| Album.tsx | Reescrita completa — `album-detail` hero + track table |
| Artist.tsx | Reescrita completa — `artist-detail` hero + discography card-grid |
| Queue.tsx | Reescrita completa — `queue-list` / `queue-row` |
| Settings.tsx | Reescrita completa — Library/Audio/Embedding/Updates/About |
| Home.tsx | Implementada do zero — quick start, recent, recs, albums, stats, genres |
| Albums.tsx | Implementada do zero — card-grid com covers |
| Artists.tsx | Implementada do zero — card-grid com iniciais |
| Tracks.tsx | Implementada do zero — track-table completa com covers |
| History.tsx | Implementada do zero — track-table com "played ago" |
| Stations.tsx | Implementada do zero — station-grid + detail view com tracks |
| Signal.tsx | Implementada do zero — EQ 16 bandas + canvas + Limiter + Bass Enhancer |
| Library.tsx | Corrigida — genre chips, stats completas, filtro por genero |
| Playlists.tsx | Corrigida — folder-list (nao card-grid), Liked Songs, context menu |
| NowPlaying.tsx | Ja estava OK, simplificada (porta fixa) |

### 3. Context menu integrado em todas as views com tracks
`showTrackMenu` importado de `src/js/components/context-menu.js` e wired via `onContextMenu` + `onClick` no botao More em: Album, Tracks, History, Stations, Playlists.

### 4. Signal.tsx com fix de sliders
Gerado mock HTML via Gemini 2.5 Pro API com foco no fix de interacao dos faders/sliders. Convertido pra SolidJS. Fix: `setPointerCapture` + calculo de posicao direto no bounding rect do track (sem offset do thumb).

### 5. PlayerBar fixes
- `StateChanged: "Playing"` nao era tratado — adicionado `setPlayingState(true)`
- Update otimista no click play/pause (feedback visual instantaneo)
- `doAutoplay` fix: usava `player.queue[player.queueIndex]` apos `setQueue` (stale reference) — agora usa `newQueue[newIndex]`
- Tipos corrigidos: `recentlyPlayedIds` de `Set<string>` para `Set<number>`, `doAutoplay(seedId: number)`

### 6. CSP + Media server porta fixa
CSP bloqueava `<video>` porque `http://127.0.0.1` sem porta so permite porta 80. Porta do media server fixada em 19876 (era aleatoria). CSP atualizado com `connect-src http://127.0.0.1:19876` e `media-src http://127.0.0.1:19876`.

### 7. Auditoria via Gemini 2.5 Pro API
Script Python (`/tmp/gemini-audit-views.py`) que concatena todos os JS + TSX + CSS e manda pro Gemini auditar discrepancias. Rodado 2x: primeira identificou issues, segunda confirmou resolucao.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/tauri.ts` | Modificado | IDs number, campos extras, wrappers novos |
| `src/views/*.tsx` (14 files) | Reescrito/Criado | Todas as views migradas |
| `src/components/PlayerBar.tsx` | Modificado | Play/pause fix, autoplay fix, tipos |
| `src/store/player.ts` | Sem mudanca | Store reativo ja funcionava |
| `src-tauri/src/lib.rs` | Modificado | Porta fixa 19876 no media server |
| `src-tauri/tauri.conf.json` | Modificado | CSP com media-src e connect-src para 127.0.0.1:19876 |
| `src/js/views/now-playing.js` | Modificado | URL fixa (porta 19876) |

## Decisoes tomadas

- **Porta fixa 19876 pro media server**: CSP nao suporta wildcard de porta. Alternativa (desabilitar CSP) descartada por seguranca.
- **Context menu vanilla JS reutilizado**: `showTrackMenu` do `context-menu.js` importado diretamente nos TSX. Funciona porque usa DOM imperativo. Alternativa (reescrever em Solid) descartada por complexidade desnecessaria.
- **Signal.tsx via Gemini mock**: Gerado HTML de referencia com sliders corrigidos, depois convertido manualmente pra SolidJS. Approach mais rapido que portar 1119 linhas do signal.js diretamente.
- **DB_RANGE mantido em 36**: O mock Gemini usou 18, mas o original usa 36. Mantido 36 pra compatibilidade com presets existentes.

## Pendencias

1. **(alta) Video de fundo trava/engasga** — nao e CSP (resolvido), nao e codec (H.264 funciona). Parece ser performance do WebKitGTK decodando video + audio. Recodificar pra resolucao menor nao ajudou. Investigar buffer size, decode pipeline, ou usar alternativa (CSS animation, canvas).
2. **(alta) Filtro de busca em Albums, Artists, Tracks** — vanilla JS usa `window.addEventListener("search-filter", ...)` emitido pelo SearchBar. Solid SearchBar precisa emitir esse evento ou usar store compartilhado.
3. **(alta) Commit e merge** — NADA foi commitado nesta sessao. 30+ arquivos novos/modificados. Precisa commit atomico e merge na main.
4. **(media) Signal.tsx import/export de presets** — funcoes `importPreset`/`exportPreset` tem stubs simplificados (nao implementa `parseEasyEffects`/`toEasyEffects` completo). Funciona pra presets locais mas nao pra import de EasyEffects JSON.
5. **(media) Albums cover lazy loading** — vanilla carrega covers async com `new Image()` + `onload`. Solid renderiza `<img>` direto (pode causar pop-in).
6. **(baixa) `getMediaPort` dead code** — funcao no tauri.ts nao e mais usada (NowPlaying usa URL fixa). Pode remover.
