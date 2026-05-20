# EQ Real-time Post-DSP Spectrum Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renderizar barras 1/3 oitava ISO do spectrum real (pos-DSP) sob a curva parametrica do EqCanvas, com peak-hold, herdando a cor `--bg-ink-rgb` e controlado por toggle no Tweaks.

**Architecture:** Reusa o evento `audio-fft` ja existente (PipeWire monitor → FFT 2048). Frontend agrega 1024 bins lineares em 31 bandas ISO, aplica IIR attack/release + peak-hold/decay, desenha no mesmo canvas do EQ atras da curva. Backend recebe apenas adicao de `sample_rate` ao payload.

**Tech Stack:** Rust (audio-engine, Tauri), TypeScript + Solid.js (frontend), Vitest, GStreamer/PipeWire (existente).

**Spec:** `docs/superpowers/specs/2026-05-17-eq-realtime-spectrum-overlay-design.md`

---

## File Structure

| File | Status | Responsabilidade |
|---|---|---|
| `src-tauri/crates/audio-engine/src/output/pw_capture.rs` | Modify | `start()` aceita Arc<AtomicU32> sample_rate em vez de criar internamente |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modify | Cria e mantem Arc sample_rate; passa pra `start()` |
| `src-tauri/crates/audio-engine/src/lib.rs` | Modify | `EngineHandle` expoe `sample_rate_buf()` |
| `src-tauri/src/lib.rs` | Modify | `FftPayload` ganha campo `sample_rate: u32`; spectrum-emitter le e preenche |
| `src/tauri.ts` | Modify | Interface `FftPayload` ganha `sample_rate: number` |
| `src/components/dsp/spectrum-bands.ts` | Create | Pure functions: ISO_CENTERS, computeBinRanges, decodeDb, smoothToward, updatePeak |
| `src/components/dsp/spectrum-bands.test.ts` | Create | Vitest unit tests pro modulo acima |
| `src/store/tweaks.ts` | Modify | Campo `eqSpectrumOverlay: boolean` + DEFAULTS + applyTweaks data attr |
| `src/views/Tweaks.tsx` | Modify | `<Segmented>` "EQ spectrum overlay" proximo ao bg-ink |
| `src/components/dsp/EqCanvas.tsx` | Modify | Listener `audio-fft`, rAF loop, draw barras+peaks |
| `src/components/dsp/EqCanvas.test.tsx` | Modify | Cobre toggle on/off + listener registration |
| `src-tauri/tauri.conf.json` | Modify | Bump versao 0.2.22 -> 0.2.23 |

---

## Task 1: Backend — expor sample_rate compartilhado da capture

**Files:**
- Modify: `src-tauri/crates/audio-engine/src/output/pw_capture.rs:95-141`
- Modify: `src-tauri/crates/audio-engine/src/engine.rs:105-150`
- Modify: `src-tauri/crates/audio-engine/src/lib.rs:39-85`

- [ ] **Step 1: Tornar `start()` aceita o sample_rate como parametro**

Em `src-tauri/crates/audio-engine/src/output/pw_capture.rs`, substituir a assinatura e a criacao interna do `sample_rate`:

```rust
pub fn start(
    target_node: &str,
    spectrum_buf: Arc<Mutex<(u64, Vec<u8>)>>,
    envelope_buf: SharedEnvelope,
    sample_rate: SharedSampleRate,
) -> Option<PwCaptureHandle> {
    let running = Arc::new(AtomicBool::new(true));

    // Lock-free SPSC ring buffer: PW RT thread produces, FFT thread consumes.
    let (producer, consumer) = rtrb::RingBuffer::<f32>::new(RING_BUF_CAPACITY);

    let running_pw = running.clone();
    let target = target_node.to_string();
    let sample_rate_pw = sample_rate.clone();

    let pw_thread = thread::Builder::new()
        .name("pw-capture".into())
        .spawn(move || {
            if let Err(e) = pw_capture_loop(&target, producer, running_pw, sample_rate_pw) {
                error!("PipeWire capture loop failed: {e}");
            }
        })
        .ok()?;

    let running_fft = running.clone();

    let fft_thread = thread::Builder::new()
        .name("fft-worker".into())
        .spawn(move || {
            fft_worker_loop(consumer, spectrum_buf, envelope_buf, sample_rate, running_fft);
        })
        .ok()?;

    Some(PwCaptureHandle {
        running,
        pw_thread: Some(pw_thread),
        fft_thread: Some(fft_thread),
    })
}
```

A unica mudanca real e remover a linha `let sample_rate: SharedSampleRate = Arc::new(...)` e receber por parametro.

- [ ] **Step 2: Tornar `SharedSampleRate` publico no module pw_capture**

Em `src-tauri/crates/audio-engine/src/output/pw_capture.rs`, mudar a declaracao do alias:

```rust
pub type SharedSampleRate = Arc<std::sync::atomic::AtomicU32>;
```

(antes era `type SharedSampleRate = ...`).

- [ ] **Step 3: Criar o Arc no engine.rs e passar pra start()**

Em `src-tauri/crates/audio-engine/src/engine.rs`, logo antes do bloco que ja inicializa o `envelope_latest`, adicionar:

```rust
// Sample rate atomico, publicado pelo PW capture e lido pelo
// spectrum-emitter pra anexar ao payload de audio-fft.
let sample_rate_atom: crate::output::pw_capture::SharedSampleRate =
    std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
let sample_rate_pub = sample_rate_atom.clone();
```

Depois, dentro do `thread::Builder::new().spawn(move || { ... })`, modificar a chamada `pw_capture::start(...)`:

```rust
let _pw_capture = crate::output::pw_capture::start(
    "rustify-player",
    spectrum_latest.clone(),
    envelope_latest.clone(),
    sample_rate_atom.clone(),
);
```

Move `sample_rate_atom` para dentro do closure (igual aos demais `_pub` patterns).

- [ ] **Step 4: Adicionar campo `sample_rate_buf` no EngineHandle + getter**

Em `src-tauri/crates/audio-engine/src/lib.rs`, modificar o struct:

