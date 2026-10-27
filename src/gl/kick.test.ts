import { describe, expect, it } from "vitest";
import {
  HIST_RATE,
  KICK_MIN_GAP,
  KICK_OFF,
  KICK_ON,
  SURGE_TAU,
  createKickTrigger,
  createPulseHistory,
  pulseAgo,
  pushPulse,
  stepKickTrigger,
  stepSurge,
} from "./kick";

describe("KickTrigger", () => {
  it("um evento por subida do pulso; rearma só abaixo de KICK_OFF", () => {
    const k = createKickTrigger();
    const dt = 1 / 60;
    expect(stepKickTrigger(k, KICK_ON + 0.1, dt)).toBe(true);
    // Pulso segue alto: nada.
    for (let i = 0; i < 60; i++) expect(stepKickTrigger(k, 0.9, dt)).toBe(false);
    // Cai, mas não abaixo do rearme: nada.
    for (let i = 0; i < 10; i++) expect(stepKickTrigger(k, KICK_OFF + 0.01, dt)).toBe(false);
    expect(stepKickTrigger(k, KICK_ON + 0.1, dt)).toBe(false);
    stepKickTrigger(k, 0, dt);
    expect(stepKickTrigger(k, KICK_ON + 0.1, dt)).toBe(true);
  });

  it("nunca mais de 3 eventos por segundo, mesmo com pulso picotado", () => {
    const k = createKickTrigger();
    const dt = 1 / 120;
    let n = 0;
    let last = -Infinity;
    let minGap = Infinity;
    for (let i = 0; i < 1200; i++) {
      const t = i * dt;
      const p = i % 4 < 2 ? 1 : 0; // liga/desliga a 30 Hz
      if (stepKickTrigger(k, p, dt)) {
        n++;
        minGap = Math.min(minGap, t - last);
        last = t;
      }
    }
    expect(minGap).toBeGreaterThanOrEqual(KICK_MIN_GAP - 1e-9);
    expect(n / 10).toBeLessThan(3);
  });
});

describe("surge", () => {
  it("sobe junto com o pulso e cai com SURGE_TAU", () => {
    let s = stepSurge(0, 0.8, 1 / 60);
    expect(s).toBe(0.8);
    s = stepSurge(s, 0, SURGE_TAU);
    expect(s).toBeCloseTo(0.8 * Math.exp(-1), 9);
    expect(stepSurge(0.5, 3, 0)).toBe(1); // teto 1
    expect(stepSurge(0.5, Number.NaN, 0.1)).toBeLessThan(0.5); // NaN não entra
  });
});

describe("PulseHistory", () => {
  it("lê o pulso de d segundos atrás no relógio virtual", () => {
    const h = createPulseHistory(2);
    const step = 1 / HIST_RATE;
    // 1 s de zero, um degrau de 1 por 0,2 s, depois zero de novo.
    for (let i = 0; i < HIST_RATE; i++) pushPulse(h, 0, step);
    for (let i = 0; i < HIST_RATE * 0.2; i++) pushPulse(h, 1, step);
    for (let i = 0; i < HIST_RATE * 0.5; i++) pushPulse(h, 0, step);
    expect(pulseAgo(h, 0)).toBe(0);
    expect(pulseAgo(h, 0.6)).toBe(1);
    expect(pulseAgo(h, 0.9)).toBe(0);
    expect(pulseAgo(h, 99)).toBe(0); // além da memória
  });

  it("relógio parado (Speed = 0) não grava: a memória congela", () => {
    const h = createPulseHistory(1);
    pushPulse(h, 1, 0.5);
    const snap = Float32Array.from(h.buf);
    for (let i = 0; i < 100; i++) pushPulse(h, 0, 0);
    expect(Array.from(h.buf)).toEqual(Array.from(snap));
  });
});
