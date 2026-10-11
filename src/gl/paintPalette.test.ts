/* ============================================================
   paintPalette.test.ts — as 6 camadas de cor da Tinta (11/10).

   Origem: no app, com a capa "Zero" (Yung Buda), ink e ink2 vieram
   verde-limão quase iguais (rgb 154,244,37 e 154,249,32) e a Tinta
   pintou 93% do fundo numa faixa só de luminância (0,6-0,8), média
   0,73 e matiz único. Aqui se trava o conserto: brilho por camada
   fixo (a capa decide o TOM, não o brilho) e dois tons.
   ============================================================ */

import { describe, it, expect } from "vitest";
import { PAINT_LAYERS, paintLayers, relLuminance, srgbToOklch } from "./paintPalette";

const f3 = (r: number, g: number, b: number) => new Float32Array([r / 255, g / 255, b / 255]);
const LIME = { ink: f3(154, 244, 37), ink2: f3(154, 249, 32) };
const RED_CREAM = { ink: f3(255, 77, 94), ink2: f3(242, 208, 164) };
const BLUE = { ink: f3(40, 90, 220), ink2: f3(230, 120, 40) };
const GRAY = { ink: f3(120, 120, 120), ink2: f3(128, 128, 128) };

const layers = (p: { ink: Float32Array; ink2: Float32Array }) => {
  const out = new Float32Array(PAINT_LAYERS * 3);
  paintLayers(p.ink, p.ink2, out);
  return Array.from({ length: PAINT_LAYERS }, (_, k) => [out[k * 3], out[k * 3 + 1], out[k * 3 + 2]] as const);
};
const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

describe("Tinta: camadas de cor", () => {
  for (const [nome, p] of Object.entries({ LIME, RED_CREAM, BLUE, GRAY })) {
    it(`${nome}: brilho sobe camada a camada, do quase preto a um claro com teto, tudo dentro do sRGB`, () => {
      const ls = layers(p);
      const ys = ls.map(([r, g, b]) => relLuminance(r, g, b));
      for (let k = 1; k < ys.length; k++) expect(ys[k]).toBeGreaterThan(ys[k - 1]);
      expect(ys[0]).toBeLessThan(0.01);
      expect(ys[ys.length - 1]).toBeLessThan(0.6);
      for (const c of ls) for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  }

  it("capa clara não acende o fundo: o brilho por camada é o mesmo do vermelho de teste", () => {
    const lime = layers(LIME).map(([r, g, b]) => relLuminance(r, g, b));
    const red = layers(RED_CREAM).map(([r, g, b]) => relLuminance(r, g, b));
    // O desenho iguala a claridade PERCEBIDA (L do OKLab); a luminância Y
    // ainda varia com o matiz (vermelho saturado mede ~20% menos que verde
    // na mesma claridade). Antes do conserto a razão era 2,7x (0,72/0,27).
    for (let k = 0; k < PAINT_LAYERS; k++) {
      const r = lime[k] / red[k];
      expect(r).toBeLessThan(1.5);
      expect(r).toBeGreaterThan(1 / 1.5);
    }
  });

  it("tinta e acento iguais: as camadas claras giram de tom, o fundo não sai monocromático", () => {
    const ls = layers(LIME);
    const h0 = srgbToOklch(...ls[1]).h;
    const h5 = srgbToOklch(...ls[PAINT_LAYERS - 1]).h;
    expect(hueDist(h0, h5)).toBeGreaterThanOrEqual(25);
  });

  it("acento distinto: as camadas claras seguem o tom do acento, as escuras o da tinta", () => {
    const ls = layers(BLUE);
    expect(hueDist(srgbToOklch(...ls[1]).h, srgbToOklch(BLUE.ink[0], BLUE.ink[1], BLUE.ink[2]).h)).toBeLessThan(12);
    expect(hueDist(srgbToOklch(...ls[PAINT_LAYERS - 1]).h, srgbToOklch(BLUE.ink2[0], BLUE.ink2[1], BLUE.ink2[2]).h)).toBeLessThan(12);
  });

  it("capa sem cor (cinza) dá camadas neutras, sem inventar matiz", () => {
    for (const [r, g, b] of layers(GRAY)) expect(srgbToOklch(r, g, b).c).toBeLessThan(0.02);
  });
});
