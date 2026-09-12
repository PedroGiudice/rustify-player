import { describe, it, expect } from "vitest";
import { createGlSignal, stepGlSignal, DEFAULT_GL_CFG, type GlCfg } from "./signal";

const cfg = (over: Partial<GlCfg> = {}): GlCfg => ({ ...DEFAULT_GL_CFG, ...over });

describe("stepGlSignal", () => {
  it("converge as bandas para o alvo ponderado pelos gains", () => {
    const s = createGlSignal();
    // smoothing 0 => tau minimo, converge rapido
    for (let i = 0; i < 200; i++) {
      stepGlSignal(s, 1 / 60, true, { low: 0.8, mid: 0.4, high: 0.2 }, cfg({ smoothing: 0 }));
    }
    expect(s.low).toBeCloseTo(0.8, 2);
    expect(s.mid).toBeCloseTo(0.4, 2);
    expect(s.high).toBeCloseTo(0.2 * DEFAULT_GL_CFG.trebleGain, 2);
  });

  it("gain 0 silencia a banda; gain 2 satura no teto 1", () => {
    const s = createGlSignal();
    for (let i = 0; i < 200; i++) {
      stepGlSignal(s, 1 / 60, true, { low: 0.9, mid: 0.9, high: 0.9 },
        cfg({ smoothing: 0, bassGain: 0, midGain: 2, trebleGain: 1 }));
    }
    expect(s.low).toBeCloseTo(0, 3);
    expect(s.mid).toBeCloseTo(1, 5);
    expect(s.high).toBeCloseTo(0.9, 2);
  });

  it("decai para zero quando o stream de FFT nao esta fresco", () => {
    const s = createGlSignal();
    for (let i = 0; i < 100; i++) {
      stepGlSignal(s, 1 / 60, true, { low: 0.9, mid: 0.9, high: 0.9 }, cfg({ smoothing: 0 }));
    }
    expect(s.low).toBeGreaterThan(0.5);
    for (let i = 0; i < 400; i++) {
      stepGlSignal(s, 1 / 60, false, { low: 0.9, mid: 0.9, high: 0.9 }, cfg({ smoothing: 0 }));
    }
    expect(s.low).toBeLessThan(0.01);
    expect(s.beat).toBeLessThan(0.01);
  });

  it("o relogio avanca com bgSpeed e nunca retrocede", () => {
    const s = createGlSignal();
    stepGlSignal(s, 0.05, false, { low: 0, mid: 0, high: 0 }, cfg({ speed: 1 }));
    const a = s.clock;
    stepGlSignal(s, 0.05, false, { low: 0, mid: 0, high: 0 }, cfg({ speed: 0 }));
    expect(a).toBeCloseTo(0.05, 6);
    expect(s.clock).toBeCloseTo(a, 6); // speed 0 congela, nao volta
  });

  it("modo speed acelera o relogio no kick; modo pulse nao", () => {
    const kick = { low: 0.6, mid: 0, high: 0 };
    const speed = createGlSignal();
    const pulse = createGlSignal();
    for (let i = 0; i < 120; i++) {
      stepGlSignal(speed, 1 / 60, true, kick, cfg({ beatMode: "speed" }));
      stepGlSignal(pulse, 1 / 60, true, kick, cfg({ beatMode: "pulse" }));
    }
    expect(speed.clock).toBeGreaterThan(pulse.clock);
    // mas os dois entregam o envelope de beat pras cenas
    expect(pulse.beat).toBeGreaterThan(0.5);
    expect(speed.beat).toBeGreaterThan(0.5);
  });

  it("modo off zera o beat e mantem o relogio nominal", () => {
    const s = createGlSignal();
    for (let i = 0; i < 120; i++) {
      stepGlSignal(s, 1 / 60, true, { low: 0.6, mid: 0, high: 0 }, cfg({ beatMode: "off" }));
    }
    expect(s.beat).toBe(0);
    expect(s.clock).toBeCloseTo(2, 5);
  });

  it("dt e clampado: voltar do background nao salta a fase", () => {
    const s = createGlSignal();
    stepGlSignal(s, 45, false, { low: 0, mid: 0, high: 0 }, cfg());
    expect(s.clock).toBeLessThanOrEqual(0.1);
  });
});
