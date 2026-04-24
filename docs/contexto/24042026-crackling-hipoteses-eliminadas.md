# Contexto: Crackling — eliminacao sistematica de hipoteses

**Data:** 2026-04-24
**Sessao:** main (pos merge de fix-playback-race-condition)
**Duracao:** longa

---

## O que foi feito

### 1. Documento tecnico completo da pipeline
Produzido e salvo em `docs/plans/`. Mapeia end-to-end: FLAC no disco -> symphonia -> remap -> volume -> rtrb ring (1.5s f32) -> callback PipeWire -> graph -> DAC. Identifica 14 pontos onde sinal pode degradar.

### 2. ReplayGain 2.0 implementado
Track mode hardcoded, sempre ativo, sem toggle UI. Aplica `track_gain` com clip prevention (`1.0/peak * 0.98`) + `-1 dB` ISP safety. Fallback `-3 dB` para tracks sem RG tags. Multiplicacao no loop junto com volume: `sample *= volume * effective_gain`.

### 3. Telemetria de integridade em release
`pipewire_backend.rs` emite log throttled (a cada 200 callbacks) com: `callback_n`, `max_abs_ema`, `max_abs_period`, `xruns_total`, `xruns_delta`, `clip_count`, `written_frames`. Validou que sinal sai limpo da app (max_abs <1.0, zero clips, zero xruns).

### 4. Stream PipeWire alinhado com mpv
- `F32LE` -> `S32LE` no formato negociado
- Removido `node.latency = "1024/{rate}"`
- Adicionado `node.always-process = true`
- Callback converte f32 -> i32 via `clamp(-1,1) * (i32::MAX as f32) as i32`

### 5. SCHED_FIFO desabilitado (diagnostico)
Em `engine.rs`, removida promocao da pump thread para `SCHED_FIFO rtprio 50`. Substituida por log info. Thread roda em `SCHED_OTHER` default.

## Hipoteses eliminadas

| H | Hipotese | Como eliminada |
|---|---|---|
| H1 | Intersample peaks + hard clip no sink | Telemetria: max_abs_period max 0.68, clip_count=0 |
| H2 | EasyEffects | User testou `pkill easyeffects`, crackling persistiu |
| H3 | Volume >100% | Sink 58%, app clamp [0,1] |
| H4 | Xrun underrun | xruns_total=0 em todos os logs |
| H5 | Quantum pequeno | clock.quantum=8192 |
| H6 | F32LE vs S32LE | Trocado pra S32LE + props mpv-like, persistiu |
| H7 | SCHED_FIFO rtprio 50 interferindo | Desabilitado em cd87138, user reportou que persistiu |

**Referencia de contraste:** `pw-play` (libpipewire puro, decode-in-callback) toca a mesma FLAC atraves da mesma cadeia (graph + EE + HA01) **crispy clean**. O problema e ESPECIFICAMENTE algo que o rustify adiciona.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---|---|---|
| `src-tauri/crates/audio-engine/src/types.rs` | Modificado | +4 campos RG em TrackInfo |
| `src-tauri/crates/audio-engine/src/decoder.rs` | Modificado | +extract_replaygain, parse Vorbis comments |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | +compute_track_gain, LoadedTrack.effective_gain, SCHED_FIFO disabled |
| `src-tauri/crates/audio-engine/src/output/pipewire_backend.rs` | Modificado | S32LE, telemetria release, always-process, scratch f32->i32 |

## Commits desta sessao

```
cd87138 chore(audio-engine): disable SCHED_FIFO on pump thread (diagnostic)
2a7b8eb fix(audio-engine): negotiate S32LE and mirror mpv stream properties
0c5646a feat(audio-engine): expand integrity telemetry with xrun delta and period max
4c6587e feat(audio-engine): integrity telemetry in release builds with throttled EMA
78e3b88 feat(audio-engine): apply ReplayGain track gain with clip prevention
```

## Decisoes tomadas

- **RG Track mode hardcoded, sem toggle:** risco de user desligar e voltar a ouvir crackling, zero valor em expor no UI.
- **NAO subir speex resample quality:** literatura mostra que aumenta pre/post-ringing em loudness-war.
- **NAO implementar rate matching no graph agora:** ortogonal, wireplumber policy. Followup arquitetural.
- **Refactor pra decode-in-callback fica gated por teste de isolamento:** nao comecar 500 linhas sem saber se a engine e culpada.

## Pendencias identificadas

1. **(alta) Teste de isolamento via example play_file** — buildar `cargo build --release -p audio-engine --example play_file`, scp pra cmr-auto, rodar numa FLAC que crackla. Se crackla sem Tauri, culpa e da audio-engine (pump+ring). Se limpa, culpa e algo que Tauri/webview adiciona por cima.
2. **(condicional a 1)** Se engine culpada: branch `refactor/callback-decode-inline`, migrar de pump+ring pra decode-on-demand no process callback. ~300-500 linhas.
3. **(condicional a 1)** Se Tauri culpado: investigar webkit2gtk CPU pressure, Tauri IPC scheduler impact, MPRIS/D-Bus hooks na engine thread.
4. **(baixa) Followup:** rate matching observation via pw-top, badge "RG" na tech strip quando gain aplicado, tooltip com track_gain/peak.
