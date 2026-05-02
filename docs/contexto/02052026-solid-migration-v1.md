# Contexto: Migracao SolidJS — V1 Incompleta

**Data:** 2026-05-02
**Branch:** `feature/solid-migration` (nao mergeada)
**Sessao:** ~3h, frontend + backend

---

## O que aconteceu

### 1. Now Playing mockup (fundo de video)
Tentativa de implementar video de fundo na view Now Playing conforme mockup do Claude Design.

**Descoberta critica:** `<video>` nao funciona no Tauri/WebKitGTK via protocolo `asset://localhost/` — o media pipeline do GStreamer nao recebe range requests pelo protocol handler. Confirmado com MP4 (H.264) e WebM (VP9), tanto embeddado no binario quanto via `convertFileSrc()` do filesystem.

**Workaround implementado:** Mini HTTP server local em Rust (stdlib pura, `TcpListener`) que serve `~/.local/share/rustify-player/media/` em `127.0.0.1:<porta aleatoria>` com suporte a range requests. Commit `5c7f303`. Frontend busca porta via `invoke("get_media_port")`. Video de fundo nao testado end-to-end via HTTP ainda.

### 2. Migracao SolidJS + Vite
Usuario decidiu migrar o frontend de vanilla JS para SolidJS com Vite. Claude Design produziu bundle completo em `/tmp/design-extract-2/rustify-player/project/solid-migration/`.

**O bundle do Claude Design tinha problemas graves:**

1. **IPC commands com nomes errados** — `lib_get_tracks` (inexistente) em vez de `lib_list_tracks`, `lib_get_albums` em vez de `lib_list_albums`, `set_volume` em vez de `player_set_volume`, etc.
2. **Tipos com IDs string** — backend usa `i64` (number), nao string
3. **Markup HTML inventado** — classes CSS como `track-list`, `track-row__num`, `track-row__meta` que nao existem no CSS real. O CSS usa `track-table` com `<table>` HTML
4. **Playlists model errado** — assumiu API de playlists que nao existe; backend usa folder-based playlists (`lib_list_folders`, `lib_list_folder_tracks`)
5. **Navigate import errado** — importava `navigate` de `tauri.ts` quando esta em `router.tsx`
6. **Titlebar sem import** — usava `onMount` sem importar de `solid-js`
7. **Settings parcial** — view Settings com conteudo placeholder ("Migrar de settings.js")

**Correcoes ja feitas:**
- IPC commands no `tauri.ts` corrigidos para nomes reais do backend
- Grid layout corrigido (`#app` como unico grid container, nao body)
- Import de `navigate` corrigido (vem de `router.tsx`)
- Titlebar: import `onMount` adicionado, SearchBar e RES button integrados
- PlayerBar: context menu (`showPlayerMenu`) integrado
- App.tsx: Tweaks e Resources montados via `onMount`
- Library.tsx: reescrita com markup `track-table` correto
- Playlists.tsx: reescrita para usar `lib_list_folders`/`lib_list_folder_tracks`
- `public/` directory criado para assets estaticos (icons, fonts, MCP scripts)

### 3. Mudancas fora da migracao (no working tree da main)
- Context menu: shuffle adicionado ao right-click
- Event logging: `events.js` corrigido (`window.__TAURI__.core` em vez de `@tauri-apps/api/core`), imports adicionados em player-bar, router, search-bar
- CSS now-playing: video layer, cover sem shadow, lyrics backdrop-filter
- Backend: media server HTTP, Qdrant behavioral signals

## Estado atual

**O app SolidJS abre mas as views estao quebradas:**
- Layout (titlebar, sidebar, player bar) funciona
- Window controls funcionam
- Navegacao entre views funciona (hash router)
- **Nenhuma view migrada renderiza corretamente** — markup/classes CSS nao correspondem ao CSS real
- Views stub (Home, Albums, Artists, Tracks, History, Stations, Signal) mostram placeholder
- Playback nao testado (player bar Solid nao validado)

## Estado dos arquivos

| Arquivo | Status | Problema |
|---------|--------|----------|
| `src/tauri.ts` | Parcialmente corrigido | IPC names OK. Tipos `id: string` devem ser `number` |
| `src/views/Library.tsx` | Corrigido | Reescrito com markup `track-table` correto |
| `src/views/Playlists.tsx` | Corrigido | Reescrito para folder-based playlists |
| `src/views/Album.tsx` | **BROKEN** | Markup inventado pelo Claude Design |
| `src/views/Artist.tsx` | **BROKEN** | Idem |
| `src/views/Queue.tsx` | **BROKEN** | Idem |
| `src/views/Settings.tsx` | **BROKEN** | Conteudo placeholder, nao funcional |
| `src/views/NowPlaying.tsx` | Parcial | Video HTTP ok, mas usa classes `np` do CSS correto |
| `src/components/PlayerBar.tsx` | Nao validado | Logica parece ok mas nao testado em runtime |
| `src/store/player.ts` | Nao validado | Store reativo, deveria funcionar |
| `src/store/dsp.ts` | Nao validado | Usa `localStorage` (mesmo pattern do vanilla) |
| `src/App.tsx` | OK | Shell funciona |
| `src/router.tsx` | OK | Hash router funciona |

## Decisoes tomadas

- **SolidJS em vez de Preact/Web Components**: reatividade granular sem VDOM, ideal para updates de alta frequencia (seek bar, lyrics sync). Runtime 5.47KB gzipped.
- **Vite como bundler**: build em <500ms, code splitting por rota, zero overhead em runtime.
- **Video via HTTP local**: WebKitGTK nao suporta `<video>` via `asset://` ou `tauri://`. HTTP server stdlib em Rust e o workaround confirmado pela comunidade.
- **Nao migrar todas as views de uma vez**: stubs para views nao migradas pelo Claude Design.

## Pendencias

1. **(critica) Corrigir markup de todas as views migradas** — cada view TSX precisa usar as MESMAS classes CSS que o vanilla JS original. Ler o .js, copiar o markup, trocar innerHTML por JSX reativo.
2. **(critica) Corrigir tipos no tauri.ts** — `id: string` → `id: number` em Track, Album, Artist, Playlist
3. **(alta) Validar PlayerBar.tsx** — testar play/pause/seek/next/prev/like/volume em runtime
4. **(alta) Migrar views stub** — Home, Albums, Artists, Tracks, History, Stations, Signal
5. **(media) Settings.tsx** — reescrever com conteudo real (library path, volume, scan, updates, about)
6. **(media) Video de fundo** — testar via HTTP media server end-to-end
7. **(baixa) Signal.tsx** — 1119 linhas de EQ/DSP canvas, migracao complexa
