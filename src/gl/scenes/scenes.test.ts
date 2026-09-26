/* ============================================================
   scenes.test.ts — a parte pura das cenas portadas (sem GL).

   A regra de movimento (CMR-267): o sinal muda VELOCIDADE, a posição
   é integrada. Aqui trava-se isso na Órbitas (zoff e giro em z) e a
   ordem de sorteio da Poeira (a mesma do three).

   Relevo (26/09): as variantes de estilo com um GL falso — o original
   não muda, trocar de estilo entre quadros não vaza nem aloca depois
   da primeira passada, e as variantes novas têm brilho único.
   ============================================================ */

import { afterEach, describe, it, expect } from "vitest";
import { dustCloud } from "./dust";
import {
  ORBIT_GAP,
  ORBIT_RINGS,
  ORBIT_STRIDE,
  makeOrbitRings,
  stepOrbits,
  type OrbitState,
} from "./orbits";
import { createGlSignal } from "../signal";
import type { SceneCtx, ScenePalette } from "../scene";
import { RELIEF_GRID, RELIEF_ORIGINAL_SRC, RELIEF_SURFACE_GRID, relief } from "./relief";
import { wireframeIndices } from "../geometry";
import {
  RELIEF_DEFAULT,
  RELIEF_LINE_KEYS,
  setGlReliefOverride,
  setGlReliefStyle,
  type ReliefStyle,
} from "../meta";
import { makeFakeGl, type FakeGl } from "../__fixtures__/fakeGl";

const f3 = (r: number, g: number, b: number) => new Float32Array([r, g, b]);
const PAL: ScenePalette = { canvas: f3(0, 0, 0), ink: f3(1, 0, 0), ink2: f3(0, 1, 0), soft: f3(0, 0, 1) };

describe("Poeira: nuvem", () => {
  it("sorteia x, y, z e semente por ponto, nessa ordem, nas faixas do three", () => {
    const seq = [0.5, 1, 0, 0.25, 0, 0.5, 1, 0.75];
    let i = 0;
    const { pos, seed } = dustCloud(2, () => seq[i++]);
    // Ponto 0: x=(0,5-0,5)*70, y=(1-0,5)*40, z=-0*90, semente 0,25.
    // Ponto 1: x=(0-0,5)*70, y=(0,5-0,5)*40, z=-1*90, semente 0,75.
    expect(Array.from(pos, (v) => v + 0)).toEqual([0, 20, 0, -35, 0, -90]);
    expect(Array.from(seed)).toEqual([0.25, 0.75]);
  });

  it("fica dentro do volume 70 x 40 x 90", () => {
    const { pos } = dustCloud(500);
    for (let i = 0; i < 500; i++) {
      expect(Math.abs(pos[i * 3])).toBeLessThanOrEqual(35);
      expect(Math.abs(pos[i * 3 + 1])).toBeLessThanOrEqual(20);
      expect(pos[i * 3 + 2]).toBeLessThanOrEqual(0);
      expect(pos[i * 3 + 2]).toBeGreaterThanOrEqual(-90);
    }
  });
});

