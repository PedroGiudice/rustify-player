# Contexto: Spectrum Visualizer + Gemini Mood Classifier

**Data:** 2026-05-04
**Sessao:** main (mudancas nao commitadas)
**Duracao:** ~3h

---

## O que foi feito

### 1. Commits da sessao anterior pushados

Duas sessoes de trabalho anteriores tinham 16 arquivos uncommitted. Commitados em 2 commits atomicos e pushados:

- `a16e65a` feat(indexer): track_enrichments collection + i64→u64 end-to-end (CMR-61)
- `664a04b` fix(audio): DSP bypass state tracking + per-key debounce + preset save (CMR-56, CMR-57)

### 2. Gemini Mood Classifier (983 tracks)

Script `scripts/gemini-classify-tracks.py` classifica tracks via Gemini 2.5 Flash:
- Leitura de `rustify_tracks` (Qdrant na cmr-auto `100.102.249.9:6333`)
- Batches de 15 tracks com `response_mime_type: "application/json"` + retry 3x
- Gravacao na `track_enrichments` via `set_payload`
- **983/983 classificadas**, zero erros, $0.065 total
- Output salvo em `data/mood-classifications.json` (338KB, referencia persistente)

Campos gravados por track: `mood_tags`, `activity_tags`, `energy` (0-1), `valence` (0-1).

Problemas resolvidos durante execucao:
- Batch 50 gerava JSON malformado → reduzido pra 15 + `response_mime_type` + JSON repair regex
- Upsert `PUT /points` sem vector dava 400 → trocado pra `POST /points/payload` (set_payload)
- 934 pontos pre-existentes na enrichments, 49 tracks sem ponto (nao criados pelo script, ignorados silenciosamente)

### 3. Spectrum Visualizer (GStreamer + Canvas)

Pipeline real-time de visualizacao FFT como background do Now Playing:

**Backend (Rust):**
- `spectrum.rs` — wrapper do GStreamer `spectrum` element (256 bandas, ~60Hz)
- Inserido na pipeline GStreamer como passthrough: `[DSP bin] → [spectrum] → [sink]`
- Bus sync handler intercepta mensagens do spectrum **antes** do GLib MainContext
- Thread dedicada `spectrum-emitter` emite `audio-fft` direto pro webview
- Canal crossbeam separado (bounded 4) — spectrum nunca compete com player state events

**Frontend (SolidJS):**
- `SpectrumBackground.tsx` — canvas com displacement vetorial baseado em normal map
- 256 bins lineares → 128 bins logaritmicos (remapeamento `t^2.5` pra detalhe nos graves)
- 7 regioes de frequencia (sub-bass → brilliance) mapeadas a faixas de linhas
- Cor adapta ao `dominant_color` da track via `getTrackColor()`
- Shapes carregadas de `~/.local/share/rustify-player/media/shapes/` (file discovery)
- Sobel filter computa normal map uma vez no load → displacement perpendicular aos contornos

**Tauri commands:**
- `list_shapes` — scan do diretorio de shapes, retorna nomes
- `onAudioFft` — listener tipado no `tauri.ts`

**Layout Now Playing reestruturado:**
- Coluna unica a esquerda (max-width 420px): cover 200px + metadata + lyrics (max-width 320px)
- Background: canvas spectrum ocupa area inteira, liberando lado direito pro visual

### 4. Shapes deployadas na cmr-auto