```rust
#[derive(Clone)]
pub struct EngineHandle {
    pub(crate) command_tx: crossbeam_channel::Sender<Command>,
    pub(crate) state_rx: Receiver<StateUpdate>,
    pub(crate) metrics: std::sync::Arc<engine::SharedMetrics>,
    pub(crate) spectrum_buf: std::sync::Arc<std::sync::Mutex<(u64, Vec<u8>)>>,
    pub(crate) envelope_buf: std::sync::Arc<std::sync::Mutex<SpectrumEnvelope>>,
    pub(crate) sample_rate_buf: output::pw_capture::SharedSampleRate,
}
```

E adicionar metodo getter:

```rust
/// Sample rate atomico publicado pelo PipeWire capture (0 = nao
/// negociado ainda). Consumido pelo spectrum-emitter pra incluir
/// no payload de audio-fft.
pub fn sample_rate_buf(&self) -> output::pw_capture::SharedSampleRate {
    self.sample_rate_buf.clone()
}
```

E re-exportar o type alias:

```rust
pub use output::pw_capture::{SharedSampleRate, SpectrumEnvelope};
```

- [ ] **Step 5: Preencher o novo campo no construtor do EngineHandle**

Em `src-tauri/crates/audio-engine/src/engine.rs`, no `Ok(EngineHandle { ... })` final, adicionar:

```rust
Ok(EngineHandle {
    command_tx,
    state_rx,
    metrics,
    spectrum_buf: spectrum_latest_pub,
    envelope_buf: envelope_latest_pub,
    sample_rate_buf: sample_rate_pub,
})
```

- [ ] **Step 6: Run cargo check**

Run: `cargo check --manifest-path /home/opc/rustify-player/src-tauri/Cargo.toml`
Expected: `Finished` sem erros.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/audio-engine/src/output/pw_capture.rs \
        src-tauri/crates/audio-engine/src/engine.rs \
        src-tauri/crates/audio-engine/src/lib.rs
git commit -m "feat(audio-engine): expoe sample_rate compartilhado pra spectrum-emitter

Permite que o spectrum-emitter inclua a sample rate negociada
do PipeWire no payload audio-fft, necessario pro frontend
calcular bin->banda correto em qualquer SR (44.1/48/96 kHz)."
```

---

## Task 2: Backend — adicionar sample_rate ao FftPayload

**Files:**
- Modify: `src-tauri/src/lib.rs:46-51` (struct)
- Modify: `src-tauri/src/lib.rs:2674-2738` (emitter)

- [ ] **Step 1: Adicionar campo no struct FftPayload**

Em `src-tauri/src/lib.rs`, substituir o struct:

```rust
#[derive(Clone, Serialize)]
struct FftPayload {
    stream_time_ms: u64,
    magnitudes: Vec<u8>,
    low_band_mag: f32,
    rms_energy: f32,
    /// Sample rate negociada pelo PipeWire (Hz). 0 enquanto nao
    /// negociado. Frontend usa pra calcular bin->banda do RTA.
    sample_rate: u32,
}
```

- [ ] **Step 2: Ler sample_rate no setup do emitter e preencher no payload**

Em `src-tauri/src/lib.rs`, perto da linha 2674 onde `spectrum_buf` e capturado, adicionar:

```rust
let spectrum_buf = engine.spectrum_buffer();
let envelope_buf = engine.envelope_buffer();
let sample_rate_buf = engine.sample_rate_buf();
```

E na construcao do payload (linha ~2732):

```rust
let payload = FftPayload {
    stream_time_ms: 0,
    magnitudes: fft,
    low_band_mag: envelope.low_band_mag,
    rms_energy: envelope.rms_energy,
    sample_rate: sample_rate_buf.load(std::sync::atomic::Ordering::Relaxed),
};
```

Para essa ultima linha funcionar o closure precisa capturar `sample_rate_buf`. Verificar o move pattern e adicionar o clone explicito antes do `std::thread::Builder::new()` se necessario.

- [ ] **Step 3: Run cargo check**

Run: `cargo check --manifest-path /home/opc/rustify-player/src-tauri/Cargo.toml`
Expected: `Finished` sem erros.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(spectrum): adiciona sample_rate ao FftPayload

Frontend precisa pra mapear bins -> bandas 1/3 oitava ISO
em qualquer sample rate (44.1/48/96)."
```

---

## Task 3: Frontend — atualizar interface FftPayload

**Files:**
- Modify: `src/tauri.ts:224-231`

- [ ] **Step 1: Adicionar campo `sample_rate` na interface**

Em `src/tauri.ts`, substituir o bloco `FftPayload`:

```ts
export interface FftPayload {
  stream_time_ms: number;
  magnitudes: number[];
  /** Envelope follower do range 20-150 Hz (attack ~5ms, release ~100ms). 0..1. */
  low_band_mag: number;
  /** RMS slow-averaged (lowpass ~2 Hz) sobre todas as bands. 0..1. */
  rms_energy: number;
  /** Sample rate negociada do PipeWire (Hz). 0 enquanto nao negociado. */
  sample_rate: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tauri.ts
git commit -m "feat(spectrum): FftPayload ganha sample_rate no contrato TS"
```

---

## Task 4: Frontend — spectrum-bands utility (TDD)

**Files:**
- Create: `src/components/dsp/spectrum-bands.ts`
- Create: `src/components/dsp/spectrum-bands.test.ts`

- [ ] **Step 1: Escrever testes falhando**

