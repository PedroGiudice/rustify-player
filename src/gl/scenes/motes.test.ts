/* ============================================================
   motes.test.ts — Poeira na luz: a parte pura (sementes, vento e
   queda integrados na CPU) e o desenho com o GL falso.

   Referência: a classe Motes do lab v2
   (docs/design-refs/fundo-lab-v2/fundo-lab-v2.html). O lab integra
   vento e queda com o dt de parede; o app integra com o avanço do
   relógio virtual dividido por (1 + kick), que no default do
   Tweaks (velocidade 1, beat-sync speed, profundidade 0,55) é
   exatamente o dt de parede — e faz a velocidade do Tweaks valer
   também para o vento e a queda.
   ============================================================ */

import { describe, it, expect, vi } from "vitest";
import {
  MOTES_POINTS,
  createMotesDrift,
  motes,
  motesSeeds,
  stepMotesDrift,
} from "./motes";
import { makeFakeGl } from "../__fixtures__/fakeGl";
import { createGlSignal } from "../signal";
import type { SceneCtx, ScenePalette } from "../scene";

const f3 = (r: number, g: number, b: number) => new Float32Array([r, g, b]);
const PAL: ScenePalette = { canvas: f3(0, 0, 0), ink: f3(0.78, 0.39, 0.24), ink2: f3(0.85, 0.48, 0.32), soft: f3(0.52, 0.51, 0.48) };

/** A mesma conta do frame() da classe Motes do lab, com dt de parede. */
function labStep(lab: { wx: number; wy: number; fall: number }, clock: number, beat: number, dt: number) {
  const dir = 0.9 + 0.4 * Math.sin(clock * 0.013);
  const gust = 0.01 + 0.055 * beat;
  lab.wx += Math.cos(dir) * gust * dt;
  lab.wy += Math.sin(dir) * gust * 0.35 * dt;
  lab.fall += dt * 0.004;
}

describe("Poeira na luz: sementes", () => {
  it("5.000 partículas com 4 sementes cada, todas em [0, 1)", () => {
    const s = motesSeeds(MOTES_POINTS);
    expect(MOTES_POINTS).toBe(5000);
    expect(s.length).toBe(MOTES_POINTS * 4);
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gerador próprio e determinístico: duas nuvens iguais", () => {
    expect(Array.from(motesSeeds(64))).toEqual(Array.from(motesSeeds(64)));
  });
});

describe("Poeira na luz: vento e queda", () => {
  it("no default do Tweaks anda exatamente como o lab (dt de parede)", () => {
    const st = createMotesDrift();
    const lab = { wx: 0, wy: 0, fall: 0 };
    let clock = 0;
    stepMotesDrift(st, clock, 0); // primeiro quadro: só ancora o relógio
    for (let f = 0; f < 1200; f++) {
      const dt = f % 7 === 0 ? 1 / 30 : 1 / 60;
      const beat = (f % 40) / 40; // kick subindo e caindo
      clock += dt * (1 + beat); // velocidade 1, modo speed, ganho 1
      stepMotesDrift(st, clock, beat);
      labStep(lab, clock, beat, dt);
    }
    expect(st.windX).toBeCloseTo(lab.wx, 12);
    expect(st.windY).toBeCloseTo(lab.wy, 12);
    expect(st.fall).toBeCloseTo(lab.fall, 12);
    expect(st.windX).toBeGreaterThan(0);
  });

  it("primeiro quadro não salta, mesmo com o relógio já adiantado", () => {
    const st = createMotesDrift();
    stepMotesDrift(st, 600, 1);
    expect(st.windX).toBe(0);
    expect(st.windY).toBe(0);
    expect(st.fall).toBe(0);
  });

  it("velocidade 0 no Tweaks (relógio parado) congela o vento e a queda", () => {
    const st = createMotesDrift();
    stepMotesDrift(st, 5, 0);
    for (let f = 0; f < 60; f++) stepMotesDrift(st, 5, 1);
    expect(st.windX).toBe(0);
    expect(st.fall).toBe(0);
  });

  it("velocidade 2 no Tweaks dobra o vento e a queda", () => {
    const a = createMotesDrift();
    const b = createMotesDrift();
    stepMotesDrift(a, 0, 0);
    stepMotesDrift(b, 0, 0);
    let ca = 0;
    let cb = 0;
    for (let f = 0; f < 30; f++) {
      ca += (1 / 60) * 1.5; // kick 0,5
      cb += (1 / 60) * 2 * 1.5;
      stepMotesDrift(a, ca, 0.5);
      stepMotesDrift(b, cb, 0.5);
    }
    expect(b.fall).toBeCloseTo(2 * a.fall, 12);
    expect(Math.hypot(b.windX, b.windY)).toBeGreaterThan(1.9 * Math.hypot(a.windX, a.windY));
  });

  it("CMR-267: o avanço de um quadro não depende do tempo de sessão", () => {
    const early = createMotesDrift();
    const late = createMotesDrift();
    stepMotesDrift(early, 0, 0);
    let clock = 0;
    stepMotesDrift(late, clock, 0);
    for (let f = 0; f < 36000; f++) {
      clock += 1 / 60;
      stepMotesDrift(late, clock, 0);
    }
    const dt = 1 / 60;
    const beat = 0.8;
    const before = [early.windX, early.windY, early.fall, late.windX, late.windY, late.fall];
    stepMotesDrift(early, dt * (1 + beat), beat);
    stepMotesDrift(late, clock + dt * (1 + beat), beat);
    const gust = (dx: number, dy: number) => Math.hypot(dx, dy / 0.35);
    const gEarly = gust(early.windX - before[0], early.windY - before[1]);
    const gLate = gust(late.windX - before[3], late.windY - before[4]);
    expect(gEarly).toBeCloseTo((0.01 + 0.055 * beat) * dt, 12);
    expect(gLate).toBeCloseTo(gEarly, 12);
    expect(early.fall - before[2]).toBeCloseTo(late.fall - before[5], 12);
  });

  it("relógio que volta (remontagem) não anda para trás", () => {
    const st = createMotesDrift();
    stepMotesDrift(st, 10, 0);
    stepMotesDrift(st, 9, 0);
    expect(st.fall).toBe(0);
  });
});

