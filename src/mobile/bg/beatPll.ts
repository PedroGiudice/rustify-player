/* ============================================================
   beatPll.ts — porte 1:1 de docs/design-refs/design_handoff_mobile/
   beat-pll.js (modo speed + modo pulse). Invólucro virou módulo ES;
   a matemática é a do handoff, sem reinterpretação.

   No Android v0 NÃO existe FFT real (não há audio-engine; o playback
   é o ExoPlayer no Kotlin). O `mag` que alimenta o PLL vem do gerador
   sintético de spectrum.ts, 4/4 a 92 BPM — o mesmo comportamento do
   protótipo. Nenhuma ponte de áudio foi inventada.
   ============================================================ */

const KICK_FLOOR = 0.1;
const KICK_CEIL = 0.6;

export function expandKick(low: number): number {
  const t = (low - KICK_FLOOR) / (KICK_CEIL - KICK_FLOOR);
  return Math.max(0, Math.min(1, t));
}

export const BEAT_TAU = 0.09;

export function speedBoostGain(depth: number): number {
  return depth * (1.0 / 0.55);
}

const ONSET_RATIO = 1.4;
const ONSET_FLOOR = 0.2;
const ONSET_COOLDOWN = 0.2;
const ONSET_AVG_TAU = 0.35;
const PLL_PHASE_GAIN = 0.5;
const PLL_TEMPO_GAIN = 0.06;
const PLL_PERIOD_MIN = 0.3;
const PLL_PERIOD_MAX = 1.2;
const PLL_LOCK_RISE = 0.3;
const PLL_LOCK_TAU = 2.5;

export const BEAT_DEPTH_DEFAULT = 0.55;
export const INK_PULSE = 0.5;
const PULSE_GAIN = 1.35;

export interface BeatPllState {
  avgMag: number;
  lastOnsetT: number;
  period: number;
  phase: number;
  locked: number;
}

export function createBeatPll(): BeatPllState {
  return { avgMag: 0, lastOnsetT: -1, period: 0.5, phase: 0, locked: 0 };
}

export function pllStep(s: BeatPllState, mag: number, t: number, dt: number, fresh: boolean): boolean {
  let onset = false;
  if (fresh) {
    const m = expandKick(mag);
    s.avgMag += (m - s.avgMag) * (1 - Math.exp(-dt / ONSET_AVG_TAU));
    const ratio = m / (s.avgMag + 1e-4);
    onset = ratio > ONSET_RATIO && m > ONSET_FLOOR && t - s.lastOnsetT > ONSET_COOLDOWN;
    if (onset) s.lastOnsetT = t;
  }
  s.phase += dt / s.period;
  if (s.phase >= 1) s.phase -= 1;
  if (onset) {
    let e = s.phase;
    if (e > 0.5) e -= 1;
    s.phase -= e * PLL_PHASE_GAIN;
    if (s.phase < 0) s.phase += 1;
    s.period *= 1 + e * PLL_TEMPO_GAIN;
    s.period = Math.min(PLL_PERIOD_MAX, Math.max(PLL_PERIOD_MIN, s.period));
    s.locked += (Math.max(0, Math.min(1, 1 - Math.abs(e) * 3)) - s.locked) * PLL_LOCK_RISE;
  } else {
    s.locked *= Math.exp(-dt / PLL_LOCK_TAU);
  }
  return onset;
}

function pulseShape(ph: number): number {
  return ph < 0.04 ? ph / 0.04 : Math.exp(-(ph - 0.04) * 6.5);
}

export function beatPulse(s: BeatPllState, depth: number): number {
  if (depth <= 0) return 0;
  return depth * PULSE_GAIN * pulseShape(s.phase) * (0.55 + 0.45 * s.locked);
}
