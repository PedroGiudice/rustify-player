// src/lib/waveProfile.ts — perfil de volume da faixa (lib_track_profile:
// 400 baldes de RMS, u8 com 0 = -60 dBFS e 255 = 0 dBFS) para as barras do
// seek. Normaliza pela própria faixa (p5 .. máximo): master alto, que vive
// entre -12 e -6 dBFS, ainda mostra onde estão a ponte e o drop.

/** Altura mínima de uma barra (silêncio continua visível como traço). */
export const WAVE_FLOOR = 0.12;

export function waveBars(profile: ArrayLike<number>, bars: number): number[] {
  const n = profile.length;
  if (!n || bars <= 0) return [];
  const sorted = Array.from(profile).sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.05 * (n - 1))];
  const hi = sorted[n - 1];
  const span = hi - lo;
  const out: number[] = new Array(bars);
  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i * n) / bars);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / bars));
    let m = 0;
    for (let k = a; k < b && k < n; k++) if (profile[k] > m) m = profile[k];
    if (span <= 0) { out[i] = 1; continue; }
    const f = (m - lo) / span;
    out[i] = WAVE_FLOOR + (1 - WAVE_FLOOR) * (f < 0 ? 0 : f > 1 ? 1 : f);
  }
  return out;
}
