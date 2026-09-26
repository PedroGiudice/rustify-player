/* ============================================================
   gl-bench/sim.ts — o sinal simulado do lab v2 (fundo-lab-v2.html).

   Faixa a 92 BPM: bumbo em cada tempo alimenta os graves, caixa em
   2 e 4 os médios, chimbal em colcheias os agudos, e a energia sobe
   e desce a cada 32 s, com o tremor que o FFT real tem por cima.
   Daqui saem só as bandas CRUAS; a cadeia de envelope/beat/relógio
   é a do app (gl/signal.ts), para o bench medir o que o app roda.
   Gerador determinístico (xorshift): duas rodadas veem o mesmo sinal.
   ============================================================ */

import type { FftBands } from "../../src/gl/signal";

const BPM = 92;
const BEAT = 60 / BPM;

export interface SimSignal {
  t: number;
  low: number;
  mid: number;
  high: number;
  lastBeat: number;
  lastEighth: number;
  seed: number;
  raw: FftBands;
}

export function createSim(seed = 0x9e3779b9): SimSignal {
  return { t: 0, low: 0, mid: 0, high: 0, lastBeat: -1, lastEighth: -1, seed: seed | 0, raw: { low: 0, mid: 0, high: 0 } };
}

function rnd(s: SimSignal): number {
  let x = s.seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.seed = x;
  return (x >>> 0) / 4294967296;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Avança a faixa simulada e devolve as bandas cruas (0..1). */
export function stepSim(S: SimSignal, dt: number): FftBands {
  S.t += dt;
  const e = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(S.t * ((2 * Math.PI) / 32) - Math.PI / 2));
  const bi = Math.floor(S.t / BEAT);
  const ei = Math.floor(S.t / (BEAT / 2));
  const dec = (v: number, tau: number) => v * Math.exp(-dt / tau);
  S.low = dec(S.low, 0.2);
  S.mid = dec(S.mid, 0.14);
  S.high = dec(S.high, 0.06);
  if (bi !== S.lastBeat) {
    S.lastBeat = bi;
    S.low = Math.max(S.low, 0.55 + 0.45 * e);
    if (bi % 2 === 1) S.mid = Math.max(S.mid, 0.5 + 0.4 * e);
  }
  if (ei !== S.lastEighth) {
    S.lastEighth = ei;
    S.high = Math.max(S.high, 0.35 + 0.45 * e * (ei % 2 ? 0.7 : 1));
  }
  S.low = Math.max(S.low, 0.18 + 0.14 * e * (0.5 + 0.5 * Math.sin(S.t * 2.3)));
  S.mid = Math.max(S.mid, 0.12 + 0.1 * e);
  S.high = Math.max(S.high, 0.06 * e);
  const n = () => rnd(S) - 0.5;
  S.raw.low = clamp01(S.low * (1 + 0.3 * n()));
  S.raw.mid = clamp01(S.mid * (1 + 0.5 * n()) + 0.05 * n());
  S.raw.high = clamp01(S.high * (1 + 0.55 * n()));
  return S.raw;
}
