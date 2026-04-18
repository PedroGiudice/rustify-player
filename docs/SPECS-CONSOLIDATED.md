# Rustify Player — Consolidated Specs

Consolidacao literal de todos os spec docs do repo. Gerado em 2026-04-18T23:20:53Z.

## Sumario

- `README.md`
- `CLAUDE.md`
- `design-refs/files/monolith_hifi/DESIGN.md`
- `.serena/memories/project_overview.md`
- `.serena/memories/architecture.md`
- `.serena/memories/code_style.md`
- `.serena/memories/suggested_commands.md`
- `.serena/memories/task_completion_checklist.md`
- `services/rustify-embed/README.md`
- `docs/contexto/18042026-subsistema-b-completo-tauri-wiring.md`
- `docs/prompts/18042026-subsistema-b-completo-tauri-wiring.md`
- `docs/contexto/19042026-audio-playback-debug-github-release.md`
- `docs/prompts/19042026-audio-playback-debug-github-release.md`


---

# FILE: `README.md`

# rustify-player

Player de musica desktop em Tauri 2.x com frontend HTML/CSS/JS puro.

## Stack

- **Backend:** Rust (Tauri 2)
- **Frontend:** HTML + CSS + JS vanilla (sem framework)
- **Package manager:** bun
- **Identifier:** `dev.cmr.rustifyplayer`

## Estrutura

```
rustify-player/
├── src/              # Frontend (HTML/CSS/JS puro)
│   ├── index.html
│   ├── main.js
│   ├── styles.css
│   └── assets/
├── src-tauri/        # Backend Rust
│   ├── src/
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

## Desenvolvimento

```bash
bun install           # Instala deps JS
bun run tauri dev     # Roda app em modo dev
bun run tauri build   # Build de producao
```

## Requisitos

- Rust stable (`rustup`)
- Bun
- Dependencias de sistema Tauri (webkit2gtk, libayatana-appindicator3-dev, etc.)


---

# FILE: `CLAUDE.md`

# Rustify Player — Claude Project Rules

## Release workflow (obrigatorio apos qualquer mudanca de codigo)

Sempre que eu terminar de aplicar mudancas que compilam e quero que o usuario
teste na cmr-auto, rodo:

```bash
./scripts/release.sh
```

Isso builda o .deb na VM (rapido — ~25s em 16 vCPU EPYC) e publica como rolling
release `dev` no GH. A cmr-auto puxa com:

```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
```

Nao compilar localmente na cmr-auto — i5 8th gen leva minutos. A VM leva
segundos. Release.sh e o unico caminho.

## Branch atual

`fix-playback-race-condition` — ativa ate merge em main.


---

# FILE: `design-refs/files/monolith_hifi/DESIGN.md`

# Design System Documentation

## 1. Overview & Creative North Star: "The Kinetic Vault"

The creative direction for this design system is **The Kinetic Vault**. It reimagines the audiophile experience as a high-end, monolithic piece of hardware—silent, heavy, and permanent—that comes to life through sharp, amber-lit instrumentation. 

By rejecting the "softness" of modern consumer web design (rounded corners, soft shadows, and pastel blurs), we embrace a **Brutalist-Minimalist** aesthetic. The interface is defined by raw structural integrity, high-contrast typography, and an "editorial" layout that treats album art and track metadata with the reverence of a gallery exhibition. We move beyond templates by using intentional asymmetry and a "No-Line" architecture to maximize performance and visual clarity.

---

## 2. Colors: Depth Through Tonal Shift

This system utilizes a "Deep Dark" palette to minimize eye strain and maximize the "glow" of the amber accents.

### The "No-Line" Rule
**Borders are prohibited.** To separate a sidebar from a main content area or a player bar from a tracklist, designers must use background color shifts only. Structural definition comes from the juxtaposition of `surface` against `surface_container_low` or `surface_container_highest`. This reduces DOM complexity and creates a more sophisticated, seamless look.

### Color Tokens
- **Background/Surface:** `#131313` (The primary canvas)
- **Primary (The Glow):** `#ffb87b` (Amber accent for active states, play buttons, and progress)
- **Surface Container Lowest:** `#0e0e0e` (Used for the main "pit" or background of the player)
- **Surface Container High:** `#2a2a2a` (Used for elevated interaction states like hovered rows)
- **On-Surface:** `#e5e2e1` (High-contrast white for primary text)

