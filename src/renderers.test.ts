/* ============================================================
   renderers.test.ts — Sanidade dos 5 renderers.

   jsdom não implementa canvas 2d, então usamos um ctx stub que
   captura coordenadas. Garante: ordem canônica (índice persiste
   em localStorage), nenhum throw, e toda coordenada emitida é
   finita pra qualquer shape.
   ============================================================ */

import { describe, it, expect } from "vitest";
import { RENDERERS } from "./renderers";
import { SHAPES } from "./shapes";

const EXPECTED_ORDER = ["mesh", "columns", "weave", "dots", "contour"];

/** Stub mínimo do CanvasRenderingContext2D — só o que os renderers usam. */
function makeCtxStub() {
  const coords: number[] = [];
  const push = (...ns: number[]) => { coords.push(...ns); };
  return {
    coords,
    ctx: {
      beginPath() {},
      moveTo: push,
      lineTo: push,
      arc: push,
      stroke() {},
      fill() {},
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D,
  };
}

describe("RENDERERS", () => {
  it("tem 5 renderers na ordem do handoff (mesh = index 0 = default)", () => {
    expect(RENDERERS.map((r) => r.name)).toEqual(EXPECTED_ORDER);
  });

  it("dots: amp desloca geometria, env aumenta raio e alpha — paridade de reatividade", () => {
    const dots = RENDERERS.find((r) => r.name === "dots")!;
    const run = (amp: number, env: number) => {
      const radii: number[] = [];
      const ys: number[] = [];
      const alphas: number[] = [];
      let alpha = 1;
      const ctx = {
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fill() {},
        arc(_x: number, y: number, r: number) { ys.push(y); radii.push(r); },
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 0,
        get globalAlpha() { return alpha; },
        set globalAlpha(a: number) { alpha = a; if (a < 1) alphas.push(a); },
      } as unknown as CanvasRenderingContext2D;
      dots.fn(ctx, 800, 600, 7.3, SHAPES[0].fn, amp, 0.9, "23, 23, 23", env);
      return { radii, ys, maxR: Math.max(...radii), maxA: Math.max(...alphas) };
    };
    const quiet = run(100, 0);
    const loud = run(100, 1);
    // Raio: pulso ponderado pelo campo, +60% nos pontos fortes (cl→1).
    expect(loud.maxR / quiet.maxR).toBeGreaterThan(1.35);
    expect(loud.maxR / quiet.maxR).toBeLessThanOrEqual(1.6 + 1e-9);
    expect(loud.maxA).toBeGreaterThan(quiet.maxA);
    // SEM balanço: a grade é estática — env e amp não movem posição.
    const still = run(0, 0);
    expect(loud.ys.length).toBe(still.ys.length);
    const maxDelta = Math.max(...loud.ys.map((y, i) => Math.abs(y - still.ys[i])));
    expect(maxDelta).toBe(0);
    // Raio baseline (env=0) segue o contrato: maxR * cl * (0.55 + 0.45*breath).
    expect(quiet.maxR).toBeLessThanOrEqual(Math.min(800 / 66, 600 / 44) * 0.66 * (0.55 + 0.45 * 0.9) + 1e-9);
  });

  for (const renderer of RENDERERS) {
    it(`${renderer.name}: desenha sem throw e só emite coordenadas finitas`, () => {
      const w = 800, h = 600, t = 7.3;
      const breath = 0.85 + 0.15 * Math.sin(t * 0.4);
      const amp = h * 0.17 * breath;
      for (const shape of SHAPES) {
        const { coords, ctx } = makeCtxStub();
        renderer.fn(ctx, w, h, t, shape.fn, amp, breath, "23, 23, 23", 0.5);
        expect(coords.length, `${renderer.name} × ${shape.name}: nada desenhado`).toBeGreaterThan(0);
        expect(
          coords.every(Number.isFinite),
          `${renderer.name} × ${shape.name}: coordenada não-finita`,
        ).toBe(true);
      }
    });
  }
});
