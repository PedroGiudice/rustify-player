/* ============================================================
   beatBoost.test.ts — expansão da faixa dinâmica do kick.

   Medição no app real (2026-07-12, 216 amostras / 4s): o
   low_band_mag tem p50 ~0.32, p90 ~0.62, max ~0.68 — nunca
   chega a 1.0. A expansão mapeia [FLOOR, CEIL] -> [0,1] pra o
   beat-boost usar a faixa inteira em vez de ~40% dela.
   ============================================================ */

import { describe, it, expect } from "vitest";
import { expandKick, BEAT_GAIN } from "./beatBoost";

describe("expandKick", () => {
  it("silêncio/kick abaixo do piso -> 0", () => {
    expect(expandKick(0)).toBe(0);
    expect(expandKick(0.1)).toBe(0);
    expect(expandKick(0.05)).toBe(0);
  });

  it("kick no teto ou acima satura em 1", () => {
    expect(expandKick(0.6)).toBe(1);
    expect(expandKick(0.68)).toBe(1); // o max medido no app
    expect(expandKick(1.0)).toBe(1);
  });

  it("kick mediano (0.32 medido) mapeia pra ~0.44 — usa a faixa real", () => {
    expect(expandKick(0.35)).toBeCloseTo(0.5, 5);
    // Sem a expansão, 0.32 valia 0.32; agora vale ~0.44.
    expect(expandKick(0.32)).toBeGreaterThan(0.32);
  });

  it("é monotônica e clampada em [0,1]", () => {
    let prev = -1;
    for (let low = 0; low <= 1.0001; low += 0.05) {
      const v = expandKick(low);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("BEAT_GAIN é maior que o valor antigo (0.9) — boost mais pronunciado", () => {
    expect(BEAT_GAIN).toBeGreaterThan(0.9);
  });
});
