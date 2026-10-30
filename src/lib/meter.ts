// src/lib/meter.ts — balística dos medidores de nível (barra do player e
// indicador "tocando agora"). Puro; quem desenha chama stepMeter por quadro.
//
// VU: integração simétrica com 99% em 300 ms (padrão de VU), sobre a RMS
// linear. Pico: sobe na hora, segura PEAK_HOLD_S e cai a PEAK_FALL_DB_S.
// Escala em dBFS de METER_FLOOR_DB a 0. O sinal vem do monitor do sink, ou
// seja, DEPOIS do volume: é o que sai para as caixas.

export const METER_FLOOR_DB = -48;
/** 99% em 300 ms: tau = 0,3 / ln(100). */
export const VU_TAU = 0.3 / Math.log(100);
export const PEAK_HOLD_S = 1.5;
export const PEAK_FALL_DB_S = 20;

export interface MeterState {
  /** RMS integrada por canal (linear 0..1). */
  vu: [number, number];
  /** Pico retido por canal, em dBFS (<= 0; METER_FLOOR_DB = vazio). */
  peakDb: [number, number];
  /** Segundos de retenção que ainda faltam por canal. */
  hold: [number, number];
}

export function createMeter(): MeterState {
  return { vu: [0, 0], peakDb: [METER_FLOOR_DB, METER_FLOOR_DB], hold: [0, 0] };
}

export const toDb = (lin: number): number =>
  lin > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(lin)) : METER_FLOOR_DB;

/** Linear -> 0..1 na escala em dB do medidor (NaN e negativos = 0). */
export function toFrac(lin: number): number {
  if (!(lin > 0)) return 0;
  const f = (toDb(lin) - METER_FLOOR_DB) / -METER_FLOOR_DB;
  return f > 1 ? 1 : f;
}

export function stepMeter(st: MeterState, rms: [number, number], peak: [number, number], dt: number): MeterState {
  if (!(dt > 0)) return st;
  const k = 1 - Math.exp(-dt / VU_TAU);
  for (const c of [0, 1] as const) {
    const r = rms[c] > 0 ? rms[c] : 0;
    st.vu[c] += (r - st.vu[c]) * k;
    if (st.vu[c] < 1e-6) st.vu[c] = r > 0 ? st.vu[c] : 0;
    const p = toDb(peak[c]);
    if (p >= st.peakDb[c]) {
      st.peakDb[c] = p;
      st.hold[c] = PEAK_HOLD_S;
    } else if (st.hold[c] > 0) {
      st.hold[c] = Math.max(0, st.hold[c] - dt);
    } else {
      st.peakDb[c] = Math.max(METER_FLOOR_DB, Math.max(p, st.peakDb[c] - PEAK_FALL_DB_S * dt));
    }
  }
  return st;
}
