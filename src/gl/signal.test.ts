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

describe("reação relativa (swell / pulse / midLift / level)", () => {
  const run = (s: ReturnType<typeof createGlSignal>, n: number, low: number, mid: number, c: GlCfg, fresh = true) => {
    for (let i = 0; i < n; i++) stepGlSignal(s, 1 / 60, fresh, { low, mid, high: 0 }, c);
  };
  const pulseCfg = cfg({ beatMode: "pulse", beatDepth: 1, smoothing: 0.3 });

  it("nível constante não é lift: música alta não fica permanentemente alta", () => {
    const s = createGlSignal();
    run(s, 60 * 30, 0.8, 0.7, pulseCfg);
    expect(s.low).toBeGreaterThan(0.7); // a banda absoluta segue alta (outras cenas)
    expect(s.swell).toBeLessThan(0.01);
    expect(s.midLift).toBeLessThan(0.01);
    expect(s.pulse).toBeLessThan(0.01);
  });

  it("subida acima da média vira lift, e some quando a média alcança", () => {
    const s = createGlSignal();
    run(s, 60 * 20, 0.3, 0.2, pulseCfg);
    run(s, 60 * 1, 0.6, 0.5, pulseCfg);
    expect(s.swell).toBeGreaterThan(0.5);
    expect(s.midLift).toBeGreaterThan(0.5);
    run(s, 60 * 40, 0.6, 0.5, pulseCfg);
    expect(s.swell).toBeLessThan(0.05);
    expect(s.midLift).toBeLessThan(0.05);
  });

  it("agudos (11/10, zonas da Tinta): subida acima da média vira highLift; nível constante não; Treble multiplica", () => {
    const step = (st: ReturnType<typeof createGlSignal>, n: number, high: number, c: GlCfg) => {
      for (let i = 0; i < n; i++) stepGlSignal(st, 1 / 60, true, { low: 0.4, mid: 0.3, high }, c);
    };
    const s = createGlSignal();
    step(s, 60 * 30, 0.6, pulseCfg);
    expect(s.highLift).toBeLessThan(0.01);
    step(s, 60 * 1, 0.9, pulseCfg);
    expect(s.highLift).toBeGreaterThan(0.5);
    step(s, 60 * 40, 0.9, pulseCfg);
    expect(s.highLift).toBeLessThan(0.05);
    // Treble 0 zera; o ganho entra no lift, não no raw.
    const mute = createGlSignal();
    step(mute, 60 * 20, 0.2, cfg({ ...pulseCfg, trebleGain: 0 }));
    step(mute, 60 * 1, 0.8, cfg({ ...pulseCfg, trebleGain: 0 }));
    expect(mute.highLift).toBe(0);
  });

  it("relativo de verdade: o mesmo desenho em nível alto e baixo dá a mesma reação", () => {
    // Kicks a 120 BPM sobre um grave sustentado, em duas escalas.
    const pattern = (scale: number) => {
      const s = createGlSignal();
      let peak = 0;
      for (let i = 0; i < 60 * 30; i++) {
        const low = scale * (i % 30 < 4 ? 0.9 : 0.5);
        stepGlSignal(s, 1 / 60, true, { low, mid: 0, high: 0 }, pulseCfg);
        if (i > 60 * 20) peak = Math.max(peak, s.pulse);
      }
      return peak;
    };
    const hi = pattern(1);
    const lo = pattern(0.6);
    expect(hi).toBeGreaterThan(0.5);
    expect(Math.abs(hi - lo)).toBeLessThan(0.1);
  });

  it("o ganho multiplica o lift (Bass não é placebo); gain 0 zera", () => {
    const peak = (bassGain: number) => {
      const s = createGlSignal();
      run(s, 60 * 20, 0.3, 0, cfg({ ...pulseCfg, bassGain }));
      run(s, 30, 0.45, 0, cfg({ ...pulseCfg, bassGain }));
      return s.swell;
    };
    expect(peak(0)).toBe(0);
    expect(peak(0.3)).toBeGreaterThan(0);
    expect(peak(0.3)).toBeLessThan(0.5 * peak(1));
  });

  it("stream parado: tudo decai a zero, as médias congelam, a volta não é transiente", () => {
    const s = createGlSignal();
    for (let i = 0; i < 60 * 20; i++)
      stepGlSignal(s, 1 / 60, true, { low: i % 30 < 4 ? 0.9 : 0.6, mid: 0.5, high: 0 }, pulseCfg);
    const avg = s.lowAvg;
    const dev = s.lowDev;
    run(s, 60 * 10, 0, 0, pulseCfg, false);
    for (const k of ["swell", "pulse", "midLift", "highLift", "level"] as const) expect(s[k]).toBeLessThan(0.01);
    expect(s.lowAvg).toBe(avg);
    expect(s.lowDev).toBe(dev);
    // Volta no nível médio de sempre: nada de swell/pulse gigante.
    let maxSwell = 0;
    let maxPulse = 0;
    for (let i = 0; i < 60; i++) {
      stepGlSignal(s, 1 / 60, true, { low: avg, mid: 0.5, high: 0 }, pulseCfg);
      maxSwell = Math.max(maxSwell, s.swell);
      maxPulse = Math.max(maxPulse, s.pulse);
    }
    expect(maxSwell).toBeLessThan(0.05);
    expect(maxPulse).toBeLessThan(0.05);
  });

  it("silêncio com o stream vivo (mudo, volume 0, gap entre faixas) congela as médias como a pausa", () => {
    // O FFT é medido depois do volume: mudo chega como zeros com fresh=true.
    const s = createGlSignal();
    for (let i = 0; i < 60 * 20; i++)
      stepGlSignal(s, 1 / 60, true, { low: i % 30 < 4 ? 0.9 : 0.6, mid: 0.5, high: 0.1 }, pulseCfg);
    const avg = s.lowAvg;
    const dev = s.lowDev;
    run(s, 60 * 20, 0, 0, pulseCfg, true);
    for (const k of ["swell", "pulse", "midLift", "highLift", "level"] as const) expect(s[k]).toBeLessThan(0.01);
    expect(s.lowAvg).toBe(avg);
    expect(s.lowDev).toBe(dev);
    let maxSwell = 0;
    let maxPulse = 0;
    for (let i = 0; i < 60; i++) {
      stepGlSignal(s, 1 / 60, true, { low: avg, mid: 0.5, high: 0.1 }, pulseCfg);
      maxSwell = Math.max(maxSwell, s.swell);
      maxPulse = Math.max(maxPulse, s.pulse);
    }
    expect(maxSwell).toBeLessThan(0.05);
    expect(maxPulse).toBeLessThan(0.05);
  });

  it("NaN/Infinity no raw, nos ganhos ou no dt não contaminam o estado", () => {
    const s = createGlSignal();
    run(s, 60 * 5, 0.5, 0.3, pulseCfg);
    for (let i = 0; i < 10; i++) stepGlSignal(s, 1 / 60, true, { low: NaN, mid: Infinity, high: -Infinity }, pulseCfg);
    for (let i = 0; i < 10; i++)
      stepGlSignal(s, 1 / 60, true, { low: 0.5, mid: 0.3, high: 0 }, cfg({ ...pulseCfg, bassGain: NaN, midGain: Infinity, beatDepth: NaN, smoothing: NaN }));
    stepGlSignal(s, NaN, true, { low: 0.5, mid: 0.3, high: 0 }, pulseCfg);
    run(s, 60 * 5, 0.5, 0.3, pulseCfg);
    for (const k of ["low", "mid", "high", "beat", "clock", "swell", "pulse", "midLift", "highLift", "level", "lowAvg", "lowDev", "midAvg", "midDev", "highAvg", "highDev"] as const) {
      expect(Number.isFinite(s[k]), k).toBe(true);
    }
    for (const k of ["low", "mid", "high", "beat", "swell", "pulse", "midLift", "highLift", "level"] as const) {
      expect(s[k], k).toBeGreaterThanOrEqual(0);
      expect(s[k], k).toBeLessThanOrEqual(1);
    }
  });

  it("partida: a 1ª amostra alta não deixa a faixa inteira 'abaixo da média'", () => {
    const s = createGlSignal();
    stepGlSignal(s, 1 / 60, true, { low: 0.9, mid: 0, high: 0 }, pulseCfg);
    // Depois o trecho vive em 0,3 com kicks a 0,5: em 3 s já reage.
    let peak = 0;
    for (let i = 0; i < 60 * 3; i++) {
      stepGlSignal(s, 1 / 60, true, { low: i % 30 < 4 ? 0.5 : 0.3, mid: 0, high: 0 }, pulseCfg);
      if (i > 60 * 2) peak = Math.max(peak, s.pulse);
    }
    expect(peak).toBeGreaterThan(0.3);
  });

  it("beatMode off zera o pulse; beatDepth escala", () => {
    const peakWith = (c: GlCfg) => {
      const s = createGlSignal();
      let peak = 0;
      for (let i = 0; i < 60 * 20; i++) {
        stepGlSignal(s, 1 / 60, true, { low: i % 30 < 4 ? 0.9 : 0.5, mid: 0, high: 0 }, c);
        expect(c.beatMode !== "off" || s.pulse === 0).toBe(true);
        if (i > 60 * 10) peak = Math.max(peak, s.pulse);
      }
      return peak;
    };
    expect(peakWith(cfg({ ...pulseCfg, beatMode: "off" }))).toBe(0);
    const full = peakWith(cfg({ ...pulseCfg, beatDepth: 1 }));
    const half = peakWith(cfg({ ...pulseCfg, beatDepth: 0.5 }));
    expect(full).toBeGreaterThan(0.8);
    expect(half).toBeCloseTo(full / 2, 1);
  });
});
