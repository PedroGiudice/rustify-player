# Retomada: Rustify Player — Views restantes + CSS + player-bar reativo

## Contexto rapido

Rustify Player (Tauri 2 + vanilla HTML/JS + Rust workspace) tem 2 subsistemas
prontos (audio-engine + library-indexer) e wiring Tauri completo. App compila
em .deb (7.4MB), abre, indexa ~/Music automaticamente, e 4 views ja chamam
IPC: Home, Library, Artists, Albums. Library validada com 740 FLACs reais
mostrando stats, genre chips, table de tracks (screenshot confirma).

Servico de embedding MERT-v1-95M rodando na VM Contabo via systemd user +
Docker, exposto em `https://extractlab.cormorant-alpha.ts.net:8448`. Pipeline
end-to-end funciona (6/740 embeddings completados antes de SSH timeout cortar
o scan).

Pendencias principais pra destravar "app funcional completo": 4 views ainda
stub (tracks/playlists/history/settings), CSS faltando pra card-grid e
home-actions, player-bar sem reatividade ao audio-engine. Usuario vai gerar
mockups HTML via Google Stitch pras views faltantes — ja na linguagem do
frontend (vanilla, tokens Monolith HiFi).

## Arquivos principais

- `docs/contexto/18042026-subsistema-b-completo-tauri-wiring.md` — contexto detalhado
- `src-tauri/src/lib.rs` — 18 Tauri commands expostos
- `src-tauri/crates/library-indexer/src/lib.rs` — API do indexer
- `src-tauri/crates/audio-engine/src/lib.rs` — API do engine
- `src/js/views/library.js` — template de view IPC-connected (usar como base)
- `src/js/views/home.js`, `artists.js`, `albums.js` — wiradas, referencias adicionais
- `src/js/views/tracks.js`, `playlists.js`, `history.js`, `settings.js` — stubs a substituir
- `src/js/components/player-bar.js` — estatico, precisa ficar reativo
- `src/styles/components.css` — CSS base, faltam classes novas
- `design-refs/files/*/code.html` — mockups de referencia (Library/Albums/Artists/NowPlaying/Settings)

## Proximos passos (por prioridade)

### 1. Receber mockups do Google Stitch e dropar as views

**Onde:** `src/js/views/{tracks,playlists,history,settings}.js` e CSS equivalente.
**O que:** Substituir stubs `renderView()` pelos mockups gerados. O usuario vai
colar HTML/JS/CSS na linguagem certa.
**Por que:** 4 views do app ainda mostram empty-state "not wired yet". Rodando
ja tem a estrutura (sidebar highlight, route, nav), falta so o conteudo.
**Verificar:** `cd /home/opc/rustify-player && cargo tauri build --bundles deb`
deve gerar `.deb` sem erros; clicar em cada rota na sidebar deve renderizar
sem empty-state.

**Padrao esperado das views** (ver `library.js`):
```js
const { invoke } = window.__TAURI__.core;
export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `...`;
  load(view);   // chama invoke() e popula
  return view;
}
```

Commands disponiveis (todos em `src-tauri/src/lib.rs`):
- `lib_list_tracks({genre_id?, artist_id?, album_id?, limit?})`
- `lib_list_albums({artist_id?, genre_id?, limit?})`
- `lib_list_artists({genre_id?, limit?})`
- `lib_list_genres()`
- `lib_search({query, limit?})`
- `lib_get_track({id})`, `lib_get_album({id})`, `lib_get_artist({id})`
- `lib_similar({track_id, limit?})`
- `lib_shuffle({genre_id?, limit?})`
- `lib_snapshot()`
- `player_play({path})`, `player_pause`, `player_resume`, `player_stop`
- `player_seek({seconds})`, `player_set_volume({volume})`
- `player_enqueue_next({path})`

### 2. CSS faltante pra card-grid e home-actions

**Onde:** `src/styles/components.css` (ou arquivo novo `src/styles/cards.css`
importado em `src/index.html`).
**O que:** Adicionar classes:
- `.card-grid` — grid responsivo (usado em artists/albums)
- `.card` — container do card
- `.card__cover`, `.card__cover--initials` — area de cover ou placeholder
- `.card__label`, `.card__sub` — texto
- `.home-section`, `.home-section__title` — secao da home
- `.home-actions` — grid horizontal de botoes
- `.home-action`, `.home-action__label`, `.home-action__hint` — botao Quick Start
**Por que:** Artists/Albums renderizam mas sem CSS os cards ficam colapsados.
Home tambem. Mockups do Stitch podem ja trazer isso.
**Verificar:** Navegar em Home/Artists/Albums deve mostrar grids visuais.

### 3. Player-bar reativo a StateUpdate events