describe("Órbitas: passo", () => {
  const fresh = (): OrbitState => ({ rings: makeOrbitRings(), zoff: 0 });

  it("40 anéis, z sempre dentro do túnel e nunca além da câmera", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    const sig = createGlSignal();
    const L = ORBIT_RINGS * ORBIT_GAP;
    for (let f = 0; f < 600; f++) {
      sig.clock += 1 / 60;
      sig.low = (f % 30) / 30;
      stepOrbits(st, sig, 1 / 60, PAL, out);
      for (let r = 0; r < ORBIT_RINGS; r++) {
        const z = out[r * ORBIT_STRIDE];
        expect(z).toBeLessThanOrEqual(12 + 1e-6);
        expect(z).toBeGreaterThan(12 - L - 1e-6);
      }
    }
  });

  it("graves mudam a VELOCIDADE do túnel: o avanço de um quadro não depende do tempo de sessão", () => {
    const a = fresh();
    const b = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    const sig = createGlSignal();
    // b já rodou 10 minutos de sessão; a está no começo.
    for (let f = 0; f < 36000; f++) stepOrbits(b, { ...sig, clock: f / 60 }, 1 / 60, PAL, out);
    const za = a.zoff, zb = b.zoff;
    const loud = { ...sig, low: 1 };
    stepOrbits(a, loud, 1 / 60, PAL, out);
    stepOrbits(b, loud, 1 / 60, PAL, out);
    expect(a.zoff - za).toBeCloseTo((2.5 + 4) / 60, 9);
    expect(b.zoff - zb).toBeCloseTo((2.5 + 4) / 60, 9);
  });

  it("giro em z acumula dt x spin x (1 + 2 médios)", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    const sig = { ...createGlSignal(), mid: 0.5 };
    stepOrbits(st, sig, 0.1, PAL, out);
    const r0 = st.rings[0];
    expect(r0.rotZ).toBeCloseTo(0.1 * r0.spin * 2, 9);
    expect(out[3]).toBeCloseTo(r0.rotZ, 6);
  });

  it("cor: anel múltiplo de 3 usa ink2, os outros ink; agudos puxam pro soft com a profundidade", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    stepOrbits(st, createGlSignal(), 0, PAL, out);
    expect(Array.from(out.slice(4, 7))).toEqual([0, 1, 0]); // anel 0 -> ink2
    expect(Array.from(out.slice(ORBIT_STRIDE + 4, ORBIT_STRIDE + 7))).toEqual([1, 0, 0]); // anel 1 -> ink
    const hot = { ...createGlSignal(), high: 1 };
    stepOrbits(fresh(), hot, 0, PAL, out);
    expect(out[ORBIT_STRIDE + 6]).toBeGreaterThan(0); // puxou pro soft (azul)
  });

  it("opacidade: mais funda (perto da câmera) = mais opaca; agudos acendem", () => {
    const st = fresh();
    const out = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
    stepOrbits(st, createGlSignal(), 0, PAL, out);
    const quiet = Array.from({ length: ORBIT_RINGS }, (_, r) => [out[r * ORBIT_STRIDE], out[r * ORBIT_STRIDE + 7]]);
    quiet.sort((p, q) => p[0] - q[0]);
    expect(quiet[quiet.length - 1][1]).toBeGreaterThan(quiet[0][1]);
    // Opacidade = (0,08 + 0,6·prof²)·(0,4 + 0,6·agudos): agudos no máximo = 2,5x.
    stepOrbits(fresh(), { ...createGlSignal(), high: 1 }, 0, PAL, out);
    const loud0 = out[7];
    stepOrbits(fresh(), createGlSignal(), 0, PAL, out);
    expect(loud0).toBeCloseTo(out[7] / 0.4, 6);
  });
});

/* ---------- Relevo: variantes de estilo (26/09) ---------- */

