import { describe, it, expect } from "vitest";
import { lookAt, mat4, multiply, perspective, transformPoint, translation } from "./mat4";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, d = 5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], d);
};

describe("mat4.perspective", () => {
  it("bate com o makePerspective do three (fov vertical em graus)", () => {
    const m = perspective(mat4(), 55, 16 / 9, 0.1, 200);
    const f = 1 / Math.tan((55 * Math.PI) / 360);
    close(m, [
      f / (16 / 9), 0, 0, 0,
      0, f, 0, 0,
      0, 0, -(200 + 0.1) / (200 - 0.1), -1,
      0, 0, (-2 * 200 * 0.1) / (200 - 0.1), 0,
    ]);
  });

  it("near vai a z=-1 e far a z=+1 em NDC", () => {
    const m = perspective(mat4(), 60, 1, 0.5, 100);
    const n = transformPoint(m, [0, 0, -0.5]);
    const f = transformPoint(m, [0, 0, -100]);
    expect(n[2] / n[3]).toBeCloseTo(-1, 6);
    expect(f[2] / f[3]).toBeCloseTo(1, 6);
  });
});

describe("mat4.lookAt", () => {
  it("leva o olho à origem e o alvo ao eixo -z", () => {
    const eye = [1.2, 0.8, 10] as const;
    const target = [0, 0, -30] as const;
    const v = lookAt(mat4(), eye, target);
    close(transformPoint(v, eye).slice(0, 3), [0, 0, 0]);
    const t = transformPoint(v, target);
    const dist = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
    close(t.slice(0, 3), [0, 0, -dist], 4);
  });

  it("a rotação é ortonormal e mantém o 'para cima' no plano y", () => {
    const v = lookAt(mat4(), [4, 13, 42], [0, -2, -20]);
    const col = (i: number) => [v[i], v[i + 4], v[i + 8]];
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const ca = col(a), cb = col(b);
      expect(ca[0] * cb[0] + ca[1] * cb[1] + ca[2] * cb[2]).toBeCloseTo(0, 6);
    }
    for (const i of [0, 1, 2]) expect(Math.hypot(...col(i))).toBeCloseTo(1, 6);
    // Um ponto acima do alvo aparece acima (y > 0) na vista.
    expect(transformPoint(v, [0, 10, -20])[1]).toBeGreaterThan(0);
  });

  it("não quebra com up paralelo à direção", () => {
    const v = lookAt(mat4(), [0, 10, 0], [0, 0, 0]);
    expect(Array.from(v).every(Number.isFinite)).toBe(true);
  });
});

describe("mat4.translation / multiply", () => {
  it("câmera sem rotação: a vista é a translação por -posição", () => {
    const v = translation(mat4(), -0.6, -0.4, -12);
    close(transformPoint(v, [0.6, 0.4, 12]).slice(0, 3), [0, 0, 0]);
  });

  it("multiply compõe na ordem a*b e aceita saída aliasada", () => {
    const a = translation(mat4(), 1, 2, 3);
    const b = translation(mat4(), 10, 20, 30);
    const out = multiply(a, a, b);
    close(transformPoint(out, [0, 0, 0]).slice(0, 3), [11, 22, 33]);
  });
});