describe("Poeira na luz: desenho", () => {
  function mount() {
    const fake = makeFakeGl();
    // O fullscreen entra no mesmo registro de chamadas para travar a ordem.
    const fullscreen = vi.fn(() => {
      fake.calls.push(["fullscreen", []]);
    });
    const ctx: SceneCtx = {
      gl: fake.gl,
      caps: { colorBufferFloat: false, maxPointSize: 64 },
      bindOutput: vi.fn(),
      fullscreen,
    };
    const scene = motes.create(ctx);
    return { fake, fullscreen, scene };
  }

  it("compila os dois programas antes de alocar buffer e VAO", () => {
    const { fake } = mount();
    const names = fake.calls.map((c) => c[0]);
    const lastProgram = names.lastIndexOf("linkProgram");
    expect(names.filter((n) => n === "linkProgram").length).toBe(2);
    expect(names.indexOf("createBuffer")).toBeGreaterThan(lastProgram);
    expect(names.indexOf("createVertexArray")).toBeGreaterThan(lastProgram);
  });

  it("facho opaco em tela cheia e depois 5.000 pontos aditivos (ONE, ONE)", () => {
    const { fake, fullscreen, scene } = mount();
    scene.resize(1366, 768);
    const sig = { ...createGlSignal(), clock: 1, low: 0.5, high: 0.4, beat: 0.3 };
    fake.calls.length = 0;
    scene.frame(sig, PAL, 1 / 60, 1366, 768);
    expect(fullscreen).toHaveBeenCalledTimes(1);
    const gl = fake.gl;
    const draws = fake.calls.filter((c) => c[0] === "drawArrays");
    expect(draws).toEqual([["drawArrays", [gl.POINTS, 0, MOTES_POINTS]]]);
    expect(fake.calls.some((c) => c[0] === "blendFunc" && c[1][0] === gl.ONE && c[1][1] === gl.ONE)).toBe(true);
    // Estado devolvido: blend desligado e nenhum VAO ligado.
    const lastBlend = fake.calls.filter((c) => c[0] === "enable" || c[0] === "disable").pop();
    expect(lastBlend).toEqual(["disable", [gl.BLEND]]);
    expect(fake.calls.filter((c) => c[0] === "bindVertexArray").pop()).toEqual(["bindVertexArray", [null]]);
    // O facho (sem blend) vem antes dos pontos (com blend).
    const names = fake.calls.map((c) => c[0]);
    expect(names.indexOf("fullscreen")).toBeLessThan(names.indexOf("blendFunc"));
    expect(names.indexOf("blendFunc")).toBeLessThan(names.indexOf("drawArrays"));
  });

  it("vento e queda entram como uniforms integrados, não como relógio", () => {
    const { fake, scene } = mount();
    const sig = { ...createGlSignal(), clock: 0, beat: 0.5 };
    scene.frame(sig, PAL, 1 / 60, 800, 450);
    sig.clock += (1 / 60) * 1.5;
    fake.calls.length = 0;
    scene.frame(sig, PAL, 1 / 60, 800, 450);
    const set = (name: string) =>
      fake.calls.filter((c) => (c[1][0] as { uniform?: string } | null)?.uniform === name).pop();
    const wind = set("uWind");
    const fall = set("uFall");
    expect(wind?.[0]).toBe("uniform2f");
    expect(fall?.[0]).toBe("uniform1f");
    expect(fall?.[1][1]).toBeCloseTo(0.004 / 60, 12);
    expect(wind?.[1][1] as number).toBeGreaterThan(0);
  });

  it("dispose apaga programas, buffer e VAO", () => {
    const { fake, scene } = mount();
    scene.dispose();
    expect([...fake.live].filter((r) => r.kind !== "shader")).toEqual([]);
  });
});