Criar `src/components/dsp/spectrum-bands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ISO_CENTERS,
  NUM_BANDS,
  FFT_SIZE,
  NUM_BINS,
  SOURCE_DB_FLOOR,
  SOURCE_DB_RANGE,
  computeBinRanges,
  decodeDb,
  smoothToward,
  updatePeak,
  type PeakState,
} from "./spectrum-bands";

describe("ISO_CENTERS", () => {
  it("tem 31 bandas", () => {
    expect(ISO_CENTERS.length).toBe(31);
    expect(NUM_BANDS).toBe(31);
  });

  it("comeca em 20Hz e termina em 20kHz", () => {
    expect(ISO_CENTERS[0]).toBe(20);
    expect(ISO_CENTERS[30]).toBe(20000);
  });

  it("e estritamente crescente", () => {
    for (let i = 1; i < ISO_CENTERS.length; i++) {
      expect(ISO_CENTERS[i]).toBeGreaterThan(ISO_CENTERS[i - 1]);
    }
  });
});

describe("computeBinRanges", () => {
  it("retorna 31 ranges para 48kHz", () => {
    const ranges = computeBinRanges(48000);
    expect(ranges.length).toBe(31);
  });

  it("banda 20Hz comeca em bin >= 1 (DC excluido)", () => {
    const ranges = computeBinRanges(48000);
    expect(ranges[0][0]).toBeGreaterThanOrEqual(1);
  });

  it("banda 20kHz termina dentro de NUM_BINS", () => {
    const ranges = computeBinRanges(48000);
    expect(ranges[30][1]).toBeLessThanOrEqual(NUM_BINS);
  });

  it("cada range tem start < end", () => {
    const ranges = computeBinRanges(48000);
    for (const [s, e] of ranges) expect(s).toBeLessThan(e);
  });

  it("44.1kHz produz ranges diferentes de 48kHz", () => {
    const r44 = computeBinRanges(44100);
    const r48 = computeBinRanges(48000);
    // Pelo menos uma banda deve diferir em pelo menos 1 bin
    let differs = false;
    for (let i = 0; i < NUM_BANDS; i++) {
      if (r44[i][0] !== r48[i][0] || r44[i][1] !== r48[i][1]) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it("ranges sao monotonicamente crescentes", () => {
    const ranges = computeBinRanges(48000);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeGreaterThanOrEqual(ranges[i - 1][0]);
    }
  });
});

describe("decodeDb", () => {
  it("u8=0 -> SOURCE_DB_FLOOR", () => {
    expect(decodeDb(0)).toBeCloseTo(SOURCE_DB_FLOOR, 5);
  });

  it("u8=255 -> 0dB (DB_FLOOR + DB_RANGE)", () => {
    expect(decodeDb(255)).toBeCloseTo(SOURCE_DB_FLOOR + SOURCE_DB_RANGE, 5);
  });

  it("u8=128 -> aprox meio do range", () => {
    const mid = SOURCE_DB_FLOOR + (128 / 255) * SOURCE_DB_RANGE;
    expect(decodeDb(128)).toBeCloseTo(mid, 5);
  });
});

describe("smoothToward (IIR attack/release)", () => {
  it("attack: convergencia rapida quando target > current", () => {
    // dt=30ms, attack_tau=30ms => alpha = 1-exp(-1) ≈ 0.632
    const next = smoothToward(-40, -10, 0.030, 0.030, 0.150);
    // de -40 a -10 (delta 30), 63.2% => current + 30*0.632 ≈ -21
    expect(next).toBeCloseTo(-40 + 30 * (1 - Math.exp(-1)), 2);
  });

  it("release: convergencia lenta quando target < current", () => {
    // dt=150ms, release_tau=150ms => alpha = 1-exp(-1) ≈ 0.632
    const next = smoothToward(-10, -40, 0.150, 0.030, 0.150);
    expect(next).toBeCloseTo(-10 + (-30) * (1 - Math.exp(-1)), 2);
  });

  it("dt zero nao muda valor", () => {
    expect(smoothToward(-20, -10, 0, 0.030, 0.150)).toBe(-20);
  });
});

describe("updatePeak (peak-hold + decay)", () => {
  it("peak novo acima do atual: substitui e zera age", () => {
    const state: PeakState = { peak: -40, age: 1.0 };
    updatePeak(state, -20, 0.016, 1.5, 18);
    expect(state.peak).toBe(-20);
    expect(state.age).toBe(0);
  });

  it("durante hold (age < 1.5s): peak nao decai", () => {
    const state: PeakState = { peak: -10, age: 0.5 };
    updatePeak(state, -20, 0.016, 1.5, 18);
    expect(state.peak).toBeCloseTo(-10, 5);
    expect(state.age).toBeCloseTo(0.516, 3);
  });

  it("apos hold expirado: decay a 18 dB/s", () => {
    const state: PeakState = { peak: -10, age: 1.5 };
    updatePeak(state, -30, 0.100, 1.5, 18);
    // age vai pra 1.6, ja passou hold; decai 18*0.1 = 1.8 dB
    expect(state.peak).toBeCloseTo(-11.8, 2);
  });

  it("peak nunca cai abaixo do current mag", () => {
    const state: PeakState = { peak: -20, age: 2.0 };
    // current = -19 > peak apos decay; peak deve subir pra -19
    updatePeak(state, -19, 0.016, 1.5, 18);
    expect(state.peak).toBe(-19);
    expect(state.age).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests para verificar falha**

Run: `cd /home/opc/rustify-player && bunx vitest run src/components/dsp/spectrum-bands.test.ts`
Expected: FAIL — modulo `./spectrum-bands` nao existe.

- [ ] **Step 3: Implementar o modulo**

Criar `src/components/dsp/spectrum-bands.ts`:

```ts
/* ============================================================
   spectrum-bands.ts — Utilities puros pro overlay de RTA do EQ.

   - 31 centros ISO 1/3 oitava (20 Hz a 20 kHz)
   - Mapeamento bin (linear) -> banda (log) dependente de sample_rate
   - Decode dB do u8 transportado em audio-fft (DB_FLOOR=-80, RANGE=80)
   - IIR attack/release one-pole por banda
   - Peak hold + decay linear

   Mantido sem dependencia de Solid/DOM pra testar facil.
   ============================================================ */

export const FFT_SIZE = 2048;
export const NUM_BINS = 1024;

/** Constantes do backend (pw_capture.rs::fft_worker_loop). */
export const SOURCE_DB_FLOOR = -80;
export const SOURCE_DB_RANGE = 80;

/** Centros das 31 bandas ISO 1/3 oitava (20 Hz – 20 kHz). */
export const ISO_CENTERS: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160,
  200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
  20000,
];

