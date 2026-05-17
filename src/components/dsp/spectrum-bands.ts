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
