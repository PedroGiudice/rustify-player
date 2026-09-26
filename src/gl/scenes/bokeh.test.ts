/* ============================================================
   bokeh.test.ts — a parte pura do Palco (sem GL): a disposição das
   48 luzes (treliça no fundo, ordem de sorteio do lab) e a deriva
   integrada na CPU (CMR-267: o sinal muda a VELOCIDADE).
   ============================================================ */

import { describe, it, expect } from "vitest";
import {
  BOKEH_BACK,
  BOKEH_LIGHTS,
  BOKEH_MID,
  BOKEH_STRIDE,
  advanceBokehDrift,
  bokehLights,
} from "./bokeh";

/** Campo `k` (0..7) da luz `i`: aA = 0..3, aB = 4..7. */
const at = (d: Float32Array, i: number, k: number) => d[i * BOKEH_STRIDE + k];

describe("Palco: luzes", () => {
  it("48 luzes, 8 floats cada, em 3 planos: 26 no fundo, 14 no meio, 8 na frente", () => {
    const d = bokehLights();
    expect(BOKEH_LIGHTS).toBe(48);
    expect(d.length).toBe(BOKEH_LIGHTS * BOKEH_STRIDE);
    const count = [0, 0, 0];
    for (let i = 0; i < BOKEH_LIGHTS; i++) count[at(d, i, 2)]++;
    expect(count).toEqual([BOKEH_BACK, BOKEH_MID - BOKEH_BACK, BOKEH_LIGHTS - BOKEH_MID]);
    expect(count).toEqual([26, 14, 8]);
  });

  it("o plano de fundo é a treliça: 13 colunas, duas fileiras de refletores no alto", () => {
    const d = bokehLights();
    for (let i = 0; i < BOKEH_BACK; i++) {
      const col = Math.floor(i / 2);
      expect(Math.abs(at(d, i, 0) - (col + 0.5) / 13)).toBeLessThanOrEqual(0.01 + 1e-6);
      expect(Math.abs(at(d, i, 1) - (0.8 + (i % 2) * 0.1))).toBeLessThanOrEqual(0.01 + 1e-6);
    }
  });

  it("sorteia na ordem do lab (x, y, cor, raio, fase, clarão, cintilação)", () => {
    // Fundo (i=0): x e y com jitter, depois cor, raio, fase e
    // cintilação — o clarão NÃO sorteia no fundo (curto-circuito).
    // Meio/frente: x, y, cor, raio, fase, sorteio do clarão, cintilação.
    const seq: number[] = [];
    for (let i = 0; i < BOKEH_LIGHTS; i++) seq.push(...(i < BOKEH_BACK ? [0.5, 0.5, 0.1, 0.2, 0.3, 1] : [0.4, 0.6, 0.7, 0.8, 0.9, 0.1, 0]));
    let k = 0;
    const d = bokehLights(() => seq[k++]);
    expect(k).toBe(seq.length);
    expect(Array.from(d.slice(0, 8), (v) => +v.toFixed(6))).toEqual([0.038462, 0.8, 0, 0.1, 0.2, 0.3, 0, 7]);
    const m = BOKEH_BACK * BOKEH_STRIDE;
    expect(Array.from(d.slice(m, m + 8), (v) => +v.toFixed(6))).toEqual([0.4, 0.6, 1, 0.7, 0.8, 0.9, 1, 2]);
  });

  it("clarão só nos planos da frente, e cintilação entre 2 e 7", () => {
    const d = bokehLights();
    for (let i = 0; i < BOKEH_LIGHTS; i++) {
      const flare = at(d, i, 6);
      expect(flare === 0 || flare === 1).toBe(true);
      if (i < BOKEH_BACK) expect(flare).toBe(0);
      expect(at(d, i, 7)).toBeGreaterThanOrEqual(2);
      expect(at(d, i, 7)).toBeLessThanOrEqual(7);
    }
  });
});

describe("Palco: deriva", () => {
  it("médios mudam a VELOCIDADE: 0,25/s parado, 0,85/s no máximo", () => {
    expect(advanceBokehDrift(0, 1, 0)).toBeCloseTo(0.25, 12);
    expect(advanceBokehDrift(0, 1, 1)).toBeCloseTo(0.85, 12);
  });

  it("o avanço de um quadro não depende do tempo de sessão", () => {
    let late = 0;
    for (let f = 0; f < 36000; f++) late = advanceBokehDrift(late, 1 / 60, (f % 30) / 30);
    const step = (d: number) => advanceBokehDrift(d, 1 / 60, 0.7) - d;
    expect(step(late)).toBeCloseTo(step(0), 9);
  });

  it("dt negativo não anda para trás", () => {
    expect(advanceBokehDrift(3, -0.5, 1)).toBe(3);
  });
});
