/* ============================================================
   spectrum-bands.test.ts — Unit tests for the RTA aggregation
   utilities consumed by the EqCanvas overlay.

   Pure functions only: no Solid, no canvas, no DOM. Vitest only.
   ============================================================ */

import { describe, it, expect } from "vitest";
import {
  ISO_CENTERS,
  NUM_BANDS,
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
    // age vai pra 1.6 (passou hold); decai 18*0.1 = 1.8 dB => -11.8
    expect(state.peak).toBeCloseTo(-11.8, 2);
  });

  it("peak nunca cai abaixo do current mag", () => {
    const state: PeakState = { peak: -20, age: 2.0 };
    updatePeak(state, -19, 0.016, 1.5, 18);
    expect(state.peak).toBe(-19);
    expect(state.age).toBe(0);
  });
});