export const NUM_BANDS = ISO_CENTERS.length;

/** Fator de 1/6 oitava para edges das bandas. 2^(1/6) ≈ 1.122462 */
const SIXTH_OCT = Math.pow(2, 1 / 6);

/** Range de tempos do IIR (segundos). */
export const ATTACK_TAU_S = 0.030;
export const RELEASE_TAU_S = 0.150;

/** Peak-hold: tempo segurando (s) e decay apos (dB/s). */
export const PEAK_HOLD_S = 1.5;
export const PEAK_DECAY_DBS = 18;

/** Display range (clamp visual). Backend transporta [-80, 0]. */
export const DISPLAY_DB_MIN = -60;
export const DISPLAY_DB_MAX = 0;

/**
 * Computa, para cada centro ISO, o range [startBin, endBin) cobrindo
 * [f/2^(1/6), f*2^(1/6)] na frequencia do FFT linear.
 * Bin frequency = i * sample_rate / FFT_SIZE.
 */
export function computeBinRanges(sampleRate: number): Array<[number, number]> {
  const binHz = sampleRate / FFT_SIZE;
  const ranges: Array<[number, number]> = [];
  for (const fCenter of ISO_CENTERS) {
    const fLow = fCenter / SIXTH_OCT;
    const fHigh = fCenter * SIXTH_OCT;
    // bin 0 e DC. Comecamos em 1 no minimo.
    let start = Math.max(1, Math.floor(fLow / binHz));
    let end = Math.min(NUM_BINS, Math.ceil(fHigh / binHz));
    // Garantir pelo menos 1 bin
    if (end <= start) end = Math.min(NUM_BINS, start + 1);
    ranges.push([start, end]);
  }
  return ranges;
}

/** Decode u8 [0..255] -> dB usando o mapping do backend. */
export function decodeDb(u8: number): number {
  return SOURCE_DB_FLOOR + (u8 / 255) * SOURCE_DB_RANGE;
}

/**
 * IIR one-pole assimetrico: attack rapido quando subindo, release
 * lento quando descendo. alpha = 1 - exp(-dt/tau).
 */
export function smoothToward(
  current: number,
  target: number,
  dtSec: number,
  attackTau: number = ATTACK_TAU_S,
  releaseTau: number = RELEASE_TAU_S,
): number {
  if (dtSec <= 0) return current;
  const tau = target > current ? attackTau : releaseTau;
  const alpha = 1 - Math.exp(-dtSec / tau);
  return current + (target - current) * alpha;
}

export interface PeakState {
  peak: number;
  age: number;
}

/**
 * Atualiza peak-hold em-place no state.
 *
 *  - current >= state.peak: peak = current, age = 0
 *  - current < state.peak:  age += dt; se age > hold, peak -= decay*dt
 *  - peak nunca cai abaixo de current
 */
export function updatePeak(
  state: PeakState,
  current: number,
  dtSec: number,
  holdSec: number = PEAK_HOLD_S,
  decayDbPerSec: number = PEAK_DECAY_DBS,
): void {
  if (current >= state.peak) {
    state.peak = current;
    state.age = 0;
    return;
  }
  state.age += dtSec;
  if (state.age > holdSec) {
    state.peak -= decayDbPerSec * dtSec;
    if (state.peak < current) {
      state.peak = current;
      state.age = 0;
    }
  }
}
```

- [ ] **Step 4: Run tests para verificar sucesso**

Run: `cd /home/opc/rustify-player && bunx vitest run src/components/dsp/spectrum-bands.test.ts`
Expected: PASS — todos os 16+ testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/components/dsp/spectrum-bands.ts src/components/dsp/spectrum-bands.test.ts
git commit -m "feat(dsp): spectrum-bands utility com 31 bandas ISO 1/3 oitava

Pure module pra agregacao FFT bins -> bandas perceptuais, decode
dB do payload backend, IIR smoothing assimetrico, peak-hold com
decay. Sem deps de Solid/DOM — TDD-friendly. 16 testes Vitest."
```

---

## Task 5: Frontend — eqSpectrumOverlay no store/tweaks

**Files:**
- Modify: `src/store/tweaks.ts:18-45` (schema + DEFAULTS)
- Modify: `src/store/tweaks.ts:71-122` (applyTweaks data attr)

- [ ] **Step 1: Adicionar campo na interface e DEFAULTS**

Em `src/store/tweaks.ts`, substituir o bloco da interface `TweaksState`:

```ts
export interface TweaksState {
  fontUI: string;
  fontMono: string;
  scale: number;
  density: Density;
  sidebar: Sidebar;
  type: TypeMode;
  glow: number;
  /** Translucidez da caixa de lyrics (Now Playing).
      0   = quase invisivel (alpha 0.04, brightness 0.92)
      0.5 = meio termo
      1   = quase opaco (alpha 0.30, brightness 0.65) */
  lyricsGlass: number;
  /** Cor das linhas do spectrum bg (hex #rrggbb). Default = carbono escuro. */
  bgInk: string;
  /** Overlay de spectrum real (pos-DSP) sob a curva do EQ. */
  eqSpectrumOverlay: boolean;
}
```

E DEFAULTS:

```ts
export const DEFAULTS: TweaksState = {
  fontUI: "",
  fontMono: "",
  scale: 1.0,
  density: "normal",
  sidebar: "labels",
  type: "body",
  glow: 0.15,
  lyricsGlass: 0.25,
  bgInk: "#171717",
  eqSpectrumOverlay: true,
};
```

- [ ] **Step 2: Adicionar data attr no applyTweaks**

Em `src/store/tweaks.ts`, na funcao `applyTweaks`, depois da linha que seta `--bg-ink-rgb`, adicionar:

```ts
  // EQ spectrum overlay: usado apenas pra inspecao via inspector.
  // O EqCanvas le tweaks().eqSpectrumOverlay direto.
  if (s.eqSpectrumOverlay) html.dataset.eqSpectrum = "on";
  else html.dataset.eqSpectrum = "off";
```

- [ ] **Step 3: Commit**

