# rustify-player

Player de música desktop local-first (Tauri 2.x + Solid.js + GStreamer),
construído para um acervo FLAC pessoal. Linux-only, alpha pessoal — não é
(ainda) um produto instalável por terceiros.

## O que tem de incomum

- **A biblioteca É um vector database.** Zero SQLite: metadata das tracks vive
  como payloads no Qdrant (sidecar ~34MB spawnado pelo próprio app), com
  embedding de áudio MERT-v1-95M (768d) e embedding de letra (1024d) como named
  vectors no mesmo ponto. "Tocar parecidas" é uma query vetorial sobre o som.
- **Background generativo audio-reativo atrás da UI inteira.** Campo escalar
  (18 shapes) × estratégia de pintura (5 renderers) = 90 combinações, dirigido
  por FFT real capturada do monitor do sink via PipeWire, com tinta derivada da
  cor dominante da capa (piso de contraste WCAG garantido no backend e no
  frontend). Teclas `[`/`]` trocam shape, `,`/`.` trocam renderer.
- **Cadeia DSP via LV2**: LSP Parametric EQ x16 + normalização de loudness
  EBU R128 per-track (target LUFS ajustável em runtime) + LSP Limiter + Calf
  Bass Enhancer, com UI nativa.
- **Temas YAML** com validação de contraste WCAG no load (hot-reload), accent e
  ink adaptativos à capa do álbum, painel Tweaks com knobs persistidos.
- Lyrics sincronizadas (LRC sidecars), moods/stations, autoplay que aprende de
  play_events (replays como positivo, skips como negativo).

## Stack

- **Backend:** Rust workspace (Tauri 2) — crates `audio-engine` (GStreamer
  Play + DSP bin) e `library-indexer` (walker + symphonia + Qdrant + watcher)
- **Frontend:** Solid.js + TypeScript (Vite). CSS em
  `src/styles/extractor-lab.css`
- **Índice/recomendações:** Qdrant local (sidecar), MERT via serviço HTTP externo
- **Identifier:** `dev.cmr.rustifyplayer`

## Estrutura

```
rustify-player/
├── src/                    # Frontend Solid (views/, components/, store/, lib/)
├── src-tauri/
│   ├── src/lib.rs          # Comandos Tauri, DSP, MPRIS, spectrum, temas
│   └── crates/
│       ├── audio-engine/   # GStreamer engine + DSP LV2 + captura FFT PipeWire
│       └── library-indexer/# Scan FLAC, metadata, covers, Qdrant, loudness
├── scripts/                # release.sh, curadoria (curator/), temas (themes/)
└── docs/                   # Planos, specs, design refs, contexto de sessões
```

## Desenvolvimento

```bash
npm install
npm run typecheck                                  # tsc --noEmit
npx vitest run                                     # testes frontend
cargo check --manifest-path src-tauri/Cargo.toml   # validação Rust rápida
cargo test  --manifest-path src-tauri/Cargo.toml   # testes Rust
./scripts/release.sh                               # build .deb + publica na tag dev
```

## Requisitos de runtime

- Linux com PipeWire (captura de espectro) e GStreamer 1.x (playback)
- Plugins LV2 pra cadeia DSP: `lsp-plugins-lv2`, `calf-plugins`
  (sem eles o app roda, mas EQ/limiter/bass ficam ausentes)
- Qdrant: binário bundled como sidecar (`binaries/qdrant`)
- Embeddings MERT: serviço HTTP externo (sem ele, tracks ficam com embedding
  `pending` e as recomendações por som não funcionam)

## Escopo e limitações conhecidas

- **FLAC-only** no indexer (o GStreamer decodificaria mais; o gate é deliberado)
- **Linux-only** por construção (PipeWire, MPRIS via zbus, empacotamento .deb)
- Auto-advance no fim da faixa tem gap pequeno (não é gapless verdadeiro)
- Temas YAML e LRCs de lyrics são dados do usuário (`~/.local/share/
  rustify-player/`), não acompanham o pacote