### Signature Textures
While the aesthetic is minimalist, CTAs and active progress bars should utilize a subtle linear gradient transitioning from `primary` (#ffb87b) to `primary_container` (#ff8f00). This mimics the warm, uneven glow of a vacuum tube or a vintage LED display, providing "soul" to the digital interface.

---

## 3. Typography: Editorial Authority

We use **Inter** as a functional, high-readability sans-serif. The hierarchy is designed to feel like a premium music journal.

- **Display Scale (`display-lg` to `display-sm`):** Reserved for Artist names or Album titles in immersive views. Use `display-lg` (3.5rem) with tight letter-spacing to create a "masthead" effect.
- **Headline & Title Scale:** Used for section headers (e.g., "Jump Back In"). These must be set in `headline-sm` (1.5rem) to maintain a bold, authoritative structure.
- **Label Scale:** `label-md` (0.75rem) should be used for metadata like bitrates, file formats (FLAC/WAV), and timestamps. These should be uppercase with a +5% letter-spacing to mimic technical instrumentation.

---

## 4. Elevation & Depth: Tonal Layering

Traditional shadows and 3D effects are replaced by **The Layering Principle**. Depth is achieved by "stacking" the surface tiers.

- **Stacking Logic:** 
    - **Level 0 (Canvas):** `surface_container_lowest` (#0e0e0e)
    - **Level 1 (Navigation/Sidebar):** `surface` (#131313)
    - **Level 2 (Active Cards/Modals):** `surface_container_high` (#2a2a2a)
- **The "Ghost Border" Fallback:** If a distinction is visually impossible (e.g., a floating context menu), use the `outline_variant` (#564334) at **15% opacity**. This creates a "barely-there" edge that maintains the Brutalist silhouette without adding heavy visual weight.
- **Glassmorphism:** For the Player Bar, use `surface` at 80% opacity with a `backdrop-blur: 20px`. This allows the album art colors to bleed through subtly as the user scrolls, creating a sense of environmental immersion.

---

## 5. Components

All components adhere to a **0px Roundedness Scale**. Sharp corners are non-negotiable.

### Buttons
- **Primary:** Background `primary` (#ffb87b), Text `on_primary` (#4c2700). Square edges. No shadow.
- **Secondary:** Background `surface_container_highest`, Text `on_surface`.
- **States:** On hover, the primary button should shift to `primary_fixed_dim`. No movement or lifting; only a color state change.

### Lists & Tables (The Tracklist)
- **Layout:** Forbid the use of divider lines. 
- **Separation:** Use `body-md` typography with generous vertical padding (16px).
- **Active State:** The currently playing track should not have a background highlight; instead, use the `primary` amber color for the Track Title and a "Glow" icon.

### Progress & Seek Bars
- **Track:** `surface_container_highest`.
- **Active Fill:** Linear gradient from `primary` to `secondary`.
- **Thumb:** A sharp, 2px wide vertical line (no circles), mimicking a needle on a gauge.

### Input Fields
- **Styling:** Transparent background with a `surface_container_highest` bottom-border only (2px).
- **Focus State:** Bottom-border shifts to `primary` (#ffb87b).

---

## 6. Do’s and Don’ts

### Do
- **Do** use `0px` border radius on every single element.
- **Do** leverage high-contrast pairings (Amber on Black) for critical navigation.
- **Do** use CSS Grid to keep DOM node counts low; avoid "div-soup" for layout containers.
- **Do** use asymmetrical layouts (e.g., a massive album cover on the left with a minimalist tracklist on the right) to create a premium feel.

### Don’t
- **Don't** use 1px solid borders to separate sections. Use color blocks.
- **Don't** use "Soft Grey" for secondary text. Use `on_surface_variant` (#dcc1ae) to maintain the warm, organic tonal range.
- **Don't** use standard "Drop Shadows." If an element must float, use a high-contrast tonal shift behind it.
- **Don't** use transitions longer than 150ms. Audiophile gear should feel "instant" and mechanical.

---

# FILE: `.serena/memories/project_overview.md`

# rustify-player — Overview

Player de música desktop audiófilo, construído com Tauri 2.x.

## Stack

- **Backend:** Rust (Tauri 2, workspace com 3 crates)
- **Frontend:** HTML + CSS + JS vanilla (sem framework, sem build step — `frontendDist: "../src"`)
- **Package manager:** Bun
- **Identifier:** `dev.cmr.rustifyplayer`
- **Rust edition:** 2021 (MSRV 1.78)

## Workspace Crates

| Crate | Path | Propósito |
|-------|------|-----------|
| `rustify-player` | `src-tauri/` | Shell Tauri — IPC commands, window management |
| `audio-engine` | `src-tauri/crates/audio-engine/` | Decode (symphonia/FLAC) + playback (cpal/PipeWire/ALSA) |
| `library-indexer` | `src-tauri/crates/library-indexer/` | Scan, metadata, cover art, search, embeddings (MERT) |

## Serviço Externo

- `services/rustify-embed/` — Serviço Python (Modal) para audio embeddings MERT.
  Porta 8448. Comunicação via HTTP (ureq no Rust).

## Frontend

- Vanilla JS com router SPA custom (`src/js/router.js`)
- Components: `player-bar.js`, `sidebar.js`
- Views: home, library, tracks, albums, artists, playlists, history, settings
- CSS: tokens (`tokens.css`), base, layout, components
- Assets: SVG icons, fonts

## Janela

- 1280x800 default, min 960x600
- Tema: Dark
- `withGlobalTauri: true` (acesso a `window.__TAURI__`)


---

# FILE: `.serena/memories/architecture.md`

# Arquitetura

## Diagrama

```
┌──────────────────────────────────────┐
│           Frontend (src/)            │
│  HTML + CSS + JS vanilla             │
│  Router SPA → Views → Components    │
│         window.__TAURI__             │
└───────────────┬──────────────────────┘
                │ IPC (invoke)
┌───────────────▼──────────────────────┐
│       Tauri Shell (src-tauri/src/)   │
│  lib.rs: run(), greet()             │
│  main.rs: entry point               │
└───┬───────────────────┬──────────────┘
    │                   │
┌───▼──────────┐  ┌─────▼──────────────┐
│ audio-engine │  │ library-indexer    │
│              │  │                    │
│ Engine       │  │ Indexer            │
│ EngineHandle │  │ IndexerHandle      │
│              │  │                    │
│ symphonia    │  │ rusqlite (SQLite)  │
│ cpal         │  │ walkdir, notify    │
│ rtrb         │  │ symphonia (meta)   │
│              │  │ image (covers)     │
│ PipeWire/    │  │ ureq → embed svc  │
│ ALSA         │  │                    │
└──────────────┘  └────────────────────┘
                          │ HTTP
                  ┌───────▼────────────┐
                  │ rustify-embed      │
                  │ (Modal/Python)     │
                  │ MERT embeddings    │
                  │ Porta 8448         │
                  └────────────────────┘
```

## Padrão Handle

Ambos os crates core usam o padrão Handle:
- `Engine::start()` → spawna thread, retorna `EngineHandle`
- `Indexer::open()` → spawna thread, retorna `IndexerHandle`
- Handle expõe API síncrona via crossbeam channels

## Módulos do audio-engine

| Módulo | Responsabilidade |
|--------|-----------------|
| decoder | Decodificação de áudio (symphonia) |
| engine | Loop principal, state machine |
| output | Backend de saída (cpal) |
| position | Tracking de posição |
| queue | Fila de reprodução |
| types | Tipos compartilhados |
| error | Error types |

## Módulos do library-indexer

| Módulo | Responsabilidade |
|--------|-----------------|
| db | Schema e operações SQLite |
| scan | Filesystem walker |
| metadata | Extração de tags (symphonia) |
| cover | Extração e cache de cover art |
| watch | File watcher (notify) |
| search | Busca fuzzy (strsim) |
| embed_client | Cliente HTTP para MERT embeddings |
| pipeline | Orquestração do pipeline de indexação |
| types | Tipos compartilhados |
| error | Error types |


---

# FILE: `.serena/memories/code_style.md`

# Estilo e Convenções

## Rust

- Edition 2021, MSRV 1.78
- `thiserror` para error types (cada módulo tem seu `error.rs`)
- `tracing` para logging (não `log` ou `println!`)
- Workspace dependencies — todas as versões centralizadas no `Cargo.toml` raiz
- Módulos: um arquivo por responsabilidade (`decoder.rs`, `engine.rs`, `queue.rs`, etc.)
- Padrão Handle: structs de API pública (`EngineHandle`, `IndexerHandle`) que encapsulam canais
- Crossbeam channels para comunicação inter-thread

## Frontend (JS vanilla)

- Sem framework, sem transpiler, sem JSX
- Router SPA custom (`router.js`)
- Componentes como módulos JS (`player-bar.js`, `sidebar.js`)
- Views como módulos separados (um por rota)
- CSS: design tokens em `tokens.css`, separação por camada (base, layout, components)

## Geral

- Sem over-engineering
- Sem comentários desnecessários
- Código morto: deletar, não comentar


---

# FILE: `.serena/memories/suggested_commands.md`

# Comandos de Desenvolvimento

## Dev workflow

```bash
bun install                    # Instala deps JS (apenas @tauri-apps/cli)
bun run tauri dev              # Dev mode com hot reload
bun run tauri build            # Build de produção (AppImage, deb, etc.)
```

## Rust

```bash
cargo check --manifest-path src-tauri/Cargo.toml           # Check rápido (workspace)
cargo build --manifest-path src-tauri/Cargo.toml            # Build workspace
cargo test --manifest-path src-tauri/Cargo.toml             # Testes workspace
cargo test -p audio-engine                                   # Testes do audio-engine
cargo test -p library-indexer                                # Testes do library-indexer
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all  # Lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check       # Format check
cargo fmt --manifest-path src-tauri/Cargo.toml               # Format
```

## Exemplos

```bash
cargo run -p audio-engine --example play_file -- <file.flac>
cargo run -p library-indexer --example scan_folder -- <dir>
```

## Embed service (Python)

```bash
# Deploy via Modal (executar manualmente)
cd services/rustify-embed && modal deploy app.py
```


---

# FILE: `.serena/memories/task_completion_checklist.md`

# Checklist de Conclusão de Tarefa

Antes de declarar uma tarefa completa, executar:

1. **Format:** `cargo fmt --manifest-path src-tauri/Cargo.toml`
2. **Lint:** `cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all`
3. **Check:** `cargo check --manifest-path src-tauri/Cargo.toml`
4. **Test:** `cargo test --manifest-path src-tauri/Cargo.toml`
5. **Verificar frontend:** se houve mudanças em `src/`, testar `bun run tauri dev`

Se todos passarem, pode commitar.


---

# FILE: `services/rustify-embed/README.md`

# rustify-embed

CPU-only MERT-v1-95M audio embedding service for the rustify-player
library indexer. Runs on the VM (extractlab) and is called by the
client via Tailscale; never exposed publicly.

## Wire protocol

```
POST /embed
  Content-Type: application/octet-stream
  Content-Encoding: zstd
  X-Sample-Rate: 24000
  <body: zstd-compressed LE f32 samples, mono, 24 kHz, ≤ 30 s>

→ 200 { "vector": [768 floats], "model": "mert-v1-95m" }

GET /health
→ 200 { "model": "mert-v1-95m", "status": "ok" }
```

Client implementation: `src-tauri/crates/library-indexer/src/embed_client.rs`.

## Build + deploy on extractlab (VM)

```bash
# On the VM
cd /home/opc/rustify-player/services/rustify-embed

# Build (first build downloads MERT weights ≈ 400 MB, takes a few minutes)
docker build -t rustify-embed:latest .

# Install systemd user unit
mkdir -p ~/.config/systemd/user
cp rustify-embed.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rustify-embed

# Verify
curl -fsS http://127.0.0.1:8448/health
# → {"model":"mert-v1-95m","status":"ok"}

# Logs
journalctl --user -u rustify-embed -f
```

## Expose on Tailnet

The container binds `127.0.0.1:8448` inside the VM (firewall defense in
depth). Tailscale Serve routes a tailnet URL to that port:

```bash
sudo tailscale serve --https=8448 --bg 127.0.0.1:8448
```

Client uses `https://extractlab.cormorant-alpha.ts.net:8448` as the
base URL. Do **not** use Funnel — the service has no authentication.

## Memory and CPU footprint

- Container limits: 14 CPU, 8 GB RAM (leaves breathing room for other
  services on the VM).
- Resident memory after model load: ~1.5 GB (PyTorch + MERT-95M).
- Per-request: single inference takes ~1-3 s on 30 s of audio, CPU-bound.
- Throughput is single-threaded per request — MERT doesn't benefit from
  batching at this scale. If the first-scan queue becomes a bottleneck
  (unlikely at 800 tracks), run multiple containers on different ports
  and round-robin on the client side.

## Offline fallback

Client-side: if the service is unreachable, the indexer marks the track
`embedding_status = 'pending'` and moves on. Next startup retries. The
player remains fully usable without embeddings — only the "similar
tracks" feature degrades gracefully to tag-based matching (not yet
implemented; future v1.1).


---

# FILE: `docs/contexto/18042026-subsistema-b-completo-tauri-wiring.md`

# Contexto: Subsystem B Library Indexer completo + Tauri wiring inicial

**Data:** 2026-04-18
**Sessao:** `feature/library-indexer`
**Duracao:** ~8h (com compaction intermedio)

---

## O que foi feito

### 1. Subsystem B finalizado — Library Indexer

Crate `library-indexer` em `src-tauri/crates/library-indexer/` com pipeline
completo: walk FLAC -> parse metadata -> extract cover art -> upsert SQLite
(FTS5) -> fire-and-forget HTTP POST de audio samples pro servico de embedding
MERT na VM.

Modulos: `db`, `scan`, `metadata`, `cover`, `watch`, `search`, `embed_client`,
`pipeline`, `types`, `error`. API publica via `Indexer::open(IndexerConfig)`
retornando `IndexerHandle` com queries sincronas (track, album, artist,
list_*, search, similar, shuffle) e comandos assincronos via channel.

Validado com 740 FLACs reais na cmr-auto: distribuicao de generos bate com
estrutura de pastas (Eletronica 196, Rap 191, Funk Br 167, MPB 86, Funk&Soul
62, Rock 37), FTS5 search retorna 9 tracks + artista pra "baco exu",
shuffle diversifica artistas sem sequencias de album.

### 2. Servico rustify-embed na VM

FastAPI + PyTorch CPU + MERT-v1-95M em `services/rustify-embed/`,
conteinerizado. Aceita POST /embed com f32 samples zstd-comprimidos,
retorna vetor 768-dim L2-normalizado. Exposto via Tailscale Serve em
`https://extractlab.cormorant-alpha.ts.net:8448` (porta 8447 estava ocupada
pelo Serena).

Wire format:
```
POST /embed
X-Audio-Encoding: zstd        # NAO Content-Encoding (Tailscale Serve
                               # intercepta, body fica duplamente decodificado)
X-Sample-Rate: 24000
body: zstd(<f32 LE samples>)  # max 30s * 24kHz = 720000 samples
-> 200 { "vector": [768 floats], "model": "mert-v1-95m" }
```

Python lado server: `decompress(raw, max_output_size=MAX_SAMPLES*4+4096)`
-- Rust zstd crate nao inclui content size no frame header, Python zstandard
exige ou max_output_size explicito.

transformers pinado em `4.38.2` -- versoes 4.39+ migraram weight_norm pra
parametrizations e o pos_conv_embed do MERT ficava com pesos aleatorios
silenciosamente. Pesquisa confirmou que warning "newly initialized" e falso
em 4.38 (compat hook migra weight_g/weight_v -> original0/original1).

### 3. Tauri app wiring

`src-tauri/src/lib.rs` reescrito: setup() inicializa indexer em
`~/.local/share/rustify-player/library.db` com music root `~/Music`, embed URL
opcional via env `RUSTIFY_EMBED_URL`, inicia audio-engine. State managed via
`tauri::State<Library>` e `State<Player>` (Mutex envolvendo EngineHandle).

18 commands expostos:
```
lib_list_genres, lib_list_tracks, lib_list_albums, lib_list_artists,
lib_search, lib_get_track, lib_get_album, lib_get_artist,
lib_similar, lib_shuffle, lib_snapshot,
player_play, player_pause, player_resume, player_stop,
player_seek, player_set_volume, player_enqueue_next
```

`audio-engine` feature `serde` ativada como dep do app Tauri. `IndexerSnapshot`
ganhou derives `Serialize + Deserialize` (faltava -- quebrava lib_snapshot).

### 4. Frontend shell + 4 views wiradas

Frontend vanilla (HTML/CSS/JS sem framework) em `src/`, shell ja existia
(sidebar, player-bar, router, CSS tokens Monolith HiFi). Sessao adicionou:

- **Library** (`src/js/views/library.js`): lista 200 tracks, chips de
  genero pra filtrar, table com #/title/artist/album/duration, double-click
  invoca `player_play`
- **Home** (`src/js/views/home.js`): stats + Quick Start (Shuffle All
  via `lib_shuffle` + enqueue de 5 proximas), links pra outras views,
  genre chips
- **Artists** (`src/js/views/artists.js`): card-grid com iniciais, track count
- **Albums** (`src/js/views/albums.js`): card-grid com iniciais + ano,
  click toca album inteiro (play + enqueue)

CSS: adicionadas classes `.genre-chips`, `.chip`, `.track-table`, `.track-row`
em `src/styles/components.css`. Falta CSS pra `.card-grid`, `.card`,
`.home-section`, `.home-actions`.

### 5. Bugs corrigidos

- **Router race** (`src/js/router.js`): registrava listener `hashchange`
  DEPOIS de setar `window.location.hash` default, evento disparava no vazio,
  view nunca renderizava no primeiro boot (tela preta em cima do shell)
- **Snapshot race** (`pipeline.rs:304-311`): `ScanDone` era emitido antes de
  `refresh_from_db`, CLI lia `tracks_total=0`. Invertido.
- **systemd user + docker.service**: unit tinha `Requires=docker.service`
  mas systemd --user nao ve units system-level. Removido.
- **Porta 8447 ocupada** (Serena dashboard): migrada pra 8448 em 5 arquivos.

## Estado dos arquivos

### Criados nesta sessao

| Arquivo | Detalhe |
|---------|---------|
| `src-tauri/crates/library-indexer/` | Crate completo (16 arquivos) |
| `services/rustify-embed/` | Dockerfile + app.py + systemd unit + README + requirements |
| `design-refs/files/` | Mockups de referencia (Library, Albums, Artists, NowPlaying, Settings) -- commit `a48651d` |
| `docs/contexto/` | Criado esta sessao |
| `docs/prompts/` | Criado esta sessao |

### Modificados

| Arquivo | Detalhe |
|---------|---------|
| `src-tauri/Cargo.toml` | +library-indexer, +audio-engine w/ serde feature |
| `src-tauri/src/lib.rs` | 18 Tauri commands, setup() bootstrap |
| `src-tauri/crates/library-indexer/src/types.rs` | IndexerSnapshot: +Serialize/Deserialize |
| `src/js/router.js` | Fix race: listener antes do hash mutation |
| `src/js/views/library.js` | Wirada (era stub) |
| `src/js/views/home.js` | Wirada (era stub) |
| `src/js/views/artists.js` | Wirada (era stub) |
| `src/js/views/albums.js` | Wirada (era stub) |
| `src/styles/components.css` | +chips, +track-table |

### Stubs ainda vazios

| Arquivo | Status |
|---------|--------|
| `src/js/views/tracks.js` | Stub renderView() — falta wiring |
| `src/js/views/playlists.js` | Stub — feature nao implementada |
| `src/js/views/history.js` | Stub — feature nao implementada |
| `src/js/views/settings.js` | Stub — feature nao implementada |

## Commits desta sessao

```
7f1dfc4 feat(frontend): router fix + home/artists/albums wiring
52ab1a3 feat: wiring Tauri IPC — library + engine + Library view
e538777 fix(embed): zstd content-size + header proxy compat
9ce6bf5 fix(library-indexer): snapshot race + systemd user unit
a48651d feat(frontend): shell inicial — router, views, componentes, tokens
f74f173 fix(rustify-embed): migra porta 8447 → 8448
336114e feat(library-indexer): pipeline + lib API + CLI
91c3c0a feat(library-indexer): cover + watch + search + embed client + VM service
6259250 feat(library-indexer): skeleton + db + scan + metadata
```

## Decisoes tomadas

- **X-Audio-Encoding em vez de Content-Encoding pra zstd**
  Motivo: Tailscale Serve (e qualquer reverse proxy) intercepta
  `Content-Encoding: zstd` e descomprime o body automaticamente. Resultado:
  server recebia f32 raw e tentava zstd-decompress, falhava.
  Descartado: deixar `Content-Encoding` -- inviavel behind proxy.

- **max_output_size no decompressor Python**
  Motivo: Rust `zstd::encode_all` nao escreve content size no frame header.
  Python `zstandard` exige content size ou max_output_size explicito.
  Descartado: configurar Rust pra escrever content size -- nao ha API
  direta na versao atual do crate zstd 0.13.

- **transformers==4.38.2 pinado**
  Motivo: versoes 4.39+ migraram weight_norm pra parametrizations API.
  Checkpoint do MERT tem `weight_g`/`weight_v`, transformers 4.39+ nao mapeia
  pra `parametrizations.weight.original0/1` sem warning misleading. Em 4.38
  o compat hook funciona e os pesos sao carregados corretamente.
  Descartado: atualizar pra 4.44.2 (versao mais nova do pytorch 2.4.1) --
  inviavel pela regressao silenciosa do encoder.

- **Path-based genre taxonomy**
  Motivo: usuario ja tem ~/Music/<Genre>/<Artist>/... organizado, evita
  explosao de generos de tags.
  Descartado: parse de Vorbis GENRE tag puro -- ~500 generos mesmo com
  normalizacao.

- **Embedding no VM, nao no client**
  Motivo: i5 8th gen do usuario nao processa MERT em tempo habil. VM Contabo
  tem 16 vCPU EPYC, inference ~1-3s por track. Sempre-on, sem cold start.
  Descartado: ONNX local -- MERT nao tem export oficial pra ONNX.
  Descartado: Modal -- inviavel pra operacao recorrente (cold start + custo
  por request).

- **Frontend vanilla com `withGlobalTauri: true`**
  Motivo: frontend ja estava em HTML/CSS/JS vanilla, `window.__TAURI__.core.invoke`
  dispensa npm/bundler completamente, zero build step JS.
  Descartado: adicionar `@tauri-apps/api` via npm -- burocracia sem beneficio.

## Metricas

| Metrica | Valor |
|---------|-------|
| Tracks indexados (cmr-auto) | 740 |
| Generos populados | 6 |
| Tempo de scan (sem embeddings) | ~24s |
| Tempo por embedding (MERT CPU VM) | ~4-5s via Tailscale |
| Embedding pipeline validado | 6/740 tracks embedded (SSH timeout truncou) |
| Tests library-indexer passando | 63/63 (2 ignored) |
| Tamanho .deb do Tauri app | 7.4MB |
| Tamanho binario release | 20MB |

## Pendencias identificadas

1. **Views restantes do frontend** (alta)
   `tracks.js`, `playlists.js`, `history.js`, `settings.js`. Usuario planeja
   gerar mockups via Google Stitch na proxima sessao. Drop-in esperado.

2. **CSS pra card-grid e home-actions** (alta)
   `artists.js` e `albums.js` usam `.card-grid`, `.card`, `.card__cover`,
   `.card__label`, `.card__sub`. `home.js` usa `.home-section`,
   `.home-actions`, `.home-action`. Nenhum existe ainda em components.css.

3. **Player-bar reativo** (alta)
   Atualmente estatico ("NO TRACK"). Nao consome `StateUpdate` events do
   audio-engine. Precisa: listener via Tauri Channel ou polling, atualizar
   titulo/artista/posicao/play-pause.

4. **duration_secs nao populado** (media)
   Library view mostra "—" na coluna Duration. Scan/metadata nao calcula
   duracao. Fix em `library-indexer/src/metadata.rs`: ler `time_base` e
   `n_frames` do FLAC e computar.

5. **Embeddings completos na cmr-auto** (baixa)
   740 tracks total, 6 done. Rodar `scan_folder` com `--embed-timeout-secs
   7200` direto no cmr-auto via tmux/nohup (nao por SSH interativo, que
   desconecta ao fim do timeout do terminal). Similarity queries dependem.

6. **Cover art no frontend** (media)
   Covers estao em `~/.cache/rustify-player/cover_*.webp`. Tauri precisa
   expor via `asset://` protocol ou custom protocol. Hoje cards mostram
   iniciais placeholder.

7. **Integration tests library-indexer** (baixa)
   Task #39 do plano original, nunca executada. Unit tests cobrem core;
   integration tests validariam fluxos cross-modulo.

8. **Settings wirada** (baixa)
   Configurar music root, output device, toggle embed URL. Hoje hardcoded
   em `lib.rs` (`~/Music`).

9. **FLAC fixtures transferidos** (baixa)
   Task #24 do plano do Subsystem A. audio-engine tests/fixtures ainda
   gitignored e vazios. Usuario precisaria scp-ar do PC.


---

# FILE: `docs/prompts/18042026-subsistema-b-completo-tauri-wiring.md`

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


---

# FILE: `docs/contexto/19042026-audio-playback-debug-github-release.md`

# Contexto: Audio playback debug + GitHub release workflow + views finalizadas

**Data:** 2026-04-19
**Sessao:** `fix-playback-race-condition`
**Duracao:** ~3h (apos sessao anterior 18/04 de ~8h)

---

## O que foi feito

### 1. Views restantes wiradas (drop-in do Google Stitch)

Substituidos 4 stubs do frontend por views funcionais usando shape real do
library-indexer (`artist_name`/`album_title`/`genre_name`/`track_number`/
`duration_ms` — nao os `artist`/`album`/`genre`/`track_no`/`duration_secs`
que o Stitch assumiu errado).

- `tracks.js` — lista completa (limit 5000), search client-side em
  title/artist/album, double-click toca, right-click enqueue-next, XSS
  escape em innerHTML e atributos
- `playlists.js`, `history.js` — empty-state com `.empty-state` nativa +
  badge "Coming soon" (features nao implementadas no backend)
- `settings.js` — stats via `lib_snapshot` + counts de `lib_list_albums/
  artists/genres`, volume slider (0-1), status pill de embeddings

### 2. CSS card-grid + home-actions

Artists/Albums renderizavam como texto cru (prints do usuario confirmaram).
Adicionadas classes em `components.css` usando so tokens:
`.card-grid`, `.card`, `.card__cover`, `.card__cover--initials`,
`.card__label`, `.card__sub`, `.home-section`, `.home-actions`,
`.home-action*`. Tambem `.search-input`, `.badge--soon`, `.settings-*`,
`.stats-grid`, `.stat-card`, `.status-pill` pras views acima.

### 3. Branch `fix-playback-race-condition` (Gemini + correcoes)

Usuario acionou Gemini em paralelo; Gemini commitou 488da91 ("gemini shit")
com mudancas em 14 arquivos. Triagem do que veio:

**Bom:**
- `play_on_load` no engine (engine.rs + types.rs) — corrige race Load+Play
  enviados em sequencia pelo Tauri. Engine agora defere o Play se chegar
  durante Loading, e transiciona direto pra Playing quando prep completa
- StateUpdate com `#[derive(Serialize, Deserialize)]` + thread spawn em
  `lib.rs` que consome `engine.subscribe()` e emite `player-state` via
  Tauri event. Frontend `player-bar.js` consome via `listen("player-state")`
- `tauri-plugin-fs` + `assetProtocol.scope` pra covers via `convertFileSrc`
- Player-bar reativo: `playTrack(track)` helper, UI updates, tech badge
  (parcialmente quebrada — ver pendencias)

**Ruim / corrigido:**
- cpal `pipewire/pulse/default` preference — no-op no sistema de teste
  (caia em "Default Audio Device"), mas revertido por seguranca
- `cover_path` como String em field `Option<PathBuf>` — nao compilava.
  Revertido pra `Some(lib.cache_dir.join(rel))` (PathBuf)
- Cover path resolution faltando em `lib_search` e `lib_get_track`.
  Adicionado

### 4. Fix critico: sample rate do cpal stream

Bug identificado a partir de sintomas do usuario (96k tocando em meia
velocidade, 44.1 acelerada, volume altissimo):

`configure_system` em `cpal_backend.rs` abria a stream em
`supported.config().sample_rate` (device default = 48kHz no PipeWire),
ignorando a rate do arquivo. Engine escrevia samples em source rate na
stream de 48kHz → DAC consumia em 48kHz → pitch/velocidade shiftava.

Fix: `stream_config.sample_rate = format.sample_rate`. ALSA plugin →
PipeWire resampleia internamente ou muda clock do grafo.

**Status:** usuario reportou que apos pull do .deb os sintomas **continuam**.
Nao verificado se pull efetivamente pegou a .deb do commit f1af547. Log
em run anterior mostrou `sr=44100 ch=2 src_ch=2` correto, sugerindo que
o fix deveria atuar. Investigacao incompleta.

### 5. GitHub remote + rolling release

- Repo criado: https://github.com/PedroGiudice/rustify-player (privado)
- `scripts/release.sh`: builda .deb na VM (rapido — ~25s em 16 vCPU EPYC)
  e publica/atualiza release `dev` via `gh release upload --clobber`
- Comando unico na cmr-auto pra pegar o .deb novo:
  ```bash
  gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
  sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
  ```
- `CLAUDE.md` no root do repo com regra: sempre rodar `scripts/release.sh`
  apos mudancas que compilam

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/js/views/tracks.js` | Reescrito | list+search+dblclick+contextmenu, shape real |
| `src/js/views/playlists.js` | Reescrito | empty-state + badge "Coming soon" |
| `src/js/views/history.js` | Reescrito | idem |
| `src/js/views/settings.js` | Reescrito | snapshot+counts+volume slider+status pill |
| `src/js/views/home.js` | Modificado (Gemini) | `playTrack()` helper em vez de invoke direto |
| `src/js/views/library.js` | Modificado (Gemini) | idem |
| `src/js/views/albums.js` | Modificado (Gemini) | idem + cover async via convertFileSrc |
| `src/js/components/player-bar.js` | Reescrito (Gemini) | listen+updatePosition+playTrack+updateTechInfo |
| `src/styles/components.css` | Expandido | +card-grid+home+settings-*+search+status-pill (~350 linhas) |
| `src-tauri/src/lib.rs` | Modificado | Library{handle,cache_dir}, emit thread, cover paths, tracing |
| `src-tauri/Cargo.toml` | Modificado | +tauri-plugin-fs, +tracing-subscriber |
| `src-tauri/capabilities/default.json` | Modificado | +fs:allow-read com scope cache |
| `src-tauri/tauri.conf.json` | Modificado | +assetProtocol.scope |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | play_on_load logic |
| `src-tauri/crates/audio-engine/src/types.rs` | Modificado | Loading{play_on_load}, StateUpdate: Serialize |
| `src-tauri/crates/audio-engine/src/output/cpal_backend.rs` | Modificado | stream_config.sample_rate = format.sample_rate |
| `scripts/release.sh` | Criado | build .deb + gh release upload |
| `CLAUDE.md` | Criado | regra do release workflow |
| `new-screens/` | Removido | pasta temp com output da Stitch |

## Commits desta sessao

```
4b6b4df docs: CLAUDE.md com regra de release obrigatoria
045508f chore: release.sh — build .deb na VM + publica como rolling release "dev"
f1af547 fix(audio-engine): request source sample rate when opening cpal stream
eaf4dc1 fix(audio/frontend): revert cpal pipewire preference, resolve cover paths consistently
488da91 gemini shit  (Gemini, nao desta sessao mas processado aqui)
22cfa41 feat(frontend): tracks/playlists/history/settings views wiradas
```

## Decisoes tomadas

- **EasyEffects sera integrado por CLI (`easyeffects -l NAME`)**, nao D-Bus.
  Motivo: D-Bus do EasyEffects na versao instalada so expoe `org.gtk.Actions`
  com actions limitadas (preferences, about, quit, reset — sem LoadPreset).
  CLI funciona: `-p` lista presets, `-l` carrega, `-b` bypass.
  Descartado: D-Bus — API nao existe nessa versao.

- **Escopo MVP do controle EasyEffects: preset picker apenas.**
  Motivo: aligninamento com usuario ("1" = preset picker). Bypass/gain/EQ
  ficam pra depois.
  Descartado: niveis 2 e 3 (enable/disable+gain, full EQ bands).

- **Rolling release `dev` em vez de CI/CD.**
  Motivo: alinhamento com usuario ("script local óbvio"). Setup 2min vs
  30min de GH Actions pra Tauri com cache.
  Descartado: GH Actions — over-engineering pra single-dev.

- **`cpal::SampleRate` e type alias pra u32** (nao tuple struct como
  em versoes antigas). Assignment direto `stream_config.sample_rate = u32`.

- **`OutputMode::System` e o unico modo relevante** (pre-sessao, confirmado).
  Bit-perfect fica de lado pra nao bypassar EasyEffects/EQ do usuario.

## Metricas

| Metrica | Valor |
|---------|-------|
| Build release | ~28s (16 vCPU EPYC) |
| .deb size | 7.4MB |
| Presets EasyEffects na cmr-auto | 18 (todos output, 0 input) |
| Preset atual (GSettings) | `'600 rap dac no bass'` |

## Pendencias identificadas

1. **Audio playback ainda quebrado** (critica)
   Usuario reportou que, apos `gh release download` + `dpkg -i`, pitch/
   velocidade/volume ainda errados. O fix de sample rate esta commitado
   (f1af547) e no .deb da release `dev`. Investigar: (a) confirmar que
   release.sh uploadou o .deb certo (check timestamp do artefato na
   release vs commit time), (b) pedir ao usuario tracing log do app
   rodando (`rustify-player 2>&1 | grep configured`) pra ver o sr=X real,
   (c) se sr negociado != source, problema e cpal-to-ALSA; se sr negociado
   == source mas audio continua ruim, problema e outro.

2. **Tech badge mostra `undefinedbit / 44.1kHz`** (alta)
   `TrackInfo` nao tem campo `bit_depth`. `player-bar.js` faz
   `${info.bit_depth}bit / ${info.sample_rate/1000}kHz` e bit_depth e undefined.
   Fix: adicionar `pub bit_depth: Option<u16>` em `TrackInfo` (types.rs),
   popular em `decoder.rs` a partir de
   `codec_params.bits_per_sample`. Ajustar player-bar.js pra condicionalmente
   mostrar bit_depth.

3. **Controle de EasyEffects via preset picker** (alta — ja combinado)
   Novo modulo `src-tauri/src/easyeffects.rs`:
   - `list_presets() -> Vec<String>` via `easyeffects -p`, parse de
     "Output Presets: A,B,C,..."
   - `current_preset() -> Option<String>` via
     `gsettings get com.github.wwmm.easyeffects last-used-output-preset`
   - `load_preset(name) -> Result<()>` via `easyeffects -l NAME`
   Tauri commands: `ee_list_presets`, `ee_current_preset`, `ee_load_preset`.
   Settings UI: secao "Audio FX" com dropdown, onchange invoca ee_load_preset.

4. **2x cliques pra tocar** (media)
   Usuario reportou que ainda precisa clicar 2x no track. `play_on_load`
   esta no codigo (engine.rs + types.rs). Debugar: primeiro click envia
   Load+Play → se Play chega durante Loading, seta play_on_load=true → quando
   prep completa, install_current transiciona direto pra Playing. Se nao
   funciona: verificar se o Play esta mesmo chegando (talvez playTrack()
   em player-bar.js tenha bug antes do invoke("player_play")).

5. **Volume ridiculamente alto** (alta — pode ser correlato ao item 1)
   Separar de pitch/velocidade: testar com volume slider em 0.1 e ver se
   proporcional. Se ainda altissimo em 0.1, talvez problema de channel
   interleaving ou double-apply de gain. Se proporcional, entao e so
   volume default alto demais (engine inicia com volume=1.0 em engine.rs:142).

6. **Duration nao mostra total correto** (baixa)
   `TrackInfo.duration: Option<Duration>` deve estar populado. Mas o
   player-bar faz `info.duration.secs` que assume struct `{secs, nanos}`.
   Verificar serde serialization de `std::time::Duration` (default = struct
   com secs/nanos, ok) e se `total_frames` no FLAC header esta sendo usado
   em decoder.rs pra computar duration.

7. **View Home sem cover art** (baixa)
   Cards de Albums/Artists usam iniciais placeholder. Covers existem em
   `~/.cache/rustify-player/cover_*.webp`. Albums ja usa `convertFileSrc`
   (Gemini implementou). Artists ainda nao — poderia mostrar cover do
   album mais recente do artista, por ex.

8. **Tracks view: duration mostra `—`** (baixa)
   `library-indexer/src/metadata.rs` nao calcula `duration_ms` ao scan.
   Fix: ler `time_base` e `n_frames` do FLAC e computar. Pendencia carryover
   da sessao anterior.


---

# FILE: `docs/prompts/19042026-audio-playback-debug-github-release.md`

# Retomada: Rustify Player — audio playback debug + EasyEffects + tech badge

## Contexto rapido

Rustify Player (Tauri 2 + vanilla JS + Rust workspace) tem 4 views novas
(tracks/playlists/history/settings) wiradas + CSS card-grid/home-actions
renderizando. Branch `fix-playback-race-condition` tem Gemini-patch triada
+ correcoes (sample rate fix, cover paths consistentes, reverts seletivos).

**GitHub remote:** https://github.com/PedroGiudice/rustify-player (privado).
Rolling release `dev` com .deb publicado via `scripts/release.sh`. CLAUDE.md
no repo impoe que sempre rode release.sh apos commits.

**3 bugs abertos priorizados:**
1. Audio tocando errado (pitch/velocidade/volume). Sample rate fix commitado
   em f1af547, usuario reportou que nao resolveu. Investigar.
2. Tech badge mostra `undefinedbit / 44.1kHz` — falta campo `bit_depth` em
   `TrackInfo`.
3. Integrar controle de EasyEffects (preset picker MVP). Combinado na
   sessao, nao implementado ainda.

## Arquivos principais

- `docs/contexto/19042026-audio-playback-debug-github-release.md` — contexto completo
- `src-tauri/crates/audio-engine/src/output/cpal_backend.rs` — fix de sample rate aqui
- `src-tauri/crates/audio-engine/src/types.rs` — TrackInfo sem bit_depth; PlaybackState com play_on_load
- `src-tauri/crates/audio-engine/src/decoder.rs` — popular bit_depth aqui (symphonia `codec_params.bits_per_sample`)
- `src-tauri/crates/audio-engine/src/engine.rs` — install_current com play_on_load
- `src-tauri/src/lib.rs` — Tauri commands, emit thread pra `player-state`
- `src/js/components/player-bar.js` — listen + updateTechInfo (bug do bit_depth esta aqui)
- `src/js/views/settings.js` — adicionar preset picker aqui
- `scripts/release.sh` — build .deb + gh release upload (SEMPRE rodar apos commit)
- `CLAUDE.md` — regra do release workflow

## Proximos passos (por prioridade)

### 1. Confirmar estado real do audio playback

**Onde:** rodar o app na cmr-auto e coletar log.
**O que:** verificar se o .deb na release `dev` esta com o fix de sample rate
(commit f1af547) e se `configured system output` log mostra `sr=<source_rate>`
batendo com a rate do arquivo tocado.

**Por que:** usuario reportou persistencia dos sintomas apos pull. Investigacao
incompleta — preciso ver o log antes de teorizar mais.

**Verificar:**
```bash
ssh cmr-auto@100.102.249.9 "rustify-player 2>&1 | grep -E 'configured|sample_rate|ch=' | head -10"
# Esperado: sr=44100 pra track 44.1k, sr=96000 pra 96k
# Se sr=48000 sempre: o fix nao esta no .deb. Rebuildar+rerelease.
# Se sr bate com source e audio ainda errado: problema e outro (channels, buffer, volume).
```

### 2. Fix tech badge (bit depth + sample rate + channels)

**Onde:**
- `src-tauri/crates/audio-engine/src/types.rs` linha ~27 (TrackInfo)
- `src-tauri/crates/audio-engine/src/decoder.rs` (popular bit_depth)
- `src/js/components/player-bar.js` linha ~116 (updateTechInfo)

**O que:**
1. Adicionar `pub bit_depth: Option<u16>` em `TrackInfo`.
2. Em `decoder.rs`, popular de
   `format.tracks()[idx].codec_params.bits_per_sample.map(|b| b as u16)`.
3. Em `player-bar.js`, `updateTechInfo(info)`:
   ```js
   const bd = info.bit_depth ? `${info.bit_depth}bit · ` : "";
   ui.techLine.textContent = `${bd}${info.sample_rate/1000}kHz · ${info.channels === 2 ? "stereo" : `${info.channels}ch`}`;
   ui.techBadge.textContent = "FLAC";
   ```

**Por que:** sem isso o display da qualidade fica inutil (mostra
`undefinedbit / 44.1kHz`).

**Verificar:**
```bash
./scripts/release.sh
# Na cmr-auto:
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
# Tocar uma track e olhar player-bar: esperado "16bit · 44.1kHz · stereo" (ou 24bit/96kHz).
```

### 3. Preset picker do EasyEffects (MVP)

**Onde:** criar `src-tauri/src/easyeffects.rs`; adicionar commands em `lib.rs`;
UI em `src/js/views/settings.js`.

**O que:**
1. Modulo Rust:
   ```rust
   // list via `easyeffects -p`, parse "Output Presets: A,B,C,..."
   pub fn list_output_presets() -> Result<Vec<String>, String>;
   // via gsettings
   pub fn current_preset() -> Option<String>;
   // via `easyeffects -l NAME`
   pub fn load_preset(name: &str) -> Result<(), String>;
   ```
2. Tauri commands `ee_list_presets`, `ee_current_preset`, `ee_load_preset`
   em `lib.rs`.
3. Em `settings.js`, adicionar secao "Audio FX" com `<select>` populado
   por `ee_list_presets`, valor inicial = `ee_current_preset`, onchange
   chama `ee_load_preset`. Se `easyeffects` nao estiver instalado/rodando,
   secao mostra mensagem informativa e fica desabilitada.

**Por que:** alinhamento com usuario — integracao ativa do EQ, nao passiva.
Combinado na sessao, ainda nao implementado.

**Verificar:**
```bash
./scripts/release.sh
# Abrir Settings na cmr-auto, confirmar dropdown com 18 presets.
# Trocar preset e confirmar via:
ssh cmr-auto@100.102.249.9 "gsettings get com.github.wwmm.easyeffects last-used-output-preset"
```

### 4. 2x clicks pra tocar

**Onde:** `src/js/components/player-bar.js` `playTrack()` + `src-tauri/src/lib.rs` `player_play`.

**O que:** instrumentar com console.log no playTrack pra ver se primeira
invocacao chega. Se chega e audio nao toca: problema no engine (play_on_load
nao transicionando). Se NAO chega: problema no frontend (event listener,
data-track-id missing, etc).

**Por que:** UX — click unico deve tocar. play_on_load foi adicionado
justamente pra isso e usuario relata que ainda nao funciona.

**Verificar:** double-click em track na Library, checar logs (console
devtools do webview + tracing do rustify-player).

### 5. Volume altissimo

**Onde:** `engine.rs:142` (init volume=1.0) + `decode_and_push_one` volume apply.

**O que:** depois de confirmar sample rate fix, testar com volume slider
em 10%. Se altissimo: double-apply de gain (volume aplicado 2x) ou channel
interleaving. Se proporcional: so default volume alto.

**Por que:** correlato ao item 1 (pitch errado pode confundir percepcao de
volume), mas se persistir apos fix de rate, vira bug proprio.

### 6. `duration_ms` no library-indexer (carryover)

**Onde:** `src-tauri/crates/library-indexer/src/metadata.rs`.

**O que:** ler `time_base` e `n_frames` do FLAC ao scan, computar
`duration_ms = n_frames * 1000 / sample_rate`.

**Por que:** Tracks view mostra "—" na coluna Duration. Carryover da sessao
anterior.

## Como verificar ambiente

```bash
# 1. Branch ativa
cd /home/opc/rustify-player && git branch --show-current
# -> fix-playback-race-condition

# 2. Build compila
cargo build --manifest-path src-tauri/Cargo.toml --release 2>&1 | tail -1
# -> "Finished `release` profile ..."

# 3. Testes audio-engine passando
cargo test --manifest-path src-tauri/Cargo.toml -p audio-engine --lib 2>&1 | tail -3

# 4. Release workflow funcional
./scripts/release.sh 2>&1 | tail -3
# -> "[release] done"

# 5. cmr-auto alcancavel
ssh cmr-auto@100.102.249.9 "which rustify-player && which easyeffects"
# -> /usr/bin/rustify-player  /usr/bin/easyeffects
```

## Restricoes / cuidados

- **NAO compilar localmente na cmr-auto** — i5 8th gen leva minutos, VM
  leva segundos. Sempre via `scripts/release.sh` + `gh release download`.
- **SEMPRE rodar `scripts/release.sh`** apos commits que afetam o app.
  Regra em CLAUDE.md do repo.
- **NAO mexer em `Content-Encoding`** pro embed service — usar
  `X-Audio-Encoding` pra evitar Tailscale Serve descomprimir (carryover).
- **NAO atualizar transformers alem de 4.38.2** na VM — MERT quebra
  (carryover).
- **`cpal::SampleRate` e type alias pra u32**, nao tuple struct. Assignment
  direto: `stream_config.sample_rate = u32_value`. (Nao usar
  `cpal::SampleRate(x)`.)
- **`OutputMode::System` e o modo default e unico relevante** — NAO default
  pra BitPerfect, bypassa EasyEffects.
- **Branch `fix-playback-race-condition` ainda nao mergeou em main.**
  Continuar commitando ai. PR quando audio + tech badge + preset picker
  estiverem funcionando.

