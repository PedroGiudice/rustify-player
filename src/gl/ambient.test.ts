/* ============================================================
   ambient.test.ts — a parte sem GL do modo ambient (gl/ambient.ts).

   Trava: a troca focused <-> ambient leva 420 ms integrados por dt,
   segue o --ease-out (linear na versão calma, sem salto), cravada no
   primeiro quadro e sem salto na reversão; o buffer do desfoque tem
   1/4 da tela por eixo; o kernel soma 1 e dá o desvio pedido.
   ============================================================ */

import { describe, it, expect } from "vitest";
import {
  AMBIENT_GAIN,
  AMBIENT_MODE_S,
  AMBIENT_PAIRS,
  AMBIENT_SAT,
  AMBIENT_SCALE,
  ambientBufferSize,
  ambientLook,
  ambientSigma,
  createModeTween,
  cubicBezier,
  easeOut,
  gaussPairs,
  stepModeTween,
} from "./ambient";

const DT = 1 / 60;

/** Passos até o valor chegar ao alvo, a 60 fps. */
function framesTo(target: number, calm: boolean, from: number): { frames: number; values: number[] } {
  const s = createModeTween();
  stepModeTween(s, from, DT, calm);
  const values: number[] = [];
  let frames = 0;
  while (s.value !== target && frames < 1000) {
    values.push(stepModeTween(s, target, DT, calm));
    frames++;
  }
  return { frames, values };
}

describe("troca de modo (focused <-> ambient)", () => {
  it("primeiro quadro crava o modo pedido, sem rampa", () => {
    const s = createModeTween();
    expect(stepModeTween(s, 1, DT, false)).toBe(1);
    const f = createModeTween();
    expect(stepModeTween(f, 0, DT, false)).toBe(0);
  });

  it("focused -> ambient chega em 420 ms, monotônica, no --ease-out", () => {
    const { frames, values } = framesTo(1, false, 0);
    expect(frames).toBe(Math.ceil(AMBIENT_MODE_S / DT - 1e-9));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    // Ease-out: a metade do caminho sai bem antes da metade do tempo.
    const half = values.findIndex((v) => v >= 0.5);
    expect(half).toBeLessThan(values.length * 0.3);
  });

  it("ambient -> focused também leva 420 ms", () => {
    const { frames, values } = framesTo(0, false, 1);
    expect(frames).toBe(Math.ceil(AMBIENT_MODE_S / DT - 1e-9));
    expect(values[values.length - 1]).toBe(0);
  });

  it("versão calma: mesma duração, linear (só o fade, sem salto)", () => {
    const { frames, values } = framesTo(1, true, 0);
    expect(frames).toBe(Math.ceil(AMBIENT_MODE_S / DT - 1e-9));
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i]).toBeCloseTo(Math.min(1, ((i + 1) * DT) / AMBIENT_MODE_S), 9);
    }
    // Nenhum degrau maior que um quadro de 420 ms.
    let prev = 0;
    for (const v of values) {
      expect(v - prev).toBeLessThanOrEqual(DT / AMBIENT_MODE_S + 1e-9);
      prev = v;
    }
  });

  it("integra por dt: o mesmo tempo em quadros de 30 fps chega igual", () => {
    const s = createModeTween();
    stepModeTween(s, 0, DT, false);
    let t = 0;
    while (s.value < 1 && t < 2) {
      stepModeTween(s, 1, 1 / 30, false);
      t += 1 / 30;
    }
    expect(t).toBeCloseTo(Math.ceil(AMBIENT_MODE_S * 30 - 1e-9) / 30, 9);
  });

  it("dt zero ou negativo não anda", () => {
    const s = createModeTween();
    stepModeTween(s, 0, DT, false);
    stepModeTween(s, 1, DT, false);
    const v = s.value;
    expect(stepModeTween(s, 1, 0, false)).toBe(v);
    expect(stepModeTween(s, 1, -1, false)).toBe(v);
  });

  it("reversão no meio: parte do valor atual, sem salto, e encurta", () => {
    const s = createModeTween();
    stepModeTween(s, 0, DT, false);
    for (let i = 0; i < 6; i++) stepModeTween(s, 1, DT, false);
    const mid = s.value;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // Primeiro passo da volta: perto do valor de onde saiu.
    const back = stepModeTween(s, 0, DT, false);
    expect(back).toBeLessThan(mid);
    // Um quadro do --ease-out (arranque rápido, como o CSS), nunca o salto
    // para o fim.
    expect(back).toBeGreaterThan(0.5 * mid);
    // A volta dura proporcional ao caminho que falta.
    expect(s.dur).toBeCloseTo(AMBIENT_MODE_S * mid, 9);
    let frames = 1;
    while (s.value > 0 && frames < 1000) {
      stepModeTween(s, 0, DT, false);
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(Math.ceil((AMBIENT_MODE_S * mid) / DT) + 1);
  });
});