describe("Relevo: variantes de estilo", () => {
  const ALL_STYLES: ReliefStyle[] = [];
  for (const lines of RELIEF_LINE_KEYS)
    for (const shape of ["detailed", "smooth"] as const)
      for (const surface of ["open", "solid"] as const) ALL_STYLES.push({ lines, shape, surface });

  const ctxOf = (fake: FakeGl): SceneCtx => ({
    gl: fake.gl,
    caps: { colorBufferFloat: false, maxPointSize: 64 },
    bindOutput: () => {},
    fullscreen: () => {},
  });
  const sig = () => ({ ...createGlSignal(), clock: 3.2, low: 0.6, mid: 0.4, high: 0.5, beat: 0.3 });
  const creates = (fake: FakeGl) => fake.calls.filter((c) => c[0].startsWith("create")).length;
  const lastDraw = (fake: FakeGl) => [...fake.calls].reverse().find((c) => c[0] === "drawElements")![1];
  const sources = (fake: FakeGl) => fake.calls.filter((c) => c[0] === "shaderSource").map((c) => c[1][1] as string);
  const uniform1f = (fake: FakeGl, name: string) =>
    [...fake.calls].reverse().find((c) => c[0] === "uniform1f" && (c[1][0] as { uniform: string } | null)?.uniform === name);
  /** FNV-1a de 32 bits (sem dependência de node:crypto nos tipos). */
  const sha = (s: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `${(h >>> 0).toString(16)}:${s.length}`;
  };

  afterEach(() => {
    setGlReliefOverride(null);
    setGlReliefStyle(RELIEF_DEFAULT);
  });

  it("original: fontes intactas (paridade com o three) e o mesmo desenho de sempre", () => {
    // Hash das fontes como estavam em c5581c2, antes das variantes. Se
    // mudou, o original deixou de ser a referência: não é pra mudar.
    expect(sha(RELIEF_ORIGINAL_SRC.vs)).toBe("68c9b300:1437");
    expect(sha(RELIEF_ORIGINAL_SRC.fs)).toBe("f62149ef:327");
    const fake = makeFakeGl();
    setGlReliefOverride({ lines: "original", shape: "smooth", surface: "solid" });
    const s = relief.create(ctxOf(fake));
    s.resize(1366, 768);
    s.frame(sig(), PAL, 1 / 60, 1366, 768);
    expect(sources(fake)).toEqual([RELIEF_ORIGINAL_SRC.vs, RELIEF_ORIGINAL_SRC.fs]);
    const { gx, gy } = RELIEF_GRID;
    expect(lastDraw(fake)).toEqual([fake.gl.LINES, wireframeIndices(gx, gy).length, fake.gl.UNSIGNED_SHORT, 0]);
    // Blending alfa do three, mesmo com surface "solid" pedido (ignorado).
    expect(fake.calls.some((c) => c[0] === "blendFuncSeparate" && c[1][0] === fake.gl.SRC_ALPHA)).toBe(true);
    expect(uniform1f(fake, "uSolid")).toBeUndefined();
    s.dispose();
    expect([...fake.live]).toEqual([]);
  });

  it("todas as combinações: troca entre quadros sem vazar, sem alocar depois da 1ª passada, dispose zera", () => {
    const fake = makeFakeGl();
    const s = relief.create(ctxOf(fake));
    s.resize(1857, 1048);
    // 1ª passada: metade pelo override da medição, metade pela preferência.
    ALL_STYLES.forEach((st, i) => {
      if (i % 2) {
        setGlReliefOverride(null);
        setGlReliefStyle({ ...st });
      } else setGlReliefOverride({ ...st });
      s.frame(sig(), PAL, 1 / 60, 1857, 1048);
    });
    const live = (k: string) => [...fake.live].filter((r) => r.kind === k).length;
    // original + mesh x2 + (ridges, contours, weave) x2 formas = 9;
    // open/solid dividem o programa (uniform uSolid).
    expect(live("program")).toBe(9);
    expect(live("vertexArray")).toBe(2);
    expect(live("buffer")).toBe(4);
    expect(live("shader")).toBe(0);
    const before = creates(fake);
    // 2ª passada, em outra ordem e com objetos novos: nada novo no GL.
    for (const st of [...ALL_STYLES].reverse()) {
      setGlReliefOverride({ ...st });
      s.frame(sig(), PAL, 1 / 60, 1857, 1048);
    }
    expect(creates(fake)).toBe(before);
    s.dispose();
    expect([...fake.live]).toEqual([]);
  });

  it("brilho único: nenhuma variante nova usa altura, sinal ou as cores 2/3 na cor", () => {
    const fake = makeFakeGl();
    const s = relief.create(ctxOf(fake));
    s.resize(800, 450);
    for (const st of ALL_STYLES) {
      setGlReliefOverride(st);
      s.frame(sig(), PAL, 1 / 60, 800, 450);
    }
    const fsNew = [...new Set(sources(fake))].filter((src) => src.includes("outColor") && src !== RELIEF_ORIGINAL_SRC.fs);
    expect(fsNew.length).toBe(4); // mesh + ridges + contours + weave
    for (const fs of fsNew) {
      expect(fs).not.toMatch(/uInk2|uSoft|uHigh|uBeat|uLow|uMid|uTime/);
      expect(fs).toMatch(/outColor=vec4\((uInk|mix\(uInk)/);
    }
    // Só as curvas de nível leem a altura, e como coordenada da linha.
    expect(fsNew.filter((fs) => /\bvH\b/.test(fs)).length).toBe(1);
    // Regra do relógio (CMR-267): nenhum shader multiplica uTime por sinal.
    for (const src of sources(fake)) expect(src).not.toMatch(/uTime\s*\*\s*\(/);
    s.dispose();
  });

  it("forma: smooth usa fbm3 (3 oitavas), detailed o fbm de 5", () => {
    // Cena nova por estilo: o construtor compila a variante pedida.
    const vsOf = (st: ReliefStyle) => {
      const fake = makeFakeGl();
      setGlReliefOverride(st);
      relief.create(ctxOf(fake)).dispose();
      return sources(fake)[0];
    };
    for (const lines of ["mesh", "ridges", "contours", "weave"] as const) {
      const sm = vsOf({ lines, shape: "smooth", surface: "open" });
      const de = vsOf({ lines, shape: "detailed", surface: "open" });
      expect(sm).toMatch(/float h=fbm3\(q\)/);
      expect(sm).toMatch(/i<3/);
      expect(de).toMatch(/float h=fbm\(q\)/);
      expect(de).not.toMatch(/fbm3/);
    }
  });

  it("por pixel: triângulos da malha densa; solid sem blending e uSolid=1, open com blending alfa", () => {
    const fake = makeFakeGl();
    const s = relief.create(ctxOf(fake));
    s.resize(800, 450);
    const { gx, gy } = RELIEF_SURFACE_GRID;
    const blendOn = (from: number) => fake.calls.slice(from).some((c) => c[0] === "enable" && c[1][0] === fake.gl.BLEND);
    for (const lines of ["ridges", "contours", "weave"] as const) {
      setGlReliefOverride({ lines, shape: "smooth", surface: "solid" });
      let n = fake.calls.length;
      s.frame(sig(), PAL, 1 / 60, 800, 450);
      expect(lastDraw(fake)).toEqual([fake.gl.TRIANGLES, gx * gy * 6, fake.gl.UNSIGNED_SHORT, 0]);
      expect(blendOn(n)).toBe(false);
      expect(uniform1f(fake, "uSolid")![1][1]).toBe(1);

      setGlReliefOverride({ lines, shape: "smooth", surface: "open" });
      n = fake.calls.length;
      s.frame(sig(), PAL, 1 / 60, 800, 450);
      expect(blendOn(n)).toBe(true);
      expect(uniform1f(fake, "uSolid")![1][1]).toBe(0);
    }
    // mesh: malha do wireframe, sempre vazada.
    setGlReliefOverride({ lines: "mesh", shape: "detailed", surface: "solid" });
    const n = fake.calls.length;
    s.frame(sig(), PAL, 1 / 60, 800, 450);
    expect(lastDraw(fake)[0]).toBe(fake.gl.LINES);
    expect(blendOn(n)).toBe(true);
    expect(uniform1f(fake, "uSolid")![1][1]).toBe(0);
    s.dispose();
  });

  it("todos os programas fixam position em 0 (um VAO por malha serve a todos)", () => {
    const fake = makeFakeGl();
    const s = relief.create(ctxOf(fake));
    s.resize(800, 450);
    for (const st of ALL_STYLES) {
      setGlReliefOverride(st);
      s.frame(sig(), PAL, 1 / 60, 800, 450);
    }
    const binds = fake.calls.filter((c) => c[0] === "bindAttribLocation");
    expect(binds.length).toBe(9);
    for (const b of binds) expect([b[1][1], b[1][2]]).toEqual([0, "position"]);
    s.dispose();
  });
});
