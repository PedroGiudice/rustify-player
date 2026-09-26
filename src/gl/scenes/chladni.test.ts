/* ============================================================
   chladni.test.ts — a parte pura da Cimática (sem GL).

   A física dos grãos roda na GPU (transform feedback) e só se vê no
   WebKitGTK real (scripts/gl-bench). O que a CPU decide, e que o lab
   v2 fixou, fica travado aqui: a complexidade suavizada que escolhe a
   figura, a histerese de 11 s, o blend de 2,5 s, a amplitude do salto
   da areia e a faixa da placa que cabe na tela.
   ============================================================ */

import { describe, it, expect } from "vitest";
import {
  CHLADNI_BLEND_S,
  CHLADNI_DT_MAX,
  CHLADNI_HOLD_S,
  CHLADNI_MODES,
  chladniAmp,
  chladniModeIndex,
  chladniPlateBand,
  chladniSeedGrains,
  chladniTarget,
  createChladniSim,
  stepChladni,
  xorshift32,
} from "./chladni";

const quiet = { low: 0, mid: 0, high: 0, beat: 0 };
const loud = { low: 1, mid: 1, high: 1, beat: 1 };

/** Roda `seconds` de simulação em passos de `dt`. */
function run(st: ReturnType<typeof createChladniSim>, sig: typeof quiet, seconds: number, dt = 1 / 60) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) stepChladni(st, sig, dt);
}

describe("Cimática: modos da placa", () => {
  it("12 modos (n, m, ±1) na ordem do lab, do mais simples ao mais intrincado", () => {
    expect(CHLADNI_MODES.map((m) => [...m])).toEqual([
      [1, 2, -1], [1, 3, -1], [2, 3, 1], [1, 4, 1], [2, 5, -1], [3, 4, -1],
      [1, 5, -1], [3, 5, 1], [2, 7, -1], [4, 5, 1], [3, 7, -1], [5, 6, 1],
    ]);
  });

  it("complexidade-alvo: silêncio é 0; faixa cheia pesa 55%, brilho 45%", () => {
    expect(chladniTarget(0, 0, 0)).toBe(0);
    // tot = 1,6 satura a parte de volume; brilho = (0,35·0 + 0,65·0)/(0,3+1,6) = 0.
    expect(chladniTarget(1.6, 0, 0)).toBeCloseTo(0.55, 12);
    // Só agudos: tot = 1, brilho = 0,65/1,3 = 0,5 -> 0,5·1,6 = 0,8.
    expect(chladniTarget(0, 0, 1)).toBeCloseTo(0.55 * (1 / 1.6) + 0.45 * 0.8, 12);
    // Tudo no máximo: brilho = 1/3,3.
    expect(chladniTarget(1, 1, 1)).toBeCloseTo(0.55 + 0.45 * Math.min(1, (1 / 3.3) * 1.6), 12);
  });

  it("índice do modo: cx 0,15 -> 0, cx 0,75 -> 11, arredonda e satura fora da faixa", () => {
    expect(chladniModeIndex(0.15)).toBe(0);
    expect(chladniModeIndex(0.75)).toBe(11);
    expect(chladniModeIndex(0)).toBe(0);
    expect(chladniModeIndex(1)).toBe(11);
    // 0,35 -> (0,2/0,6)·11 = 3,67 -> 4.
    expect(chladniModeIndex(0.35)).toBe(4);
  });
});

describe("Cimática: escolha de figura", () => {
  it("estado inicial do lab: cx 0,35, modo (2, 3) sem migração", () => {
    const st = createChladniSim();
    expect(st.cx).toBe(0.35);
    expect(st.mode).toBe(2);
    expect(st.prev).toBe(2);
    expect(st.weight).toBe(1);
  });

  it("dt <= 0 não avança nada (pausa, primeiro quadro)", () => {
    const st = createChladniSim();
    expect(stepChladni(st, loud, 0)).toBe(false);
    expect(stepChladni(st, loud, -1)).toBe(false);
    expect(st.time).toBe(0);
    expect(st.cx).toBe(0.35);
  });

  it("dt é cortado em 50 ms (física estável ao voltar de um quadro longo)", () => {
    const st = createChladniSim();
    expect(stepChladni(st, quiet, 0.1)).toBe(true);
    expect(st.dt).toBe(CHLADNI_DT_MAX);
    expect(st.time).toBe(CHLADNI_DT_MAX);
  });

  it("cx segue o alvo com tau de 5 s", () => {
    const st = createChladniSim();
    run(st, quiet, 5);
    // Alvo 0: sobra e^-1 da distância, qualquer que seja a partição do dt.
    expect(st.cx).toBeCloseTo(0.35 * Math.exp(-1), 9);
  });

  it("a primeira troca é imediata; as seguintes esperam 11 s", () => {
    const st = createChladniSim();
    // Primeiro quadro: cx ~0,349 pede o modo 4 e a histerese começa em -99 s.
    stepChladni(st, quiet, 1 / 60);
    expect(st.mode).toBe(4);
    expect(st.prev).toBe(2);
    const first = st.lastChange;
    // Música cheia empurra cx para cima, mas a figura segura até 11 s.
    let changedAt = -1;
    for (let i = 0; i < 60 * 30 && changedAt < 0; i++) {
      stepChladni(st, loud, 1 / 60);
      if (st.lastChange !== first) changedAt = st.time;
    }
    expect(changedAt).toBeGreaterThan(first + CHLADNI_HOLD_S);
    expect(changedAt).toBeLessThan(first + CHLADNI_HOLD_S + 2 / 60);
    expect(st.prev).toBe(4);
    expect(st.mode).toBeGreaterThan(4);
  });

  it("nunca troca duas vezes dentro de 11 s, com o sinal oscilando", () => {
    const st = createChladniSim();
    const changes: number[] = [];
    let last = st.lastChange;
    for (let i = 0; i < 60 * 180; i++) {
      const t = i / 60;
      const v = 0.5 + 0.5 * Math.sin(t * 0.9);
      stepChladni(st, { low: v, mid: v, high: 1 - v, beat: v }, 1 / 60);
      if (st.lastChange !== last) {
        changes.push(st.time);
        last = st.lastChange;
      }
    }
    expect(changes.length).toBeGreaterThan(2);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i] - changes[i - 1]).toBeGreaterThan(CHLADNI_HOLD_S);
    }
  });

  it("migração de 2,5 s com smoothstep: pesos somam 1 e o novo modo assume no fim", () => {
    const st = createChladniSim();
    stepChladni(st, quiet, 1 / 60); // troca 2 -> 4, blend = dt/2,5
    expect(st.weight).toBeGreaterThan(0);
    expect(st.weight).toBeLessThan(0.01);
    // Meio da migração: smoothstep(0,5) = 0,5.
    run(st, quiet, CHLADNI_BLEND_S / 2 - 1 / 60);
    expect(st.weight).toBeCloseTo(0.5, 6);
    run(st, quiet, CHLADNI_BLEND_S / 2);
    expect(st.weight).toBe(1);
  });

  it("silêncio longo desce até a figura mais simples", () => {
    const st = createChladniSim();
    run(st, quiet, 60);
    expect(st.mode).toBe(0);
  });

  it("música cheia e brilhante sobe para as figuras intrincadas", () => {
    const st = createChladniSim();
    run(st, loud, 60);
    expect(st.mode).toBe(chladniModeIndex(chladniTarget(1, 1, 1)));
    expect(st.mode).toBeGreaterThanOrEqual(8);
  });
});

