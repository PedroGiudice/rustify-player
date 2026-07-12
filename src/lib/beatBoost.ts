/* ============================================================
   beatBoost.ts — expansão da faixa dinâmica do kick (beat-sync).

   O SpectrumCanvas modula a DERIVADA do relógio virtual pelo kick
   (low_band_mag). Medição no app real (2026-07-12, 216 amostras
   em 4s tocando): low_band_mag tem p50 ~0.32, p90 ~0.62,
   max ~0.68 — NUNCA chega a 1.0. A fórmula antiga (1 + 0.9·low)
   usava só ~40% da faixa e o boost ficava imperceptível.

   expandKick remapeia [FLOOR, CEIL] -> [0,1] pra o boost usar a
   faixa inteira; um kick de verdade passa a empurrar de fato.
   ============================================================ */

/** Piso do low_band_mag: abaixo disto é ruído/silêncio (não é beat). */
const BEAT_FLOOR = 0.1;
/** Teto: onde um kick forte satura (p90~0.62, max~0.68 medidos). */
const BEAT_CEIL = 0.6;

/** Boost máximo de velocidade no pico do kick: velocidade vira
    dt·speed·(1 + BEAT_GAIN·beatEnv). Calibrado com a faixa real
    expandida — 0.9 (antigo, sobre o low cru) era sutil demais. */
export const BEAT_GAIN = 1.5;

/** Remapeia o low_band_mag da faixa dinâmica REAL [FLOOR, CEIL]
    para [0,1], clampado. Kick fraco/silêncio -> 0; kick forte -> 1. */
export function expandKick(low: number): number {
  const t = (low - BEAT_FLOOR) / (BEAT_CEIL - BEAT_FLOOR);
  return Math.max(0, Math.min(1, t));
}
