# Retomada: Spectrum Visualizer + Mood Classifier

## Contexto rapido

Sessao implementou visualizador FFT real-time como background do Now Playing.
Pipeline: GStreamer `spectrum` element (256 bandas, 60Hz) → bus sync handler →
thread dedicada `spectrum-emitter` → Tauri evento `audio-fft` → canvas SolidJS
com displacement vetorial baseado em normal map de imagens-shape.

Tambem: 983 tracks classificadas via Gemini 2.5 Flash (mood_tags, activity_tags,
energy, valence) gravadas na `track_enrichments` do Qdrant na cmr-auto. Stations
(CMR-61) agora tem dados pra funcionar.

Dois bugs criticos abertos: tela branca intermitente no webview (possivel
overload do canvas ou IPC) e delay/falta de reatividade no visualizador.
Thread dedicada pro spectrum foi implementada mas nao validada em producao.

## Arquivos principais

- `src-tauri/crates/audio-engine/src/output/spectrum.rs` — GStreamer spectrum wrapper
- `src-tauri/crates/audio-engine/src/engine.rs` — sync handler + spectrum channel
- `src-tauri/src/lib.rs` — spectrum-emitter thread + list_shapes command
- `src/components/SpectrumBackground.tsx` — canvas com normal map displacement
- `src/views/NowPlaying.tsx` — layout coluna unica + shape picker
- `scripts/gemini-classify-tracks.py` — classificador batch (983 tracks feitas)
- `data/mood-classifications.json` — classificacoes completas (referencia)
- `docs/contexto/04052026-spectrum-visualizer-mood-classifier.md` — contexto detalhado

<session_metadata>
branch: main
last_commit: 664a04b (commits da sessao anterior)
uncommitted_changes: 19 files (13 modified + 6 untracked)
mood_classifications: 983/983 complete ($0.065)
spectrum_architecture: sync_handler → dedicated_thread → tauri_emit
shapes_deployed: flame.png, heart.png, nebula.png (cmr-auto media/shapes/)
</session_metadata>

## Proximos passos (por prioridade)

### 1. Validar estabilidade do visualizador
**Onde:** cmr-auto, app rodando
**O que:** instalar release atual, tocar musica por 5+ min, verificar se tela branca ocorre
**Por que:** thread dedicada + 60Hz foi a ultima mudanca, precisa validar
**Verificar:** app estavel sem tela branca, visualizador reativo ao audio

### 2. Debugar reatividade se necessario
**Onde:** `src/components/SpectrumBackground.tsx`, `src-tauri/crates/audio-engine/src/engine.rs`
**O que:** se visualizador continua fraco, verificar com logging se dados FFT chegam ao frontend. Testar: (1) adicionar `console.log` no listener do `audio-fft` pra contar eventos/s, (2) verificar se `smoothed[]` tem valores > 0
**Por que:** usuario reportou delay de ~15s entre reacoes e animacao fraca
**Verificar:** `console.log` mostrando 60 eventos/s com valores variaveis

### 3. Commitar todas as mudancas
**Onde:** root do repo
**O que:** 2-3 commits atomicos: (1) feat(audio): spectrum visualizer, (2) feat(scripts): gemini mood classifier
**Por que:** 19 arquivos uncommitted
**Verificar:** `git status` limpo

### 4. Gerar shapes de melhor qualidade
**Onde:** `~/.local/share/rustify-player/media/shapes/` na cmr-auto
**O que:** silhuetas com gradientes suaves. Opcoes: Gemini Image Gen, Flux, ou curadoria manual de PNGs existentes. Flame ficou boa porque tinha gradiente natural. Heart e nebula sao basicos.
**Por que:** usuario quer mais variedade e melhor qualidade visual
**Verificar:** novas shapes aparecem nas setas do Now Playing

### 5. Migrar localStorage → Tauri Store
**Onde:** `src/components/SpectrumBackground.tsx` (shape index), possivelmente outros
**O que:** trocar `localStorage.getItem/setItem` por `@tauri-apps/plugin-store`
**Por que:** localStorage nao e nativo Tauri, sem criptografia, sem sync
**Verificar:** shape selection persiste entre sessoes

## Como verificar

```bash
cargo check --manifest-path src-tauri/Cargo.toml  # compilacao limpa (1 warning dead_code esperado)
npx vite build --mode development                 # frontend builda
./scripts/release.sh                              # release completo

# Na cmr-auto:
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.2.0_amd64.deb
# Tocar musica → Now Playing deve mostrar linhas reagindo ao audio
# Setas < > no canto superior direito trocam shape
# Cor das linhas deve corresponder ao dominant_color da track
```
