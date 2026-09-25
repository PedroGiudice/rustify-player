import { describe, expect, it } from "vitest";
import { advanceDustTravel, DUST_DEPTH } from "./motion";
import { createGlSignal, stepGlSignal, DEFAULT_GL_CFG } from "./signal";

/* CMR-267: a Poeira fazia p.z = mod(p.z + uTime*(3+4*uMid)), então a
   velocidade aparente era speed + uTime·d(speed)/dt e crescia com o
   tempo de sessão (4 u/s projetados, 279 u/s aos 5 min). A distância
   agora é integrada na CPU; estes testes travam o contrato de que a
   velocidade depende do sinal, nunca do relógio acumulado. */

/** Delta de deslocamento entre dois quadros, desfazendo a volta do mod. */
function wrappedDelta(prev: number, next: number): number {
  const d = next - prev;
  return d < 0 ? d + DUST_DEPTH : d;
}

describe("advanceDustTravel", () => {
  it("velocidade fica entre 3 e 7 u/s em qualquer ponto de uma sessão longa", () => {
    const cfg = { ...DEFAULT_GL_CFG, beatMode: "off" as const };
    const sig = createGlSignal();
    const dt = 1 / 62;
    let travel = 0;
    let frame = 0;
    const speeds: number[] = [];
    // 10 min de sinal real: médios 0.35 ± 0.15, oscilando a cada quadro
    // (o shader antigo já passava de 500 u/s nesse ponto).
    for (let t = 0; t < 600; t += dt, frame++) {
      const mid = 0.35 + 0.15 * Math.sin(frame * 1.7);
      const prevClock = sig.clock;
      stepGlSignal(sig, dt, true, { low: 0.3, mid, high: 0.2 }, cfg);
      const next = advanceDustTravel(travel, sig.clock - prevClock, sig.mid);
      speeds.push(wrappedDelta(travel, next) / dt);
      travel = next;
    }
    const early = speeds.slice(0, 620);
    const late = speeds.slice(-620);
    expect(Math.min(...speeds)).toBeGreaterThanOrEqual(3 - 1e-6);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(7 + 1e-6);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Mesma média no primeiro e no último intervalo de 10 s.
    expect(Math.abs(mean(late) - mean(early))).toBeLessThan(0.2);
  });

  it("segue o relógio virtual: bgSpeed 0 congela a deriva", () => {
    const cfg = { ...DEFAULT_GL_CFG, speed: 0 };
    const sig = createGlSignal();
    let travel = 12;
    for (let i = 0; i < 300; i++) {
      const prevClock = sig.clock;
      stepGlSignal(sig, 1 / 60, true, { low: 0.8, mid: 0.9, high: 0.5 }, cfg);
      travel = advanceDustTravel(travel, sig.clock - prevClock, sig.mid);
    }
    expect(travel).toBe(12);
  });

  it("mantém o deslocamento dentro de [0, DUST_DEPTH) para não perder precisão", () => {
    let travel = 0;
    for (let i = 0; i < 100000; i++) travel = advanceDustTravel(travel, 0.1, 1);
    expect(travel).toBeGreaterThanOrEqual(0);
    expect(travel).toBeLessThan(DUST_DEPTH);
  });

  it("ignora delta de relógio negativo", () => {
    expect(advanceDustTravel(5, -1, 0.5)).toBe(5);
  });
});
