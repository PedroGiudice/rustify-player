/* ============================================================
   sceneReaction.test.ts — reatividade das cenas no sinal REAL gravado
   no app (fft-real-2609), pela cadeia do app (stepGlSignal).

   Dois contratos (pedido do CEO, 30/10/2026):
   1. Beat depth regula a FORÇA da batida, nunca se ela existe. Antes,
      Lorem, Riso e Mandala contavam a batida num pulso já multiplicado
      pelo depth com limiar 0,5: depth <= 0,5 = nenhuma onda (0/min) e
      0,55 = 15,8/min.
   2. Os mesmos knobs mexem as cenas de forma parecida: grave, médio e
      agudo passam pela curva da Tinta (`drive`), que já foi calibrada no
      olho do CEO. Antes, com os ajustes dele, o brilho da Lorem (grave)
      ficava em 10% nos momentos fortes e parado 61% do tempo.
   ============================================================ */

import { describe, it, expect } from "vitest";
import fx from "./__fixtures__/fft-real-2609.json";
import { decodeFixture, type FftFixture } from "./fftReplay";
import { createGlSignal, stepGlSignal, DEFAULT_GL_CFG, type GlCfg, type GlSignal } from "./signal";
import { drive } from "./react";
import { createLoremState, loremReaction, stepLoremWaves } from "./scenes/lorem";
import { createMandalaMotion, mandalaReaction, stepMandala } from "./scenes/mandala";
import { risoReaction } from "./scenes/riso";
import { createDustMotion, stepDust, DUST_LUM_BASE, dustLum } from "./scenes/dust";
import { zoneShift } from "./scenes/paint";

const replay = decodeFixture(fx as unknown as FftFixture);

/** Ajustes do Tweaks do CEO lidos no app em 30/10/2026 (cena Lorem). */
const CEO_3010: GlCfg = {
  bassGain: 0.35, midGain: 0.05, trebleGain: 0.1, smoothing: 1, speed: 0.15, beatMode: "pulse", beatDepth: 0.7,
};

/** Roda o replay inteiro e chama `each` a cada quadro com o sinal e o dt. */
function replayWith(cfg: GlCfg, each: (s: GlSignal, dt: number) => void): number {
  const s = createGlSignal();
  const raw = { low: 0, mid: 0, high: 0 };
  let secs = 0;
  for (let i = 0; i < replay.n; i++) {
    raw.low = replay.v[3 * i];
    raw.mid = replay.v[3 * i + 1];
    raw.high = replay.v[3 * i + 2];
    stepGlSignal(s, replay.dt[i], true, raw, cfg);
    secs += replay.dt[i];
    each(s, replay.dt[i]);
  }
  return secs;
}

function loremWaves(cfg: GlCfg): { perMin: number; meanAmp: number } {
  const st = createLoremState();
  let n = 0, amp = 0, prevClock = 0;
  const secs = replayWith(cfg, (s) => {
    const before = st.kick.n;
    stepLoremWaves(st, s, s.clock - prevClock, 16 / 9, () => 0.5);
    prevClock = s.clock;
    if (st.kick.n !== before) {
      n++;
      amp += st.waves.find((w) => w.age === 0)!.amp;
    }
  });
  return { perMin: (n / secs) * 60, meanAmp: n ? amp / n : 0 };
}

function mandalaKicks(cfg: GlCfg): number {
  const m = createMandalaMotion();
  let n = 0, prevClock = 0;
  const secs = replayWith(cfg, (s) => {
    const wasArmed = m.armed;
    stepMandala(m, s, s.clock - prevClock);
    prevClock = s.clock;
    if (wasArmed && !m.armed) n++;
  });
  return (n / secs) * 60;
}

function dustWaves(cfg: GlCfg): number {
  const m = createDustMotion();
  let n = 0;
  const secs = replayWith(cfg, (s, dt) => {
    const next = m.next;
    stepDust(m, s, dt);
    if (m.next !== next) n++;
  });
  return (n / secs) * 60;
}