```bash
git add src/store/tweaks.ts
git commit -m "feat(tweaks): adiciona eqSpectrumOverlay (default on)

Flag bool no schema do hub Tweaks pra ligar/desligar o RTA
sob a curva do EQ. Persistido em localStorage como os demais."
```

---

## Task 6: Frontend — Segmented no Tweaks.tsx

**Files:**
- Modify: `src/views/Tweaks.tsx:104-201`

- [ ] **Step 1: Adicionar Segmented "EQ spectrum overlay" no painel**

Em `src/views/Tweaks.tsx`, dentro do `<div class="tweaks__body">`, logo apos o bloco do bg-ink (depois do `</div>` que fecha a row do color picker e antes do `<button class="tweaks__reset">`), adicionar:

```tsx
          <Segmented
            label="EQ spectrum"
            key="eqSpectrumOverlay"
            options={[[true, "On"], [false, "Off"]]}
          />
```

Nota: o componente `Segmented` ja aceita generics `<K extends keyof TweaksState>` e o type de valor `TweaksState[K]`. Como `eqSpectrumOverlay: boolean`, o TS infere corretamente.

- [ ] **Step 2: Verificar tipo do Segmented permite boolean**

Re-ler a definicao do `Segmented` em `src/views/Tweaks.tsx:29-52`. O parametro options e `Array<[TweaksState[K] & string, string]>`. O `& string` impede booleans. Substituir por:

```tsx
function Segmented<K extends keyof TweaksState>(props: {
  label: string;
  key: K;
  options: Array<[TweaksState[K], string]>;
}) {
  return (
    <div class="tweaks__row">
      <span class="tweaks__label">{props.label}</span>
      <div class="segmented">
        <For each={props.options}>
          {([val, text]) => (
            <button
              class="segmented__btn"
              classList={{ "is-active": tweaks()[props.key] === val }}
              onClick={() => updateTweak(props.key, val)}
            >
              {text}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
```

Mudancas: removido `& string` no tipo de `options[0]` e removido cast `as TweaksState[K]` no onClick (TS ja sabe).

- [ ] **Step 3: Smoke check do TS**

Run: `cd /home/opc/rustify-player && bunx tsc --noEmit`
Expected: sem erros relacionados aos arquivos modificados (pode haver erros pre-existentes em outros arquivos, ignorar).

- [ ] **Step 4: Commit**

```bash
git add src/views/Tweaks.tsx
git commit -m "feat(tweaks): toggle 'EQ spectrum' no painel (default on)

Segmented On/Off generalizado pra aceitar boolean (removido
& string do tipo). Comportamento dos outros campos preservado."
```

---

## Task 7: Frontend — integrar overlay no EqCanvas

**Files:**
- Modify: `src/components/dsp/EqCanvas.tsx` (reescrever inteiro)
- Modify: `src/components/dsp/EqCanvas.test.tsx`

- [ ] **Step 1: Atualizar EqCanvas.test.tsx pra cobrir overlay**

Substituir `src/components/dsp/EqCanvas.test.tsx`:

```tsx
/* ============================================================
   EqCanvas.test.tsx — Smoke tests do canvas de curva + overlay.
   Foco: setup, re-render reativo, e que o overlay nao desenha
   quando o toggle esta off.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { EqCanvas } from "./EqCanvas";
import type { EqBand } from "../../store/dsp";
import { updateTweak } from "../../store/tweaks";

const DEFAULT: EqBand[] = Array.from({ length: 16 }, (_, i) => ({
  freq: [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000, 20000][i],
  gain_db: 0,
  q: 2.21,
  type: 1,
  filterMode: 6,
  slope: 0,
  solo: false,
  mute: false,
}));

let drawCalls = 0;
let fillRectCalls = 0;
const recordingCtx: any = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  bezierCurveTo: vi.fn(),
  closePath: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(() => { drawCalls++; }),
  fillRect: vi.fn(() => { fillRectCalls++; }),
  arc: vi.fn(),
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 0,
  lineJoin: "",
  lineCap: "",
};

beforeEach(() => {
  drawCalls = 0;
  fillRectCalls = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => recordingCtx) as any;
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 180, width: 600, height: 180, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  // Garante overlay off antes de cada teste — testes que precisam ligar
  // chamam explicitamente.
  updateTweak("eqSpectrumOverlay", false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EqCanvas", () => {
  it("renderiza um <canvas> e desenha a curva com 16 bands default", () => {
    const { container } = render(() => (
      <EqCanvas bands={DEFAULT} activeBand={0} />
    ));
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(drawCalls).toBeGreaterThan(0);
  });

  it("re-desenha quando bands mudam", async () => {
    const [bands, setBands] = (await import("solid-js")).createSignal(DEFAULT);
    render(() => <EqCanvas bands={bands()} activeBand={0} />);
    const beforeCount = recordingCtx.arc.mock.calls.length;
    setBands(DEFAULT.map((b, i) => i === 5 ? { ...b, gain_db: 4 } : b));
    await Promise.resolve();
    expect(recordingCtx.arc.mock.calls.length).toBeGreaterThan(beforeCount);
  });

  it("re-desenha quando activeBand muda", async () => {
    const [active, setActive] = (await import("solid-js")).createSignal(0);
    render(() => <EqCanvas bands={DEFAULT} activeBand={active()} />);
    const beforeCount = recordingCtx.arc.mock.calls.length;
    setActive(8);
    await Promise.resolve();
    expect(recordingCtx.arc.mock.calls.length).toBeGreaterThan(beforeCount);
  });

  it("nao desenha barras quando eqSpectrumOverlay esta off", () => {
    updateTweak("eqSpectrumOverlay", false);
    render(() => <EqCanvas bands={DEFAULT} activeBand={0} />);
    // sem fft event recebido + overlay off => fillRect nao deve ser chamado
    expect(fillRectCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run testes pra ver os existentes ainda passando + o novo falhando se aplicavel**

Run: `cd /home/opc/rustify-player && bunx vitest run src/components/dsp/EqCanvas.test.tsx`
Expected: 3 dos 4 PASS (os 3 existentes). O 4o pode passar ja se o EqCanvas atual nao chama fillRect — confirma esse comportamento de pre-existencia.

- [ ] **Step 3: Reescrever o EqCanvas.tsx com overlay integrado**

Substituir inteiramente `src/components/dsp/EqCanvas.tsx`:

```tsx
/* ============================================================
   EqCanvas.tsx — Curva de resposta de magnitude do EQ + overlay
   de spectrum REAL pos-DSP (RTA 1/3 oitava com peak-hold).

   Camadas (ordem z de baixo pra cima):
     1. Grid horizontal hairline
     2. Linha 0 dB stronger
     3. Ticks verticais por decada
     4. Spectrum bars (bg-ink 22% alpha) — quando overlay+playing
     5. Spectrum peaks (bg-ink 55% alpha, hairline horizontal)
     6. Fill carbono 5% abaixo da curva
     7. Stroke carbono 72% da curva
     8. Dots por banda

   Spectrum data: subscribe ao evento Tauri `audio-fft` (60 Hz,
   pos-DSP via PipeWire monitor). Estado vive em refs (Float32Array)
   fora do Solid pra evitar overhead reativo no caminho hot.
   ============================================================ */

