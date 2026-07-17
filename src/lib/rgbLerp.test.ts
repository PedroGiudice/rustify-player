import { describe, expect, it } from "vitest";
import { stepRgbLerp, type Rgb } from "./rgbLerp";

/* Lerp exponencial de cor usado pelos canvases (EqCanvas; mesmo modelo do
   SpectrumCanvas). Substitui a leitura do valor interpolado pela transition
   CSS de custom property registrada — removida por custo de restyle global
   no WebKitGTK (60fps -> 29fps medido durante os 480ms, stall de 382ms). */

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

describe("stepRgbLerp", () => {
  it("converge pro alvo com passos sucessivos", () => {
    const cur = rgb(0, 0, 0);
    const tgt = rgb(200, 100, 50);
    // 150 frames de 16ms com tau 0.35s = 2.4s ≈ 7*tau (resíduo ~0.1%).
    for (let i = 0; i < 150; i++) stepRgbLerp(cur, tgt, 0.016, 0.35);
    expect(cur.r).toBeCloseTo(200, 0);
    expect(cur.g).toBeCloseTo(100, 0);
    expect(cur.b).toBeCloseTo(50, 0);
  });

  it("dt=0 não move a cor", () => {
    const cur = rgb(10, 20, 30);
    stepRgbLerp(cur, rgb(200, 200, 200), 0, 0.35);
    expect(cur).toEqual(rgb(10, 20, 30));
  });

  it("um passo cobre a fração exponencial exata (1 - e^(-dt/tau))", () => {
    const cur = rgb(0, 0, 0);
    stepRgbLerp(cur, rgb(100, 100, 100), 0.35, 0.35); // dt == tau
    const k = 1 - Math.exp(-1);
    expect(cur.r).toBeCloseTo(100 * k, 5);
  });

  it("tau longo (deriva do ciclo, 3.5s) move pouco por frame", () => {
    const cur = rgb(0, 0, 0);
    stepRgbLerp(cur, rgb(255, 255, 255), 0.016, 3.5);
    expect(cur.r).toBeLessThan(2); // ~0.46% do caminho
    expect(cur.r).toBeGreaterThan(0);
  });

  it("muta o objeto corrente in-place (sem alocação por frame)", () => {
    const cur = rgb(0, 0, 0);
    const ref = cur;
    stepRgbLerp(cur, rgb(50, 50, 50), 0.016, 0.35);
    expect(cur).toBe(ref);
  });
});
