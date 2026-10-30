import { describe, it, expect } from "vitest";
import { createMeter, stepMeter, toFrac, METER_FLOOR_DB, PEAK_HOLD_S, PEAK_FALL_DB_S } from "./meter";

const run = (st: ReturnType<typeof createMeter>, rms: number, peak: number, secs: number, dt = 1 / 60) => {
  for (let t = 0; t < secs - 1e-9; t += dt) stepMeter(st, [rms, rms], [peak, peak], dt);
};

describe("balística dos medidores", () => {
  it("VU chega a 99% do nível em 300 ms (padrão de VU), não antes de 100 ms", () => {
    const a = createMeter();
    run(a, 0.5, 0.5, 0.1);
    expect(a.vu[0]).toBeLessThan(0.5 * 0.9);
    const b = createMeter();
    run(b, 0.5, 0.5, 0.3);
    expect(b.vu[0]).toBeGreaterThanOrEqual(0.5 * 0.99 - 1e-9);
  });
  it("pico sobe na hora, segura 1,5 s e cai a 20 dB/s", () => {
    const st = createMeter();
    stepMeter(st, [0.1, 0.1], [1, 1], 1 / 60);
    expect(st.peakDb[0]).toBeCloseTo(0, 6);
    run(st, 0, 0, PEAK_HOLD_S - 0.05);
    expect(st.peakDb[0]).toBeCloseTo(0, 6);
    run(st, 0, 0, 0.05 + 1);
    expect(st.peakDb[0]).toBeCloseTo(-PEAK_FALL_DB_S, 0);
  });
  it("escala em dBFS: piso = 0, 0 dBFS = 1, metade do caminho no meio da faixa", () => {
    expect(toFrac(0)).toBe(0);
    expect(toFrac(1)).toBe(1);
    expect(toFrac(10 ** (METER_FLOOR_DB / 2 / 20))).toBeCloseTo(0.5, 6);
    expect(toFrac(Number.NaN)).toBe(0);
  });
  it("canais independentes", () => {
    const st = createMeter();
    for (let i = 0; i < 60; i++) stepMeter(st, [0.5, 0], [0.5, 0], 1 / 60);
    expect(st.vu[0]).toBeGreaterThan(0.45);
    expect(st.vu[1]).toBe(0);
  });
});