import { Component, createEffect, onCleanup, onMount } from "solid-js";
import type { EqBand } from "../../store/dsp";
import { tweaks } from "../../store/tweaks";
import { player } from "../../store/player";
import { onAudioFft, spectrumSubscribe, type FftPayload } from "../../tauri";
import {
  ISO_CENTERS,
  NUM_BANDS,
  computeBinRanges,
  decodeDb,
  smoothToward,
  updatePeak,
  DISPLAY_DB_MIN,
  DISPLAY_DB_MAX,
  type PeakState,
} from "./spectrum-bands";

export interface EqCanvasProps {
  bands: EqBand[];
  activeBand: number;
}

const F_MIN = 20;
const F_MAX = 20000;
const LOG_MIN = Math.log10(F_MIN);
const LOG_SPAN = Math.log10(F_MAX) - LOG_MIN;
const DECADES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const PAD_X = 26;
const PAD_X_RIGHT = 8;

// Escala Y do PLOT da curva (display only).
const DB_VIS_RANGE = 18;
const CURVE_STEPS = 256;

const DEFAULT_SAMPLE_RATE = 48000;

function freqToX(hz: number, padX: number, innerW: number): number {
  const u = (Math.log10(hz) - LOG_MIN) / LOG_SPAN;
  return padX + u * innerW;
}

function xToFreq(x: number, padX: number, innerW: number): number {
  const u = (x - padX) / innerW;
  return Math.pow(10, LOG_MIN + u * LOG_SPAN);
}

function peakingDbAt(f: number, b: EqBand): number {
  if (b.gain_db === 0 || b.mute) return 0;
  const q = b.q || 1;
  const bwOct = (2 * Math.asinh(1 / (2 * q))) / Math.LN2;
  const nOct = Math.log2(f / b.freq);
  return b.gain_db / (1 + Math.pow((2 * nOct) / bwOct, 2));
}

function totalResponseDb(f: number, bands: EqBand[]): number {
  let s = 0;
  for (let i = 0; i < bands.length; i++) s += peakingDbAt(f, bands[i]);
  return s;
}