const p90 = (a: number[]) => Float64Array.from(a).sort()[Math.floor(0.9 * a.length)];
const share = (a: number[], f: (v: number) => boolean) => a.filter(f).length / a.length;

describe("beat depth regula a força da batida, não se ela existe", () => {
  const depths = [0.3, 0.5, 0.7, 1.0];

  it("Lorem: o número de ondas por minuto é o mesmo em qualquer depth", () => {
    const rates = depths.map((d) => loremWaves({ ...CEO_3010, beatDepth: d }).perMin);
    // Referência medida com o depth 1,0 do código antigo: 27,5 ondas/min.
    for (const r of rates) expect(r).toBeCloseTo(27.5, 0);
  });

  it("Lorem: a onda fica mais forte com mais depth", () => {
    const low = loremWaves({ ...CEO_3010, beatDepth: 0.3 }).meanAmp;
    const high = loremWaves({ ...CEO_3010, beatDepth: 1.0 }).meanAmp;
    expect(high - low).toBeGreaterThan(0.15);
  });

  it("depth 0 desliga a batida: nenhuma onda", () => {
    expect(loremWaves({ ...CEO_3010, beatDepth: 0 }).perMin).toBe(0);
    expect(mandalaKicks({ ...CEO_3010, beatDepth: 0 })).toBe(0);
    expect(dustWaves({ ...CEO_3010, beatDepth: 0 })).toBe(0);
  });

  it("Mandala e Poeira: impulsos por minuto não dependem do depth", () => {
    const m = depths.map((d) => mandalaKicks({ ...CEO_3010, beatDepth: d }));
    const p = depths.map((d) => dustWaves({ ...CEO_3010, beatDepth: d }));
    for (const r of m) expect(r).toBeCloseTo(m[3], 5);
    for (const r of p) expect(r).toBeCloseTo(p[3], 5);
    expect(m[3]).toBeGreaterThan(10);
    expect(p[3]).toBeGreaterThan(10);
  });
});

describe("os mesmos knobs mexem as cenas de forma parecida (curva da Tinta)", () => {
  it("drive é a curva das zonas da Tinta, normalizada a 0..1", () => {
    const norm = zoneShift(1);
    for (const x of [0.02, 0.1, 0.25, 0.5, 1]) expect(drive(x)).toBeCloseTo(zoneShift(x) / norm, 3);
    expect(drive(0)).toBe(0);
    expect(drive(-0.3)).toBe(0);
    expect(drive(2)).toBe(1);
  });

  it("com os ajustes do CEO, o grave da Lorem deixa de ficar quase parado", () => {
    const glow: number[] = [];
    replayWith(CEO_3010, (s) => glow.push(loremReaction(s).glow));
    // Antes: p90 0,10. Meta: perto da metade do efeito nos momentos fortes.
    expect(p90(glow)).toBeGreaterThan(0.4);
    expect(p90(glow)).toBeLessThan(0.6);
  });

  it("com os padrões do app, nenhuma reação da Lorem e da Mandala vive no teto", () => {
    const terms: Record<string, number[]> = { glow: [], spark: [], drift: [], breath: [], fine: [] };
    replayWith(DEFAULT_GL_CFG, (s) => {
      const l = loremReaction(s);
      const m = mandalaReaction(s);
      terms.glow.push(l.glow);
      terms.spark.push(l.spark);
      terms.drift.push(Math.abs(l.drift));
      terms.breath.push(Math.abs(m.breath));
      terms.fine.push(m.fine);
    });
    // Teto da Tinta com os padrões (zona do grave) = 10% do tempo.
    for (const [k, a] of Object.entries(terms)) expect(share(a, (v) => v >= 0.99), k).toBeLessThanOrEqual(0.1);
  });

  it("Riso e Poeira usam a mesma curva no grave", () => {
    const s = createGlSignal();
    s.swell = 0.1;
    expect(risoReaction(s).scale - 1).toBeCloseTo(0.15 * drive(0.1), 6);
    expect(dustLum(s) - DUST_LUM_BASE).toBeCloseTo(0.28 * drive(0.1), 6);
  });
});
