/* ============================================================
   beatPll.test.ts — onset detection + PLL do beat-sync.

   Valida o comportamento especificado em docs/design-refs/
   design_handoff_persistent_background/PATCH-beat-sync-PLL.md
   e demonstrado no Beat Sync Lab.html (fonte da verdade dos
   números). A simulação de kick replica o audioSim do lab:
   step no beat + decay de envelope follower exp(-dt/0.11).
   ============================================================ */

import { describe, it, expect } from "vitest";
import {
  createBeatPll,
  pllStep,
  pulseShape,
  beatPulse,
  PLL_PERIOD_MIN,
  PLL_PERIOD_MAX,
} from "./beatPll";

const FPS = 60;
const DT = 1 / FPS;

/** Roda `seconds` de simulação com kicks periódicos a `bpm`.
    Replica o audioSim do lab: mag salta pra kickAmp no beat e
    decai como envelope follower (tau 0.11s). Retorna o estado. */
function simulate(
  s: ReturnType<typeof createBeatPll>,
  bpm: number,
  seconds: number,
  opts: { kickAmp?: number; fresh?: boolean; startT?: number } = {},
) {
  const { kickAmp = 0.9, fresh = true, startT = 0 } = opts;
  const period = 60 / bpm;
  let mag = 0;
  let nextKick = startT + period;
  let onsets = 0;
  for (let t = startT; t < startT + seconds; t += DT) {
    if (t >= nextKick) {
      mag = kickAmp;
      nextKick += period;
    }
    mag *= Math.exp(-DT / 0.11);
    if (pllStep(s, mag, t, DT, fresh)) onsets++;
  }
  return { onsets };
}

describe("pulseShape (thump)", () => {
  it("é 0 na batida exata e atinge o pico 1.0 em ph=0.04", () => {
    expect(pulseShape(0)).toBe(0);
    expect(pulseShape(0.04)).toBeCloseTo(1.0, 10);
  });

  it("sobe linearmente no attack e decai exponencialmente depois", () => {
    expect(pulseShape(0.02)).toBeCloseTo(0.5, 10);
    // decay: exp(-(ph-0.04)*6.5)
    expect(pulseShape(0.5)).toBeCloseTo(Math.exp(-0.46 * 6.5), 10);
    expect(pulseShape(0.3)).toBeGreaterThan(pulseShape(0.6));
  });
});

describe("onset detection", () => {
  it("não dispara em silêncio", () => {
    const s = createBeatPll();
    const { onsets } = simulate(s, 120, 5, { kickAmp: 0 });
    expect(onsets).toBe(0);
  });

  it("não dispara em nível constante após o warm-up da média", () => {
    const s = createBeatPll();
    // Warm-up: avgMag parte de 0, então os primeiros ~0.4s registram
    // ratio alto (transiente de startup — igual no lab).
    for (let t = 0; t < 1; t += DT) pllStep(s, 0.5, t, DT, true);
    let onsets = 0;
    for (let t = 1; t < 6; t += DT) {
      if (pllStep(s, 0.5, t, DT, true)) onsets++;
    }
    expect(onsets).toBe(0);
  });

  it("respeita o floor: transiente abaixo de 0.25 não é onset", () => {
    const s = createBeatPll();
    const { onsets } = simulate(s, 120, 5, { kickAmp: 0.2 });
    expect(onsets).toBe(0);
  });

  it("detecta ~1 onset por kick (cooldown evita double-trigger)", () => {
    const s = createBeatPll();
    // 10s a 120 BPM = 20 kicks (primeiro em t=0.5)
    const { onsets } = simulate(s, 120, 10);
    expect(onsets).toBeGreaterThanOrEqual(17);
    expect(onsets).toBeLessThanOrEqual(20);
  });

  it("fresh=false não detecta onset nem alimenta a média", () => {
    const s = createBeatPll();
    const { onsets } = simulate(s, 120, 5, { fresh: false });
    expect(onsets).toBe(0);
    expect(s.avgMag).toBe(0);
  });
});

describe("PLL lock", () => {
  it("trava em kicks periódicos a 120 BPM e estima o período", () => {
    const s = createBeatPll();
    simulate(s, 120, 10);
    // Steady state do design: lock pós-onset ~0.63, decaindo até ~0.52
    // antes do onset seguinte (decay exp(-0.5/2.5) entre batidas). O
    // instante final cai num ponto arbitrário do ciclo → piso 0.45.
    expect(s.locked).toBeGreaterThan(0.45);
    expect(60 / s.period).toBeGreaterThan(112);
    expect(60 / s.period).toBeLessThan(128);
  });

  it("converge o período pra um tempo diferente do inicial (100 BPM)", () => {
    const s = createBeatPll(); // period inicial 0.5s = 120 BPM
    simulate(s, 100, 30);
    const estBpm = 60 / s.period;
    expect(estBpm).toBeGreaterThan(92);
    expect(estBpm).toBeLessThan(108);
    expect(s.locked).toBeGreaterThan(0.5);
  });

  it("lock decai sem onsets (silêncio depois de travar)", () => {
    const s = createBeatPll();
    simulate(s, 120, 10);
    const lockedBefore = s.locked;
    simulate(s, 120, 5, { kickAmp: 0, startT: 10 });
    expect(s.locked).toBeLessThan(lockedBefore * 0.25);
  });

  it("clampa o período em [PLL_PERIOD_MIN, PLL_PERIOD_MAX]", () => {
    const s = createBeatPll();
    // Onsets em rajada caótica não podem levar o período pra fora do range.
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += 0.21 + (i % 3) * 0.17;
      pllStep(s, 0.9, t, DT, true);
      // decai a média entre rajadas pra manter o ratio alto
      for (let k = 0; k < 10; k++) pllStep(s, 0.01, (t += DT), DT, true);
      expect(s.period).toBeGreaterThanOrEqual(PLL_PERIOD_MIN);
      expect(s.period).toBeLessThanOrEqual(PLL_PERIOD_MAX);
    }
  });
});

describe("beatPulse", () => {
  it("é 0 com depth 0", () => {
    const s = createBeatPll();
    s.phase = 0.04;
    s.locked = 1;
    expect(beatPulse(s, 0)).toBe(0);
  });

  it("no pico com lock pleno vale depth", () => {
    const s = createBeatPll();
    s.phase = 0.04;
    s.locked = 1;
    expect(beatPulse(s, 0.55)).toBeCloseTo(0.55, 10);
  });

  it("sem lock, o pulso é atenuado pra 40% (não pulsa no escuro)", () => {
    const s = createBeatPll();
    s.phase = 0.04;
    s.locked = 0;
    expect(beatPulse(s, 1)).toBeCloseTo(0.4, 10);
  });
});