export const EqCanvas: Component<EqCanvasProps> = (props) => {
  let canvasEl!: HTMLCanvasElement;
  let observer: ResizeObserver | undefined;

  // ── Estado do RTA (fora de Solid signal: caminho hot, 60Hz) ──
  const bandMags = new Float32Array(NUM_BANDS).fill(-80);
  const bandPeaks: PeakState[] = Array.from({ length: NUM_BANDS }, () => ({
    peak: -80,
    age: 0,
  }));
  let bandBinRanges = computeBinRanges(DEFAULT_SAMPLE_RATE);
  let cachedSampleRate = DEFAULT_SAMPLE_RATE;
  let lastFftAt = 0;
  let lastDrawAt = 0;
  let rafId = 0;
  let unlistenFft: (() => void) | null = null;

  function onFft(payload: FftPayload) {
    // Refresh bin ranges se SR mudou
    if (
      payload.sample_rate > 0 &&
      payload.sample_rate !== cachedSampleRate
    ) {
      cachedSampleRate = payload.sample_rate;
      bandBinRanges = computeBinRanges(cachedSampleRate);
    }
    const now = performance.now();
    let dt = lastFftAt === 0 ? 0.016 : (now - lastFftAt) / 1000;
    if (dt < 0.001) dt = 0.001;
    if (dt > 0.1) dt = 0.1;
    lastFftAt = now;

    const mags = payload.magnitudes;
    if (!mags || mags.length === 0) return;

    for (let b = 0; b < NUM_BANDS; b++) {
      const [start, end] = bandBinRanges[b];
      let maxDb = -80;
      for (let i = start; i < end && i < mags.length; i++) {
        const db = decodeDb(mags[i]);
        if (db > maxDb) maxDb = db;
      }
      bandMags[b] = smoothToward(bandMags[b], maxDb, dt);
      updatePeak(bandPeaks[b], bandMags[b], dt);
    }
  }

  function frame(now: number) {
    const dtDraw =
      lastDrawAt === 0 ? 0.016 : Math.min(0.1, (now - lastDrawAt) / 1000);
    lastDrawAt = now;

    // Decay continuo entre frames de FFT pra suavizar o peak visual
    for (let b = 0; b < NUM_BANDS; b++) {
      updatePeak(bandPeaks[b], bandMags[b], dtDraw);
    }

    draw();

    if (tweaks().eqSpectrumOverlay && player.isPlaying) {
      rafId = requestAnimationFrame(frame);
    } else {
      rafId = 0;
    }
  }

  function startLoop() {
    if (rafId !== 0) return;
    lastDrawAt = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function ensureFftListener() {
    if (unlistenFft) return;
    spectrumSubscribe().catch(() => {});
    onAudioFft(onFft).then((un) => {
      unlistenFft = un;
    });
  }

  function dropFftListener() {
    if (unlistenFft) {
      unlistenFft();
      unlistenFft = null;
    }
  }

  function draw() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const r = canvasEl.getBoundingClientRect();
    if (!r.width || !r.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasEl.width = Math.round(r.width * dpr);
    canvasEl.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = r.width;
    const h = r.height;
    const mid = h / 2;
    const innerW = w - PAD_X - PAD_X_RIGHT;

    ctx.clearRect(0, 0, w, h);

    // ── Grid hairline horizontal ──
    ctx.strokeStyle = "rgba(0,0,0,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = (h / 5) * i + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD_X, y);
      ctx.lineTo(PAD_X + innerW, y);
      ctx.stroke();
    }
    // Linha 0 dB stronger
    ctx.strokeStyle = "rgba(0,0,0,0.10)";
    ctx.beginPath();
    ctx.moveTo(PAD_X, mid + 0.5);
    ctx.lineTo(PAD_X + innerW, mid + 0.5);
    ctx.stroke();

    // ── Ticks verticais por decada ──
    ctx.strokeStyle = "rgba(0,0,0,0.04)";
    for (const hz of DECADES) {
      const x = freqToX(hz, PAD_X, innerW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x, h - 6);
      ctx.stroke();
    }

    // ── Spectrum bars (RTA) ──
    if (tweaks().eqSpectrumOverlay) {
      const inkRgb = (
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-ink-rgb")
          .trim() || "23, 23, 23"
      );
      const bottom = h - 4;
      const top = 4;
      const usableH = bottom - top;
      const dbSpan = DISPLAY_DB_MAX - DISPLAY_DB_MIN;

      const barDbToY = (db: number): number => {
        const c = Math.max(DISPLAY_DB_MIN, Math.min(DISPLAY_DB_MAX, db));
        const norm = (c - DISPLAY_DB_MIN) / dbSpan;
        return bottom - norm * usableH;
      };

      // Slot widths a partir do espaco entre centros adjacentes
      // (precomputado a cada draw porque innerW pode mudar).
      const xCenters = new Float32Array(NUM_BANDS);
      for (let i = 0; i < NUM_BANDS; i++) {
        xCenters[i] = freqToX(ISO_CENTERS[i], PAD_X, innerW);
      }
      const slotW = new Float32Array(NUM_BANDS);
      for (let i = 0; i < NUM_BANDS; i++) {
        const left = i === 0 ? xCenters[0] - (xCenters[1] - xCenters[0]) / 2 : (xCenters[i - 1] + xCenters[i]) / 2;
        const right = i === NUM_BANDS - 1
          ? xCenters[i] + (xCenters[i] - xCenters[i - 1]) / 2
          : (xCenters[i] + xCenters[i + 1]) / 2;
        slotW[i] = right - left;
      }

      // Barras
      ctx.fillStyle = `rgba(${inkRgb}, 0.22)`;
      for (let i = 0; i < NUM_BANDS; i++) {
        const barW = Math.max(2, slotW[i] * 0.7);
        const x = xCenters[i] - barW / 2;
        const yTop = barDbToY(bandMags[i]);
        if (yTop < bottom - 0.5) {
          ctx.fillRect(x, yTop, barW, bottom - yTop);
        }
      }

      // Peaks
      ctx.fillStyle = `rgba(${inkRgb}, 0.55)`;
      for (let i = 0; i < NUM_BANDS; i++) {
        const barW = Math.max(2, slotW[i] * 0.7);
        const x = xCenters[i] - barW / 2;
        const yPeak = barDbToY(bandPeaks[i].peak);
        if (yPeak < bottom - 0.5) {
          ctx.fillRect(x, yPeak - 0.5, barW, 1.5);
        }
      }
    }

    // ── Curva REAL: somatorio peaking ──
    const bands = props.bands;
    if (!bands?.length) return;

    const dbToY = (db: number) => mid - (db / DB_VIS_RANGE) * (h / 2) * 0.9;

    const samples: [number, number][] = [];
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const x = PAD_X + (innerW * i) / CURVE_STEPS;
      const f = xToFreq(x, PAD_X, innerW);
      const db = totalResponseDb(f, bands);
      const dbClamped = Math.max(-DB_VIS_RANGE, Math.min(DB_VIS_RANGE, db));
      samples.push([x, dbToY(dbClamped)]);
    }

    function curvePath(closeToMid: boolean): Path2D {
      const p = new Path2D();
      p.moveTo(samples[0][0], samples[0][1]);
      for (let i = 1; i < samples.length; i++) p.lineTo(samples[i][0], samples[i][1]);
      if (closeToMid) {
        p.lineTo(samples[samples.length - 1][0], mid);
        p.lineTo(samples[0][0], mid);
        p.closePath();
      }
      return p;
    }

    ctx.fillStyle = "rgba(23,23,23,0.05)";
    ctx.fill(curvePath(true));

    ctx.strokeStyle = "rgba(23,23,23,0.72)";
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(curvePath(false));

    // Dots por banda
    const active = props.activeBand;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const x = freqToX(b.freq, PAD_X, innerW);
      const dbOnCurve = totalResponseDb(b.freq, bands);
      const dbClamped = Math.max(-DB_VIS_RANGE, Math.min(DB_VIS_RANGE, dbOnCurve));
      const y = dbToY(dbClamped);
      const isActive = i === active;
      const used = b.gain_db !== 0;
      ctx.beginPath();
      ctx.arc(x, y, isActive ? 4 : used ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = isActive
        ? "rgba(37,99,235,1)"
        : used
          ? "rgba(23,23,23,0.78)"
          : "rgba(115,115,115,0.45)";
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
  }

  onMount(() => {
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => draw());
      observer.observe(canvasEl);
    }
  });

  onCleanup(() => {
    observer?.disconnect();
    stopLoop();
    dropFftListener();
  });

  // Lifecycle: liga listener + loop quando overlay e isPlaying
  createEffect(() => {
    const overlayOn = tweaks().eqSpectrumOverlay;
    const isPlaying = player.isPlaying;
    if (overlayOn && isPlaying) {
      ensureFftListener();
      startLoop();
    } else {
      stopLoop();
      if (!overlayOn) dropFftListener();
      // redesenha 1 frame estatica sem barras (ou com barras decaindo)
      draw();
    }
  });

  // Redraw on band/active change (igual a comportamento existente).
  createEffect(() => {
    void props.activeBand;
    for (const b of props.bands) {
      void b.freq; void b.gain_db; void b.q; void b.mute;
    }
    draw();
  });

  return (
    <div class="eq-canvas-wrap">
      <canvas ref={canvasEl} aria-hidden="true" />
      <div class="eq-yaxis" aria-hidden="true">
        <span>+18</span>
        <span>+9</span>
        <span>0</span>
        <span>-9</span>
        <span>-18</span>
      </div>
    </div>
  );
};
```

- [ ] **Step 4: Run testes do EqCanvas pra confirmar nada quebrou**

Run: `cd /home/opc/rustify-player && bunx vitest run src/components/dsp/EqCanvas.test.tsx`
Expected: 4 PASS (3 existentes + o novo de overlay-off).

- [ ] **Step 5: Run testes do spectrum-bands tambem (regressao)**

Run: `cd /home/opc/rustify-player && bunx vitest run src/components/dsp/spectrum-bands.test.ts`
Expected: 16+ PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/dsp/EqCanvas.tsx src/components/dsp/EqCanvas.test.tsx
git commit -m "feat(eq-canvas): overlay de spectrum real pos-DSP (RTA 1/3 oitava)

31 barras ISO + peak-hold sob a curva parametrica. Consome o
evento audio-fft existente, herda --bg-ink-rgb (Tweaks).
Liga/desliga via toggle eqSpectrumOverlay + player.isPlaying.
Estado em refs Float32Array fora do Solid (caminho hot 60Hz)."
```