3 shapes em `~/.local/share/rustify-player/media/shapes/`:
- `flame.png` — forma de labareda com gradiente vertical (melhor resultado visual)
- `heart.png` — coracao via equacao parametrica com falloff radial
- `nebula.png` — 5 nos gravitacionais espalhados a direita, fade no lado esquerdo

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/audio-engine/src/output/spectrum.rs` | Criado | GStreamer spectrum wrapper, 256 bandas 60Hz |
| `src-tauri/crates/audio-engine/src/output/mod.rs` | Modificado | +pub mod spectrum |
| `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs` | Modificado | +spectrum no pipeline, +bus() method |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | +sync handler, +spectrum_rx, tick 16ms |
| `src-tauri/crates/audio-engine/src/lib.rs` | Modificado | +SpectrumAnalyzer export, +spectrum_rx em EngineHandle |
| `src-tauri/crates/audio-engine/src/types.rs` | Modificado | +StateUpdate::SpectrumData |
| `src-tauri/crates/audio-engine/examples/play_file.rs` | Modificado | +SpectrumData arm no match |
| `src-tauri/src/lib.rs` | Modificado | +list_shapes, +spectrum-emitter thread dedicada |
| `src/components/SpectrumBackground.tsx` | Criado | Canvas com normal map displacement, log remap |
| `src/views/NowPlaying.tsx` | Modificado | -bg imagem, +SpectrumBackground, +shape picker |
| `src/views/Visualizer.tsx` | Criado | Standalone (nao usado, rota removida) |
| `src/tauri.ts` | Modificado | +onAudioFft, +listShapes |
| `src/styles/components.css` | Modificado | NP layout coluna unica, shape nav, lyrics max-width |
| `src/assets/icons.svg` | Modificado | +icon-activity |
| `scripts/gemini-classify-tracks.py` | Criado | Classificador Gemini batch |
| `scripts/classify-local.py` | Criado | Classificador Ollama local (nao usado, prova de conceito) |
| `data/mood-classifications.json` | Criado | 983 tracks classificadas |

## Decisoes tomadas

- **GStreamer spectrum nativo vs rustfft manual:** Spectrum element — zero thread extra, zero ring buffer, ja integrado no pipeline, faz windowing e magnitude internamente.
- **Push (evento) vs Pull (invoke) pra FFT:** Push via evento Tauri — invoke seria 60 round-trips/s com overhead de request/response. Push e fire-and-forget.
- **Thread dedicada vs event-listener compartilhado:** Thread `spectrum-emitter` dedicada — spectrum competia com state/position/EOS no mesmo channel, causando delay e tela branca.
- **Bus sync handler vs pop_filtered:** Sync handler — `ctx.iteration(false)` do GLib MainContext consumia mensagens Element do bus antes do poll_spectrum ler. Sync handler intercepta no momento do post.
- **512 vs 256 bandas:** 256 — 512 com 60Hz causava tela branca no WebKitGTK (overhead de serialization IPC). 256 com remap log da resolucao suficiente nos graves.
- **getUserMedia/Web Audio vs IPC:** IPC — WebKitGTK nao compila com ENABLE_MEDIA_STREAM por default, e Tauri/wry nega permissoes automaticamente no Linux.
- **Layout NP:** Coluna unica a esquerda — libera lado direito pro spectrum, lyrics nao tapam o visual.
- **Shapes como file discovery:** PNGs em `media/shapes/`, app lista automaticamente. Sem bundle no .deb.

## Metricas

| Metrica | Valor |
|---------|-------|
| Tracks classificadas Gemini | 983/983 |
| Custo Gemini | $0.065 |
| Modelo Gemini | gemini-2.5-flash |
| Bandas spectrum | 256 (linear) → 128 (log remap) |
| Taxa spectrum | ~60Hz |
| Shapes deployadas | 3 (flame, heart, nebula) |

## Pendencias identificadas

1. **Tela branca intermitente** (alta) — webview crasha apos uso prolongado. Thread dedicada deveria resolver, mas nao validado. Possivel leak de eventos ou acumulo no canal. Pode ser memoria do canvas rAF.
2. **Reatividade do visualizador** (alta) — usuario reportou animacao fraca e delay consideravel. Thread dedicada + 60Hz devem melhorar, mas precisa validar.
3. **Visualizer.tsx standalone** (baixa) — arquivo criado e rota adicionada/removida. Pode ser deletado ou mantido como opcao futura.
4. **Shape picker UX** (media) — setas no canto superior direito funcionam, mas nao mostram nome da shape ativa. localStorage pra persistencia (deveria ser Tauri Store).
5. **49 tracks sem enrichment point** (baixa) — tracks adicionadas apos a migracao nao tem ponto na `track_enrichments`. Script de classify gravou dados no JSON mas `set_payload` ignorou silenciosamente.
6. **Imagens de shape** (media) — flame ficou otima, heart e nebula sao basicas (geradas em Python puro). Usuario quer mais shapes e melhor qualidade. Possibilidade de usar Gemini/Flux pra gerar silhuetas.
7. **Commit pendente** — mudancas do spectrum visualizer nao commitadas (13 arquivos modified + 6 untracked).
