/* ============================================================
   eq-response.ts — Resposta de magnitude do EQ por tipo de filtro.

   Fórmulas do RBJ Audio EQ Cookbook, que é exatamente o que o LSP Para
   EQ roda no modo APO (DR) (o default das bandas): mesmo a0..a2/b0..b2,
   ganho linear na faixa passante dos filtros de passagem, sqrt(ganho) no
   Bell e nos shelves. Os modos RLC/BWC/LRX usam outras topologias; aqui
   eles entram como cascata do mesmo biquad conforme o slope (só nos
   passa-altas/baixas), o que acerta a inclinação, não o joelho exato.
   Resonance e Ladder-* não têm equivalente no cookbook e são desenhados
   como Bell.

   Puro (sem DOM): o EqCanvas amostra a curva aqui e só desenha.
   ============================================================ */

import type { EqBand } from "../../store/dsp";

// Índices de FILTER_TYPES (store/dsp.ts).
const T_OFF = 0;
const T_BELL = 1;
const T_HIPASS = 2;
const T_HISHELF = 3;
const T_LOPASS = 4;
const T_LOSHELF = 5;
const T_NOTCH = 6;
const T_ALLPASS = 8;
const T_BANDPASS = 9;

// Índices de FILTER_MODES.
const MODE_LRX_BT = 4;
const MODE_LRX_MT = 5;
const MODE_APO = 6;

/** Escalas do gráfico (±dB). A primeira é a histórica; as outras só
    entram quando a curva passa dela. */
export const DB_RANGES = [18, 24, 36, 48, 72] as const;

/** Tipos cujo ganho é só o nível da faixa passante: a queda fora dela vai
    a -inf e não deve inflar a escala. */
function isRolloff(type: number): boolean {
  return type === T_HIPASS || type === T_LOPASS || type === T_BANDPASS || type === T_NOTCH;
}

/** Banda desligada, mutada ou fora do solo não soma nada. */
function isAudible(b: EqBand, anySolo: boolean): boolean {
  if (b.type === T_OFF || b.mute) return false;
  return !anySolo || b.solo;
}

/** |H(e^jw)| em dB de um biquad (b0,b1,b2)/(a0,a1,a2). */
function biquadDb(
  b0: number, b1: number, b2: number,
  a0: number, a1: number, a2: number,
  cw: number, c2w: number,
): number {
  const num = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * cw + 2 * b0 * b2 * c2w;
  const den = a0 * a0 + a1 * a1 + a2 * a2 + 2 * (a0 * a1 + a1 * a2) * cw + 2 * a0 * a2 * c2w;
  if (!(num > 0) || !(den > 0)) return num > 0 ? 0 : -200;
  return 10 * Math.log10(num / den);
}

/** Resposta em dB de UMA banda, ignorando solo (quem trata solo é o total). */
export function bandResponseDb(f: number, b: EqBand, fs: number): number {
  if (b.type === T_OFF || b.mute) return 0;
  const nyq = fs / 2;
  const f0 = Math.min(Math.max(b.freq, 1), nyq * 0.999);
  const w0 = (2 * Math.PI * f0) / fs;
  const cs = Math.cos(w0);
  const q = b.q > 0 ? b.q : 0.707;
  const alpha = Math.sin(w0) / (2 * q);
  const w = (2 * Math.PI * Math.min(f, nyq * 0.999)) / fs;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const g = b.gain_db || 0;

  switch (b.type) {
    case T_HIPASS:
    case T_LOPASS: {
      const hp = b.type === T_HIPASS;
      const k = hp ? 1 + cs : 1 - cs;
      const one = biquadDb(k / 2, hp ? -k : k, k / 2, 1 + alpha, -2 * cs, 1 - alpha, cw, c2w);
      // APO ignora o slope; RLC/BWC somam um biquad por passo, LRX dobra.
      let stages = 1;
      if (b.filterMode !== MODE_APO) {
        stages = (b.slope ?? 0) + 1;
        if (b.filterMode === MODE_LRX_BT || b.filterMode === MODE_LRX_MT) stages *= 2;
      }
      return one * stages + g;
    }
    case T_BANDPASS:
      return biquadDb(alpha, 0, -alpha, 1 + alpha, -2 * cs, 1 - alpha, cw, c2w) + g;
    case T_NOTCH:
      return biquadDb(1, -2 * cs, 1, 1 + alpha, -2 * cs, 1 - alpha, cw, c2w) + g;
    case T_ALLPASS:
      return g;
    case T_HISHELF:
    case T_LOSHELF: {
      if (g === 0) return 0;
      const A = Math.pow(10, g / 40);
      const beta = 2 * Math.sqrt(A) * alpha;
      const s = b.type === T_HISHELF ? 1 : -1;
      return biquadDb(
        A * ((A + 1) + s * (A - 1) * cs + beta),
        -2 * s * A * ((A - 1) + s * (A + 1) * cs),
        A * ((A + 1) + s * (A - 1) * cs - beta),
        (A + 1) - s * (A - 1) * cs + beta,
        2 * s * ((A - 1) - s * (A + 1) * cs),
        (A + 1) - s * (A - 1) * cs - beta,
        cw, c2w,
      );
    }
    case T_BELL:
    default: {
      if (g === 0) return 0;
      const A = Math.pow(10, g / 40);
      return biquadDb(1 + alpha * A, -2 * cs, 1 - alpha * A, 1 + alpha / A, -2 * cs, 1 - alpha / A, cw, c2w);
    }
  }
}

/** Soma das bandas audíveis (solo: só as bandas em solo). */
export function totalResponseDb(f: number, bands: readonly EqBand[], fs: number): number {
  const anySolo = bands.some((b) => b.solo);
  let s = 0;
  for (let i = 0; i < bands.length; i++) {
    if (isAudible(bands[i], anySolo)) s += bandResponseDb(f, bands[i], fs);
  }
  return s;
}

/** Amostra a curva em `freqs` (escreve em `out`) e devolve o pico, em dB,
    que a escala precisa mostrar: o maior valor absoluto da curva, sem
    contar a queda dos filtros de passagem (só o nível da faixa passante). */
export function sampleCurve(
  bands: readonly EqBand[],
  freqs: ArrayLike<number>,
  fs: number,
  out: Float32Array,
): number {
  const anySolo = bands.some((b) => b.solo);
  let peak = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    let total = 0;
    let scaled = 0;
    for (let j = 0; j < bands.length; j++) {
      const b = bands[j];
      if (!isAudible(b, anySolo)) continue;
      const r = bandResponseDb(f, b, fs);
      total += r;
      scaled += isRolloff(b.type) ? (b.gain_db || 0) : r;
    }
    out[i] = total;
    if (total > peak) peak = total;
    if (Math.abs(scaled) > peak) peak = Math.abs(scaled);
  }
  return peak;
}

/** Menor escala da lista que cabe o pico (com folga de 0,05 dB). */
export function pickDbRange(peakDb: number): number {
  for (const r of DB_RANGES) if (peakDb <= r + 0.05) return r;
  return DB_RANGES[DB_RANGES.length - 1];
}