---

## Task 8: Verification + release

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Full cargo check do backend**

Run: `cargo check --manifest-path /home/opc/rustify-player/src-tauri/Cargo.toml`
Expected: `Finished` sem erros.

- [ ] **Step 2: Run TODOS os testes Vitest**

Run: `cd /home/opc/rustify-player && bunx vitest run`
Expected: todos os testes do projeto verdes.

- [ ] **Step 3: Build frontend**

Run: `cd /home/opc/rustify-player && bunx --bun vite build 2>&1 | tail -3`
Expected: ultima linha "built in Xs".

- [ ] **Step 4: Bump versao no tauri.conf.json**

Em `src-tauri/tauri.conf.json`, mudar `"version": "0.2.22"` para `"version": "0.2.23"`.

- [ ] **Step 5: Release via script**

Run: `cd /home/opc/rustify-player && ./scripts/release.sh`
Expected: `.deb` publicado no GitHub release tag `dev`. Comando termina com URL do release.

- [ ] **Step 6: Verificar release publicado**

Run: `gh release view dev -R PedroGiudice/rustify-player --json tagName,assets | jq -r '.tagName, (.assets[].name)'`
Expected: tag `dev` + asset `rustify-player_0.2.23_amd64.deb`.

- [ ] **Step 7: Commit do bump**

Nao precisa commit manual — `release.sh` ja faz `chore(release): v0.2.23` automaticamente.

- [ ] **Step 8: Avisar usuario pra instalar na cmr-auto**

Mensagem ao usuario:

```
v0.2.23 publicada. Pra puxar na cmr-auto:

  gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
  sudo dpkg -i /tmp/rustify-player_0.2.23_amd64.deb

Testar: tocar uma musica, abrir o painel DSP/Signal,
ver as 31 barras 1/3 oitava sob a curva. Mexer no EQ
e ver o spectrum responder. Toggle no Tweaks (EQ
spectrum On/Off) deve esconder o overlay.
```

---

## Self-Review (executado pelo autor do plano)

**1. Spec coverage:**

| Spec §  | Task | Status |
|---|---|---|
| §2 Dado fonte (FftPayload + sample_rate) | T1, T2, T3 | coberto |
| §3.1 Centros ISO 31 bandas | T4 (ISO_CENTERS) | coberto |
| §3.2 IIR attack 30ms / release 150ms | T4 (smoothToward) | coberto |
| §3.3 Peak-hold 1.5s + decay 18 dB/s | T4 (updatePeak) | coberto |
| §5.1 store/tweaks campo eqSpectrumOverlay | T5 | coberto |
| §5.2 Tweaks.tsx Segmented | T6 | coberto |
| §5.3 EqCanvas com loop + listener + draw | T7 | coberto |
| §5.4 lib.rs FftPayload + sample_rate | T2 | coberto |
| §5.5 audio-engine expose sample_rate | T1 | coberto |
| §5.6 tauri.ts FftPayload | T3 | coberto |
| §6 performance budget | implicito (testes de regressao) | coberto |
| §7 testes TDD | T4 (unit) + T7 (component) | coberto |
| §8 fallback / error handling | T7 (silent catches, decay natural) | coberto |
| §9 edge cases | T7 (SR change handler, resize, isPlaying lifecycle) | coberto |
| §11 criterios de aceite | T8 (verificacao manual pos-release) | coberto |
| §12 bump versao | T8 step 4 | coberto |

**2. Placeholder scan:** Nenhum "TBD"/"TODO"/"similar a..."/"add error handling" sem detalhe. Todas as funcoes e tipos sao definidos antes de serem referenciados.

**3. Type consistency:**
- `SharedSampleRate` (T1 step 2) usado em T1 step 4 e T2 step 2 com mesmo nome.
- `FftPayload.sample_rate: u32` (Rust) consistente com `sample_rate: number` (TS).
- `PeakState` definido em T4 e consumido em T7 com mesmo shape `{ peak, age }`.
- `ISO_CENTERS`, `NUM_BANDS`, `computeBinRanges`, `decodeDb`, `smoothToward`, `updatePeak` definidos em T4 e importados em T7 com nomes identicos.
- `DISPLAY_DB_MIN`/`DISPLAY_DB_MAX` definidos em T4 e usados em T7.
- `tweaks().eqSpectrumOverlay` consistente em T5, T6, T7.

Plano consistente. Pronto para execucao.