describe("aparência no ambient", () => {
  it("nos extremos: focused intacto, ambient com os números do CSS antigo", () => {
    expect(ambientLook(0, false)).toEqual({ mix: 0, radius: 0, sat: 1, gain: 1 });
    const a = ambientLook(1, false);
    expect(a.mix).toBe(1);
    expect(a.radius).toBe(1);
    expect(a.sat).toBeCloseTo(AMBIENT_SAT, 12);
    expect(a.gain).toBeCloseTo(AMBIENT_GAIN, 12);
    expect(AMBIENT_SAT).toBe(0.9);
    expect(AMBIENT_GAIN).toBe(0.8);
  });

  it("normal: o desfoque cresce com a mistura; calma: desfoque inteiro, só a mistura anda", () => {
    expect(ambientLook(0.3, false).radius).toBeCloseTo(0.3, 12);
    expect(ambientLook(0.3, true).radius).toBe(1);
    expect(ambientLook(0.3, true).mix).toBeCloseTo(0.3, 12);
  });
});

describe("buffer e kernel do desfoque", () => {
  it("1/4 da tela por eixo, arredondado para cima, nunca zero", () => {
    expect(AMBIENT_SCALE).toBe(4);
    expect(ambientBufferSize(1857, 1048)).toEqual({ w: 465, h: 262 });
    expect(ambientBufferSize(1366, 768)).toEqual({ w: 342, h: 192 });
    expect(ambientBufferSize(1, 1)).toEqual({ w: 1, h: 1 });
    expect(ambientBufferSize(0, 0)).toEqual({ w: 1, h: 1 });
    expect(ambientBufferSize(1857, 1048, 3)).toEqual({ w: 619, h: 350 });
  });

  it("desvio a 1/4 desconta o borrão da redução e da ampliação", () => {
    const s = ambientSigma(4);
    expect(s).toBeGreaterThan(1.9);
    expect(s).toBeLessThan(2);
    // Variância total na tela = 8² (blur(8px)).
    const total = (s * 4) ** 2 + (16 - 1) / 12 + 16 / 6;
    expect(total).toBeCloseTo(64, 9);
  });

  it("kernel normalizado, pares entre os dois texels, simétrico", () => {
    const k = gaussPairs(ambientSigma(4));
    const sum = k.w0 + 2 * k.w.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
    for (let i = 0; i < AMBIENT_PAIRS; i++) {
      expect(k.o[i]).toBeGreaterThanOrEqual(2 * i + 1);
      expect(k.o[i]).toBeLessThanOrEqual(2 * i + 2);
      if (i > 0) expect(k.w[i]).toBeLessThan(k.w[i - 1]);
    }
    // Variância do kernel discreto ≈ σ² (o truncamento a 4σ quase não pesa).
    const sigma = ambientSigma(4);
    let v = 0;
    for (let i = 0; i < AMBIENT_PAIRS; i++) {
      // Cada par equivale aos dois texels originais; reconstrói a variância.
      const g = (x: number) => Math.exp(-(x * x) / (2 * sigma * sigma));
      const i1 = 2 * i + 1, i2 = 2 * i + 2;
      const share = k.w[i] / (g(i1) + g(i2));
      v += 2 * share * (g(i1) * i1 * i1 + g(i2) * i2 * i2);
    }
    expect(Math.sqrt(v)).toBeCloseTo(sigma, 2);
  });
});

describe("curva", () => {
  it("cubicBezier: extremos, linear e o --ease-out", () => {
    const lin = cubicBezier(0, 0, 1, 1);
    for (const x of [0.1, 0.37, 0.5, 0.9]) expect(lin(x)).toBeCloseTo(x, 6);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    // cubic-bezier(0.16, 1, 0.3, 1) em x = 0,5: 0,97178 (conferido por
    // bisseção independente da curva paramétrica).
    expect(easeOut(0.5)).toBeCloseTo(0.97178, 4);
  });
});
