/* Replay do sinal REAL gravado no app (fft-real-2609.json) pela cadeia do
   app (stepGlSignal + reliefReaction), quadro a quadro com o dt gravado.
   Trava as metas da calibração do Relevo (26/09) por faixa, com a cfg que
   o CEO usa de fato e com os defaults. */
import { describe, it, expect } from "vitest";
import fx from "./__fixtures__/fft-real-2609.json";
import { CEO_GL_CFG, decodeFixture, titleAt, trackSpans, worstInstants, type FftFixture } from "./fftReplay";
import { createGlSignal, stepGlSignal, DEFAULT_GL_CFG, type GlCfg, type GlSignal } from "./signal";
import { RELIEF_BASE_AMP, RELIEF_F_MAX, RELIEF_WAVE_MAX, reliefAmp, reliefAmpFactor, reliefOriginalFactor, reliefWaveAmp } from "./reliefReaction";

const replay = decodeFixture(fx as unknown as FftFixture);
const tracks = trackSpans(replay);

/** Percentil por posição (mesma convenção nos dois lados da comparação). */
function pct(a: Float32Array | number[], p: number): number {
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

interface Run {
  F: Float32Array;
  wave: Float32Array;
  swell: Float32Array;
}

function run(cfg: GlCfg): Run {
  const s = createGlSignal();
  const raw = { low: 0, mid: 0, high: 0 };
  const out: Run = { F: new Float32Array(replay.n), wave: new Float32Array(replay.n), swell: new Float32Array(replay.n) };
  for (let i = 0; i < replay.n; i++) {
    raw.low = replay.v[3 * i];
    raw.mid = replay.v[3 * i + 1];
    raw.high = replay.v[3 * i + 2];
    stepGlSignal(s, replay.dt[i], true, raw, cfg);
    out.F[i] = reliefAmpFactor(s);
    out.wave[i] = reliefWaveAmp(s);
    out.swell[i] = s.swell;
  }
  return out;
}

const pick = (a: Float32Array, spans: [number, number][]) => {
  const out: number[] = [];
  for (const [x, y] of spans) for (let i = x; i < y; i++) out.push(a[i]);
  return out;
};

describe("Relevo: replay do sinal real", () => {
  it("a fixture tem as 10 faixas de 15 s ou mais (o teste não é vazio)", () => {
    expect(tracks.length).toBe(10);
    for (const t of tracks) expect(t.seconds).toBeGreaterThanOrEqual(15);
  });

  for (const [name, cfg] of [
    ["cfg do CEO", CEO_GL_CFG],
    ["defaults", DEFAULT_GL_CFG],
  ] as const) {
    describe(name, () => {
      const r = run(cfg);
      for (const t of tracks) {
        it(`${t.title}: contido, com teto, e respirando`, () => {
          const F = pick(r.F, t.spans);
          const w = pick(r.wave, t.spans);
          expect(pct(F, 50)).toBeLessThanOrEqual(1.15);
          expect(pct(F, 95)).toBeLessThanOrEqual(1.4);
          expect(Math.max(...F)).toBeLessThanOrEqual(1.5);
          // Respira: o terreno não pode ficar parado.
          expect(pct(F, 95) - pct(F, 5)).toBeGreaterThanOrEqual(0.12);
          expect(pct(w, 95)).toBeLessThanOrEqual(2.5);
        });
      }
    });
  }

  it("Bass é sensibilidade de verdade: 0,30 contém o swell bem mais que 1,0", () => {
    const lo = run({ ...CEO_GL_CFG, bassGain: 0.3 }).swell;
    const hi = run({ ...CEO_GL_CFG, bassGain: 1.0 }).swell;
    expect(pct(hi, 95)).toBeGreaterThan(0.1);
    expect(pct(lo, 95)).toBeLessThan(0.5 * pct(hi, 95));
  });
});

describe("Relevo: teto da reação", () => {
  const sigOf = (swell: number, pulse: number, level: number, midLift: number): GlSignal => ({
    ...createGlSignal(),
    swell,
    pulse,
    level,
    midLift,
  });

  it("F = 1 em repouso e nunca alcança o teto, nem com tudo em 1", () => {
    expect(reliefAmpFactor(sigOf(0, 0, 0, 0))).toBe(1);
    expect(reliefAmp(sigOf(0, 0, 0, 0))).toBe(RELIEF_BASE_AMP);
    const top = reliefAmpFactor(sigOf(1, 1, 1, 1));
    expect(top).toBeLessThan(RELIEF_F_MAX);
    expect(reliefWaveAmp(sigOf(1, 1, 1, 1))).toBe(RELIEF_WAVE_MAX);
  });

  it("joelho suave: F cresce monotônico, sem degrau", () => {
    let prev = 1;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const F = reliefAmpFactor(sigOf(v, v, v, 0));
      expect(F).toBeGreaterThanOrEqual(prev);
      expect(F - prev).toBeLessThan(0.02);
      prev = F;
    }
  });

  it("entradas extremas (0/1 alternado, ruído, ganhos altos) respeitam os tetos", () => {
    let seed = 0x2545f491;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const cfgs: GlCfg[] = [
      CEO_GL_CFG,
      DEFAULT_GL_CFG,
      { ...DEFAULT_GL_CFG, bassGain: 4, midGain: 4, beatDepth: 1, smoothing: 0, beatMode: "pulse" },
    ];
    let fMin = Infinity, fMax = -Infinity, wMax = 0, lo = Infinity, hi = -Infinity;
    for (const cfg of cfgs) {
      const s = createGlSignal();
      for (let i = 0; i < 6000; i++) {
        const mode = Math.floor(i / 1000) % 3;
        const v = mode === 0 ? i % 2 : mode === 1 ? rnd() : i % 60 < 3 ? 1 : 0;
        stepGlSignal(s, i % 97 === 0 ? 0.25 : 1 / 60, true, { low: v, mid: 1 - v, high: v }, cfg);
        const F = reliefAmpFactor(s);
        fMin = Math.min(fMin, F);
        fMax = Math.max(fMax, F);
        wMax = Math.max(wMax, reliefWaveAmp(s));
        for (const k of ["swell", "pulse", "midLift", "level"] as const) {
          lo = Math.min(lo, s[k]);
          hi = Math.max(hi, s[k]);
        }
      }
    }
    expect(fMin).toBeGreaterThanOrEqual(1);
    expect(fMax).toBeLessThan(RELIEF_F_MAX);
    expect(wMax).toBeLessThanOrEqual(RELIEF_WAVE_MAX);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    // As entradas extremas chegam perto dos tetos (o teste exercita o teto).
    expect(fMax).toBeGreaterThan(1.3);
  });
});

describe("worstInstants (gl-bench)", () => {
  it("acha os picos da cadeia antiga, separados, e a reação nova neles fica no teto", () => {
    const w = worstInstants(replay, DEFAULT_GL_CFG, reliefOriginalFactor, 2, 5);
    expect(w.length).toBe(2);
    expect(w[0].score).toBeGreaterThanOrEqual(w[1].score);
    expect(Math.abs(w[0].t - w[1].t)).toBeGreaterThanOrEqual(5);
    expect(w[0].score).toBeGreaterThan(2.2); // o pior da tabela antiga (max 2,25)
    for (const x of w) expect(titleAt(replay, x.index)).not.toBe("");
  });
});