**Onde:** `src/js/components/player-bar.js` + `src-tauri/src/lib.rs`.
**O que:**
- No Rust: spawnar task que consome `engine.subscribe()` (crossbeam Receiver),
  emite eventos Tauri via `app.emit("player:state", payload)`
- No JS: `window.__TAURI__.event.listen("player:state", ...)` atualiza titulo,
  artista, posicao, estado play/pause, tempo decorrido/total
- Buttons atuais estao `aria-disabled="true"`, remover quando track carregado
- Click em play/pause chama `invoke("player_pause")` ou `player_resume`
**Por que:** Double-click em track na Library toca, mas player-bar nao reflete.
Sem isso o player parece quebrado do ponto de vista UX.
**Verificar:** Tocar track pela Library, confirmar que player-bar mostra
titulo/artista, botao toggle pause/play funciona, tempo decorre.

### 4. duration_secs no scan

**Onde:** `src-tauri/crates/library-indexer/src/metadata.rs`.
**O que:** Ao parsear o FLAC, extrair `time_base` e `n_frames` do stream
`CodecParameters`, calcular `duration_secs = n_frames / sample_rate`.
Persistir no campo `tracks.duration_secs` (coluna ja existe em migrations).
**Por que:** Library view mostra "—" na coluna Duration pra todas as tracks.
**Verificar:** Re-scan (`rm ~/.local/share/rustify-player/library.db`
antes de abrir app) e conferir na Library que durations aparecem.

### 5. Completar embeddings na cmr-auto

**Onde:** Terminal na cmr-auto (SSH via `ssh cmr-auto@100.102.249.9`).
**O que:** Rodar dentro de tmux/nohup pra SSH nao cortar:
```bash
tmux new-session -d -s embed '/tmp/scan_folder \
  --music-root ~/Music \
  --db ~/.local/share/rustify-player/library.db \
  --cache ~/.cache/rustify-player \
  --embed-url https://extractlab.cormorant-alpha.ts.net:8448 \
  --embed-timeout-secs 7200 \
  --log-level warn 2>&1 | tee /tmp/embed.log'
```
**Por que:** Similarity queries (`lib_similar`) retornam vazio sem embeddings.
Rodar apenas sobre o .db ja populado, sem re-indexar do zero.
**Verificar:** `tmux attach -t embed` pra acompanhar; ao final
`sqlite3 ~/.local/share/rustify-player/library.db "SELECT COUNT(*) FROM tracks WHERE embedding_status='done'"`
deve retornar 740.

### 6. Cover art no frontend (media)

**Onde:** `src-tauri/src/lib.rs` + views com `.card__cover`.
**O que:** Registrar custom protocol Tauri (`tauri://cover?id=<track_id>`)
ou `asset://` protocol apontando pro `cache_dir`. View busca
`convertFileSrc("cover_abc.webp")` ou URL do protocol customizado.
**Por que:** Cards hoje mostram iniciais placeholder. Com covers reais a
UX fica proxima do Spotify.
**Verificar:** Artists e Albums mostram cover thumbs 300x300.

## Como verificar o ambiente

```bash
# 1. Servico de embedding UP
curl -fsS http://127.0.0.1:8448/health
# -> {"model":"mert-v1-95m","status":"ok"}

# 2. Tailscale Serve exposto
sudo tailscale serve status | grep 8448
# -> https://extractlab.cormorant-alpha.ts.net:8448 (tailnet only)

# 3. Build do Tauri app
cd /home/opc/rustify-player && cargo tauri build --bundles deb 2>&1 | tail -3
# -> "Finished 1 bundle at: .../rustify-player_0.1.0_amd64.deb"

# 4. Tests library-indexer
cd /home/opc/rustify-player/src-tauri && cargo test -p library-indexer --lib 2>&1 | tail -3
# -> "test result: ok. 63 passed; 0 failed; 2 ignored"

# 5. Deploy no cmr-auto
scp /home/opc/rustify-player/src-tauri/target/release/bundle/deb/rustify-player_0.1.0_amd64.deb cmr-auto@100.102.249.9:/tmp/
ssh cmr-auto@100.102.249.9 "sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb"
# user abre via menu ou: ssh -X / DISPLAY=:0 rustify-player
```

## Restricoes / cuidados

- **Nao mexer em `Content-Encoding`** -- use `X-Audio-Encoding` pra evitar
  Tailscale Serve descomprimir automaticamente
- **Nao atualizar transformers alem de 4.38.2** -- pesos do MERT ficam aleatorios
- **Nao usar npm/bundler** -- frontend e vanilla, `withGlobalTauri: true`
- **Nao abrir PR ainda** -- branch `feature/library-indexer` nao mergeou main;
  continuar commitando ai mesmo
- **Nao rebuildar Docker image sem precisar** -- pesos do MERT (~1GB) sao baixados
  em build, leva tempo