describe("Cimática: salto da areia", () => {
  it("amplitude = 0,18 + 0,9·graves + 1,2·(kick acima de 0,45)", () => {
    expect(chladniAmp(0, 0)).toBeCloseTo(0.18, 12);
    expect(chladniAmp(0, 0.45)).toBeCloseTo(0.18, 12);
    expect(chladniAmp(1, 1)).toBeCloseTo(0.18 + 0.9 + 1.2 * 0.55, 12);
    expect(chladniAmp(0.5, 0.7)).toBeCloseTo(0.18 + 0.45 + 1.2 * 0.25, 12);
  });

  it("jitter por quadro = 0,03·amplitude·√dt (difusão, não velocidade)", () => {
    const st = createChladniSim();
    stepChladni(st, { low: 0.5, mid: 0, high: 0, beat: 0.7 }, 0.02);
    expect(st.jitter).toBeCloseTo(0.03 * chladniAmp(0.5, 0.7) * Math.sqrt(0.02), 12);
  });

  it("o passo não depende do tempo de sessão (nada multiplica relógio por sinal)", () => {
    const a = createChladniSim();
    const b = createChladniSim();
    run(b, quiet, 600); // 10 min de sessão
    // Mesmo estado de figura para comparar só o passo.
    Object.assign(a, { cx: b.cx, mode: b.mode, prev: b.prev, blend: b.blend });
    a.lastChange = a.time - (b.time - b.lastChange);
    stepChladni(a, loud, 1 / 60);
    stepChladni(b, loud, 1 / 60);
    expect(a.jitter).toBeCloseTo(b.jitter, 12);
    expect(a.weight).toBeCloseTo(b.weight, 12);
    expect(a.dt).toBe(b.dt);
  });
});

describe("Cimática: placa e grãos", () => {
  it("placa quadrada da largura da tela, cortada em cima e embaixo", () => {
    const band = chladniPlateBand(1366, 768);
    const half = (0.5 * 768) / 1366;
    expect(band.vmin).toBeCloseTo(0.5 - half, 12);
    expect(band.vmax).toBeCloseTo(0.5 + half, 12);
    expect(chladniPlateBand(500, 500)).toEqual({ vmin: 0, vmax: 1 });
  });

  it("retrato (celular): a faixa passa de 0..1 e a figura continua espelhada", () => {
    const band = chladniPlateBand(412, 915);
    expect(band.vmin).toBeLessThan(0);
    expect(band.vmax).toBeGreaterThan(1);
    expect(band.vmin + band.vmax).toBeCloseTo(1, 12);
  });

  it("grãos sorteados como no lab: u em 0..1, v na faixa visível, (u, v) por grão", () => {
    const seq = [0.25, 0.5, 1, 0];
    let i = 0;
    const pos = chladniSeedGrains(2, 0.2, 0.8, () => seq[i++]);
    expect(Array.from(pos)).toEqual([0.25, 0.2 + 0.5 * 0.6, 1, 0.2].map((v) => Math.fround(v)));
    const many = chladniSeedGrains(2000, 0.2, 0.8, xorshift32(7));
    for (let k = 0; k < 2000; k++) {
      expect(many[2 * k]).toBeGreaterThanOrEqual(0);
      expect(many[2 * k]).toBeLessThanOrEqual(1);
      expect(many[2 * k + 1]).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(many[2 * k + 1]).toBeLessThanOrEqual(0.8 + 1e-6);
    }
  });

  it("xorshift32: determinístico, em [0, 1)", () => {
    const a = xorshift32(0x9e3779b9);
    const b = xorshift32(0x9e3779b9);
    for (let k = 0; k < 1000; k++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
