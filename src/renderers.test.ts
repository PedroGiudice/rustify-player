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

  it("dots: env (envelope de áudio) aumenta raio e alpha — reatividade real", () => {
    const dots = RENDERERS.find((r) => r.name === "dots")!;
    const run = (env: number) => {
      const radii: number[] = [];
      const alphas: number[] = [];
      let alpha = 1;
      const ctx = {
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fill() {},
        arc(_x: number, _y: number, r: number) { radii.push(r); },
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 0,
        get globalAlpha() { return alpha; },
        set globalAlpha(a: number) { alpha = a; if (a < 1) alphas.push(a); },
      } as unknown as CanvasRenderingContext2D;
      dots.fn(ctx, 800, 600, 7.3, SHAPES[0].fn, 100, 0.9, "23, 23, 23", env);
      return { maxR: Math.max(...radii), maxA: Math.max(...alphas) };
    };
    const quiet = run(0);
    const loud = run(1);
    // Raio: pulso de +22% no pico; alpha: flash de +55% (clamp 0.9).
    expect(loud.maxR / quiet.maxR).toBeCloseTo(1.22, 2);
    expect(loud.maxA).toBeGreaterThan(quiet.maxA);
    // env=0 preserva o baseline do handoff (0.55 + 0.45*breath, sem pulso).
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
