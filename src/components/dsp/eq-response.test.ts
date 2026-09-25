/* ============================================================
   eq-response.test.ts — Resposta de magnitude por tipo de filtro
   (RBJ Audio EQ Cookbook, que é o que o LSP roda no modo APO (DR))
   e escolha da escala do gráfico.
   ============================================================ */

import { describe, it, expect } from "vitest";
import type { EqBand } from "../../store/dsp";
import { bandResponseDb, totalResponseDb, pickDbRange, sampleCurve } from "./eq-response";

const FS = 48000;
const APO = 6;
const RLC_BT = 0;

function band(p: Partial<EqBand>): EqBand {
  return {
    freq: 1000, gain_db: 0, q: 0.707, type: 1, filterMode: APO, slope: 0,
    solo: false, mute: false, ...p,
  };
}

describe("bandResponseDb", () => {
  it("Bell: ganho exato na frequência central e ~0 longe dela", () => {
    const b = band({ type: 1, freq: 1000, gain_db: 6, q: 2.21 });
    expect(bandResponseDb(1000, b, FS)).toBeCloseTo(6, 3);
    expect(Math.abs(bandResponseDb(30, b, FS))).toBeLessThan(0.05);
  });

  it("Off e banda mutada não contribuem", () => {
    expect(bandResponseDb(1000, band({ type: 0, gain_db: 12 }), FS)).toBe(0);
    expect(bandResponseDb(1000, band({ type: 1, gain_db: 12, mute: true }), FS)).toBe(0);
  });

  it("Hi-pass corta abaixo do corte e passa acima", () => {
    const b = band({ type: 2, freq: 100 });
    expect(bandResponseDb(20, b, FS)).toBeLessThan(-20);
    expect(Math.abs(bandResponseDb(10000, b, FS))).toBeLessThan(0.1);
  });

  it("Lo-pass corta acima do corte e passa abaixo", () => {
    const b = band({ type: 4, freq: 1000 });
    expect(bandResponseDb(10000, b, FS)).toBeLessThan(-30);
    expect(Math.abs(bandResponseDb(50, b, FS))).toBeLessThan(0.1);
  });

  it("Hi-shelf sobe as altas e deixa as baixas", () => {
    const b = band({ type: 3, freq: 1000, gain_db: 6 });
    expect(bandResponseDb(18000, b, FS)).toBeCloseTo(6, 0);
    expect(Math.abs(bandResponseDb(40, b, FS))).toBeLessThan(0.2);
  });

  it("Lo-shelf mexe nas baixas e deixa as altas", () => {
    const b = band({ type: 5, freq: 200, gain_db: -6 });
    expect(bandResponseDb(20, b, FS)).toBeCloseTo(-6, 0);
    expect(Math.abs(bandResponseDb(10000, b, FS))).toBeLessThan(0.2);
  });

  it("Notch cava fundo na frequência central", () => {
    const b = band({ type: 6, freq: 1000, q: 2 });
    expect(bandResponseDb(1000, b, FS)).toBeLessThan(-40);
    expect(Math.abs(bandResponseDb(100, b, FS))).toBeLessThan(0.5);
  });

  it("Allpass é plano no ganho da banda", () => {
    const b = band({ type: 8, gain_db: -3 });
    expect(bandResponseDb(50, b, FS)).toBeCloseTo(-3, 3);
    expect(bandResponseDb(5000, b, FS)).toBeCloseTo(-3, 3);
  });

  it("filtros de passagem aplicam o ganho da banda na faixa passante (LSP APO)", () => {
    const b = band({ type: 2, freq: 100, gain_db: -4 });
    expect(bandResponseDb(10000, b, FS)).toBeCloseTo(-4, 1);
  });

  it("slope só aumenta a inclinação fora do modo APO", () => {
    const x1 = band({ type: 2, freq: 200, filterMode: RLC_BT, slope: 0 });
    const x3 = band({ type: 2, freq: 200, filterMode: RLC_BT, slope: 2 });
    expect(bandResponseDb(50, x3, FS)).toBeLessThan(bandResponseDb(50, x1, FS) - 20);
    const apo1 = band({ type: 2, freq: 200, slope: 0 });
    const apo3 = band({ type: 2, freq: 200, slope: 2 });
    expect(bandResponseDb(50, apo3, FS)).toBeCloseTo(bandResponseDb(50, apo1, FS), 6);
  });
});

describe("totalResponseDb", () => {
  it("soma as bandas", () => {
    const bands = [band({ freq: 100, gain_db: 3, q: 2 }), band({ freq: 5000, gain_db: -2, q: 2 })];
    expect(totalResponseDb(100, bands, FS)).toBeCloseTo(
      bandResponseDb(100, bands[0], FS) + bandResponseDb(100, bands[1], FS), 6,
    );
  });

  it("com solo, só as bandas em solo contam", () => {
    const bands = [band({ freq: 100, gain_db: 6, q: 2 }), band({ freq: 5000, gain_db: 6, q: 2, solo: true })];
    expect(Math.abs(totalResponseDb(100, bands, FS))).toBeLessThan(0.1);
    expect(totalResponseDb(5000, bands, FS)).toBeCloseTo(6, 3);
  });
});

describe("pickDbRange", () => {
  it("mantém ±18 até 18 dB e sobe em degraus até cobrir o pico", () => {
    expect(pickDbRange(0)).toBe(18);
    expect(pickDbRange(18)).toBe(18);
    expect(pickDbRange(20)).toBe(24);
    expect(pickDbRange(36)).toBe(36);
    expect(pickDbRange(40)).toBe(48);
    expect(pickDbRange(500)).toBe(72);
  });
});

describe("sampleCurve", () => {
  const freqs = [20, 100, 1000, 10000, 20000];

  it("preenche a curva e devolve o pico que a escala precisa mostrar", () => {
    const out = new Float32Array(freqs.length);
    const peak = sampleCurve([band({ freq: 1000, gain_db: 30, q: 1 })], freqs, FS, out);
    expect(out[2]).toBeCloseTo(30, 2);
    expect(peak).toBeCloseTo(30, 1);
    expect(pickDbRange(peak)).toBe(36);
  });

  it("o mergulho de um passa-altas não infla a escala", () => {
    const out = new Float32Array(freqs.length);
    const peak = sampleCurve([band({ type: 2, freq: 200 })], freqs, FS, out);
    expect(out[0]).toBeLessThan(-30);
    expect(pickDbRange(peak)).toBe(18);
  });
});
