# Contexto: PipeWire FFT Capture (substituicao GStreamer spectrum)

**Data:** 2026-05-05
**Branch:** main
**Commit base:** fb38f51 | Uncommitted: +604 -241 lines across 15 files

---

## O que foi feito

### 1. Diagnostico conclusivo do problema de sync

Logs diagnosticos confirmaram: `stream-time` das mensagens spectrum do GStreamer esta **1.3s a frente** do que `GstPlay::position()` retorna ao frontend. Causa: buffering interno do playbin (decode queue), nao DSP ou PipeWire. Todas as abordagens intra-pipeline falharam:
- Gating por pipeline clock (sessao anterior)
- Ring buffer com matching temporal no frontend
- Emitir `position_ns` em vez de `stream-time`

### 2. Implementacao PipeWire FFT capture

Substitui o spectrum element do GStreamer por captura direta via PipeWire monitor:

**Arquitetura:**
```
[App GStreamer sink] -> [PipeWire graph] -> [speakers]
                              ^
               [pw_stream capture (sink monitor)]
                              |
                    [rtrb lock-free ring buffer]
                              |
                    [rustfft 1024-sample FFT]
                              |
                   [spectrum_buf Arc<Mutex>]
                              |
                    [emitter -> emit("audio-fft")]
```

### 3. Frontend simplificado

Removido ring buffer temporal e clock sync. Frontend renderiza direto no recebimento — PW capture e inherentemente sincronizado.

### 4. tauri-plugin-log integrado

Logging via `tauri-plugin-log` com targets Stdout + Webview + LogDir. Frontend com `attachConsole()`.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/audio-engine/src/output/pw_capture.rs` | Criado | PipeWire capture + FFT worker (346 LOC) |
| `src-tauri/crates/audio-engine/src/output/spectrum.rs` | Deletado | GStreamer spectrum element removido |
| `src-tauri/crates/audio-engine/src/output/mod.rs` | Mod | `pub mod pw_capture` substitui `pub mod spectrum` |
| `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs` | Mod | Spectrum element removido do pipeline, so DSP |
| `src-tauri/crates/audio-engine/src/engine.rs` | Mod | PwCapture::start() substitui bus sync_handler; position_ns removido |
| `src-tauri/crates/audio-engine/src/lib.rs` | Mod | Removido re-export de SpectrumAnalyzer |
| `src-tauri/crates/audio-engine/Cargo.toml` | Mod | +pipewire, +libspa, +rtrb, +rustfft, +bytemuck |
| `src-tauri/Cargo.toml` | Mod | +rustfft, +bytemuck, +tauri-plugin-log, +log |
| `src-tauri/src/lib.rs` | Mod | tauri-plugin-log setup; emitter simplificado (render-immediate); regroup() removido |
| `src-tauri/capabilities/default.json` | Mod | +log:default |
| `src/components/SpectrumBackground.tsx` | Mod | Ring buffer e clock removidos; render direto |
| `src/main.tsx` | Mod | +attachConsole() |
| `package.json` | Mod | +@tauri-apps/plugin-log |

## Decisoes tomadas

- **PipeWire capture em vez de compensacao de latencia**: compensar e fragil (valor depende de DSP, quality, PW quantum). PW capture analisa audio pos-sink = zero delta.
- **STREAM_CAPTURE_SINK sem target.object**: target.object="rustify-player" causava loop (capturava de si mesmo). Sem target, conecta ao default sink monitor.
- **rustfft 1024 + Hanning**: 512 bins positivos, ~60Hz refresh, threshold -80dB.
- **rtrb (lock-free SPSC)**: ja estava no workspace, RT-safe no process callback.

## Pendencias identificadas

1. **PW capture produz zeros** (BLOQUEADOR) — frame chega com `max=0`. Ultimo fix: remover `target.object`. Hipoteses: (a) `STREAM_CAPTURE_SINK` nao linkando ao monitor correto, (b) formato F32LE nao negociado, (c) chunk.size = 0 no callback.
2. **Logs Rust nao aparecem no DevTools** (media) — `attachConsole()` adicionado mas pode precisar de await ou timing diferente.
3. **DevTools abre automaticamente** (baixa) — remover `open_devtools()` apos debug.
4. **Dead code warning** — `SpectrumConfig` vazio (struct existe pra API de ranges, impl vazia).
5. **Plano de implementacao** — `docs/superpowers/plans/2026-05-05-pipewire-fft-capture.md` (Tasks 1-6 completas, Task 7 pendente: teste E2E).
