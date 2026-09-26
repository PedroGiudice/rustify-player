/* ============================================================
   scenes.test.ts — a parte pura das cenas portadas (sem GL).

   A regra de movimento (CMR-267): o sinal muda VELOCIDADE, a posição
   é integrada. Aqui trava-se isso na Órbitas (zoff e giro em z) e a
   ordem de sorteio da Poeira (a mesma do three).
   ============================================================ */

import { describe, it, expect } from "vitest";
import { dustCloud } from "./dust";
import {
  ORBIT_GAP,
  ORBIT_RINGS,
  ORBIT_STRIDE,
  makeOrbitRings,
  stepOrbits,
  type OrbitState,
} from "./orbits";
import { createGlSignal } from "../signal";
import type { ScenePalette } from "../scene";

const f3 = (r: number, g: number, b: number) => new Float32Array([r, g, b]);
const PAL: ScenePalette = { canvas: f3(0, 0, 0), ink: f3(1, 0, 0), ink2: f3(0, 1, 0), soft: f3(0, 0, 1) };

describe("Poeira: nuvem", () => {
  it("sorteia x, y, z e semente por ponto, nessa ordem, nas faixas do three", () => {
    const seq = [0.5, 1, 0, 0.25, 0, 0.5, 1, 0.75];
    let i = 0;
    const { pos, seed } = dustCloud(2, () => seq[i++]);
    // Ponto 0: x=(0,5-0,5)*70, y=(1-0,5)*40, z=-0*90, semente 0,25.
    // Ponto 1: x=(0-0,5)*70, y=(0,5-0,5)*40, z=-1*90, semente 0,75.
    expect(Array.from(pos, (v) => v + 0)).toEqual([0, 20, 0, -35, 0, -90]);
    expect(Array.from(seed)).toEqual([0.25, 0.75]);
  });

  it("fica dentro do volume 70 x 40 x 90", () => {
    const { pos } = dustCloud(500);
    for (let i = 0; i < 500; i++) {
      expect(Math.abs(pos[i * 3])).toBeLessThanOrEqual(35);
      expect(Math.abs(pos[i * 3 + 1])).toBeLessThanOrEqual(20);
      expect(pos[i * 3 + 2]).toBeLessThanOrEqual(0);
      expect(pos[i * 3 + 2]).toBeGreaterThanOrEqual(-90);
    }
  });
});

describe("Órbitas: passo", () => {
  const fresh = (): OrbitState => ({ rings: makeOrbitRings(), zoff: 0 });

  it("40 anéis, z sempre dentro do túnel e nunca além da câmera", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    const sig = createGlSignal();
    const L = ORBIT_RINGS * ORBIT_GAP;
    for (let f = 0; f < 600; f++) {
      sig.clock += 1 / 60;
      sig.low = (f % 30) / 30;
      stepOrbits(st, sig, 1 / 60, PAL, out);
      for (let r = 0; r < ORBIT_RINGS; r++) {
        const z = out[r * ORBIT_STRIDE];
        expect(z).toBeLessThanOrEqual(12 + 1e-6);
        expect(z).toBeGreaterThan(12 - L - 1e-6);
      }
    }
  });

  it("graves mudam a VELOCIDADE do túnel: o avanço de um quadro não depende do tempo de sessão", () => {
    const a = fresh();
    const b = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    const sig = createGlSignal();
    // b já rodou 10 minutos de sessão; a está no começo.
    for (let f = 0; f < 36000; f++) stepOrbits(b, { ...sig, clock: f / 60 }, 1 / 60, PAL, out);
    const za = a.zoff, zb = b.zoff;
    const loud = { ...sig, low: 1 };
    stepOrbits(a, loud, 1 / 60, PAL, out);
    stepOrbits(b, loud, 1 / 60, PAL, out);
    expect(a.zoff - za).toBeCloseTo((2.5 + 4) / 60, 9);
    expect(b.zoff - zb).toBeCloseTo((2.5 + 4) / 60, 9);
  });

  it("giro em z acumula dt x spin x (1 + 2 médios)", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    const sig = { ...createGlSignal(), mid: 0.5 };
    stepOrbits(st, sig, 0.1, PAL, out);
    const r0 = st.rings[0];
    expect(r0.rotZ).toBeCloseTo(0.1 * r0.spin * 2, 9);
    expect(out[3]).toBeCloseTo(r0.rotZ, 6);
  });

  it("cor: anel múltiplo de 3 usa ink2, os outros ink; agudos puxam pro soft com a profundidade", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    stepOrbits(st, createGlSignal(), 0, PAL, out);
    expect(Array.from(out.slice(4, 7))).toEqual([0, 1, 0]); // anel 0 -> ink2
    expect(Array.from(out.slice(ORBIT_STRIDE + 4, ORBIT_STRIDE + 7))).toEqual([1, 0, 0]); // anel 1 -> ink
    const hot = { ...createGlSignal(), high: 1 };
    stepOrbits(fresh(), hot, 0, PAL, out);
    expect(out[ORBIT_STRIDE + 6]).toBeGreaterThan(0); // puxou pro soft (azul)
  });

  it("opacidade: mais funda (perto da câmera) = mais opaca; agudos acendem", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    stepOrbits(st, createGlSignal(), 0, PAL, out);
    const quiet = Array.from({ length: ORBIT_RINGS }, (_, r) => [out[r * ORBIT_STRIDE], out[r * ORBIT_STRIDE + 7]]);
    quiet.sort((p, q) => p[0] - q[0]);
    expect(quiet[quiet.length - 1][1]).toBeGreaterThan(quiet[0][1]);
    // Opacidade = (0,08 + 0,6·prof²)·(0,4 + 0,6·agudos): agudos no máximo = 2,5x.
    stepOrbits(fresh(), { ...createGlSignal(), high: 1 }, 0, PAL, out);
    const loud0 = out[7];
    stepOrbits(fresh(), createGlSignal(), 0, PAL, out);
    expect(loud0).toBeCloseTo(out[7] / 0.4, 6);
  });
});
