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
