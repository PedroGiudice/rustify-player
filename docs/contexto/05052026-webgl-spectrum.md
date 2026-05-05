# Contexto: WebGL2 Spectrum + Emit Subscribe + Clock Sync

**Data:** 2026-05-05
**Branch:** main
**Commit:** fb38f51

---

## O que foi feito

### 1. Migração Canvas 2D → WebGL2

Spectrum visualizer reescrito pra GPU rendering. Vertex shader calcula displacement (normal map + FFT energy), fragment shader aplica HSL coloring por depth. CPU per-frame: <1ms (vs 8-16ms antes).

Interface do shader:
- `u_normalMap` (texture2D RGB8): brightness, nx, ny packed [0,255] — Sobel computed on shape load
- `u_fft` (texture2D R8, 128x1): smoothed FFT bins — uploaded every frame via `texSubImage2D`
- `u_resolution` (vec2): canvas clientWidth/Height
- `u_baseHue` (float): hue from track dominant_color

### 2. Data delivery: emit + subscribe guard

Custom protocol removido. Voltou pro `emit("audio-fft")` mas com `AtomicBool` controlado por `spectrum_subscribe`/`spectrum_unsubscribe` commands. Zero IPC quando fora do Now Playing.

### 3. Clock-based sync (PROBLEMA PENDENTE)

Emitter usa `SharedMetrics::live_running_time_ns()` que lê o pipeline clock diretamente (nanosegundo). Só emite quando `frame_timestamp <= clock_position`. Apesar disso, **o spectrum ainda está adiantado ~1s em relação ao áudio**.

Hipótese: o `running-time` da mensagem spectrum NÃO é o presentation timestamp do áudio. É o timestamp de quando o buffer entrou no spectrum element — que está ANTES do sink na pipeline. A diferença = latência do sink + buffer do PipeWire.

### 4. SpectrumRangesPanel + Theme System

- Painel de ranges com 4 presets (Full Range, Bass Focus, Vocal Range, Treble Detail)
- Theme YAML system com WCAG AA contrast validation no backend
- Fix de inputs (onChange vs onInput pra evitar reset de cursor em SolidJS)

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/components/SpectrumBackground.tsx` | Reescrito | WebGL2 renderer completo |
| `src/components/SpectrumRangesPanel.tsx` | Criado | UI de configuração de bandas |
| `src/tauri.ts` | Modificado | +spectrumSubscribe/Unsubscribe, +onAudioFft, +theme APIs |
| `src/views/Visualizer.tsx` | Modificado | Subscribe pattern |
| `src/views/NowPlaying.tsx` | Modificado | +SpectrumRangesPanel toggle |
| `src/views/Settings.tsx` | Modificado | +ThemeSection |
| `src-tauri/src/lib.rs` | Modificado | +subscribe commands, +emitter com clock sync, +theme commands |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | +SharedMetrics.pipeline_clock, +live_running_time_ns() |
| `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs` | Modificado | +pipeline_clock(), +pipeline_base_time_ns() |

## Decisoes tomadas

- **WebGL2 em vez de OffscreenCanvas+Worker**: GPU resolve o problema (Worker só esconde). Escalável pra mais linhas/pontos sem custo.
- **Emit + subscribe em vez de custom protocol pull**: Emit é zero-latência (push). Custom protocol adicionava overhead HTTP por frame.
- **Voltar pro emit**: O custom protocol `spectrum://` foi implementado e funcionou mas: (a) CSP bloqueava inicialmente, (b) 60 fetch/s é mais pesado que emit, (c) latência pior.
- **Tema Monochrome**: accent corrigido de #666666 → #8A8A8A (3.21:1 → 5.73:1 contra base).

## Pendencias identificadas

1. **Spectrum dessincronizado** (alta) — animação ~1s adiantada ao áudio. Clock sync implementado mas não resolve. Causa provável: diferença entre timestamp do FFT message e momento real de playback.
2. **Performance na navegação** (média) — app freezou quando navegou rapidamente entre views + trocou tracks. WebGL deveria resolver, mas precisa confirmar.
3. **Dead code** (baixa) — `SpectrumConfig::regroup()` não é mais usado. Limpar.
