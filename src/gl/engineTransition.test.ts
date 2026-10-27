/* ============================================================
   engineTransition.test.ts — a dissolução de troca de cena e a
   chegada do motor (overdrive, 27/10), com o GL falso.

   Trava: o retrato é a cena que sai redesenhada com dt 0 (o último
   quadro visto), a cena nova desenha desde o primeiro quadro (nada
   espera a transição), tudo que a transição aloca volta no fim, no
   dispose e no resize, troca seca continua sem alocar nada, e a troca
   em rajada não recaptura (sem estalo).
   ============================================================ */

import { describe, it, expect, vi } from "vitest";
import { GlEngine, XFADE_SCENE_S, XFADE_START_S, XFADE_ZOOM, xfadeAt } from "./engine";
import type { SceneKey } from "./meta";
import { createGlSignal } from "./signal";
import type { GlPalette } from "./palette";
import { makeFakeCanvas, makeFakeGl, type FakeGl } from "./__fixtures__/fakeGl";

const PAL: GlPalette = {
  canvas: { r: 0, g: 0, b: 0 },
  ink: { r: 198, g: 99, b: 61 },
  ink2: { r: 216, g: 122, b: 82 },
  soft: { r: 133, g: 130, b: 123 },
};

const spyScene = () => ({ resize: vi.fn(), frame: vi.fn(), onPalette: vi.fn(), dispose: vi.fn() });

function two() {
  const fake = makeFakeGl();
  const { canvas } = makeFakeCanvas(fake.gl);
  const a = spyScene();
  const b = spyScene();
  const engine = new GlEngine(canvas, {
    scenes: { a: { key: "dust", create: () => a }, b: { key: "relief", create: () => b } },
  });
  engine.resize(800, 450);
  engine.setPalette(PAL);
  return { engine, fake, a, b };
}

const live = (fake: FakeGl, kind: string) => [...fake.live].filter((r) => r.kind === kind).length;
const A = "a" as SceneKey;
const B = "b" as SceneKey;

describe("GlEngine: transição", () => {
  it("motor ligando: nasce do preto, sem retrato, e termina sozinho", () => {
    const { engine, fake } = two();
    engine.setScene(A, true);
    expect(engine.transition).toEqual({ kind: "start", progress: 0 });
    expect(live(fake, "texture")).toBe(0);
    const sig = createGlSignal();
    for (let i = 0; i < Math.ceil(XFADE_START_S * 60) + 1; i++) engine.frame(sig, 1 / 60);
    expect(engine.transition).toBeNull();
  });

  it("troca de cena: retrato da que sai (redesenhada com dt 0), liberado no fim", () => {
    const { engine, fake, a } = two();
    engine.setScene(A);
    const sig = createGlSignal();
    engine.frame(sig, 1 / 60);
    const before = a.frame.mock.calls.length;
    engine.setScene(B, true);
    expect(a.frame.mock.calls.length).toBe(before + 1);
    expect(a.frame.mock.calls[before][2]).toBe(0);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(engine.transition?.kind).toBe("scene");
    expect(live(fake, "texture")).toBe(1);
    expect(live(fake, "framebuffer")).toBe(1);
    for (let i = 0; i < Math.ceil(XFADE_SCENE_S * 60) + 1; i++) engine.frame(sig, 1 / 60);
    expect(engine.transition).toBeNull();
    expect(live(fake, "texture")).toBe(0);
    expect(live(fake, "framebuffer")).toBe(0);
  });

  it("a cena nova desenha desde o primeiro quadro da transição", () => {
    const { engine, b } = two();
    engine.setScene(A);
    engine.frame(createGlSignal(), 1 / 60);
    engine.setScene(B, true);
    engine.frame(createGlSignal(), 1 / 60);
    expect(b.frame).toHaveBeenCalledTimes(1);
  });

  it("sem fade: corte seco, nada alocado (medição de cenas, bench)", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.frame(createGlSignal(), 1 / 60);
    engine.setScene(B);
    expect(engine.transition).toBeNull();
    expect(live(fake, "texture")).toBe(0);
  });

  it("troca em rajada: o véu em curso cobre a troca nova, sem recapturar", () => {
    const { engine, b } = two();
    engine.setScene(A);
    engine.frame(createGlSignal(), 1 / 60);
    engine.setScene(B, true);
    engine.frame(createGlSignal(), 1 / 60);
    const drawn = b.frame.mock.calls.length;
    engine.setScene(A, true);
    expect(engine.transition?.kind).toBe("scene");
    expect(engine.transition!.progress).toBeLessThan(0.1);
    // "b" não foi redesenhada para virar retrato.
    expect(b.frame.mock.calls.length).toBe(drawn);
  });

  it("dispose no meio da transição devolve o retrato também", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.frame(createGlSignal(), 1 / 60);
    engine.setScene(B, true);
    engine.dispose();
    expect([...fake.live]).toEqual([]);
  });

  it("resize no meio: o retrato de outro tamanho sai e vira véu preto", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.frame(createGlSignal(), 1 / 60);
    engine.setScene(B, true);
    engine.resize(1024, 600);
    expect(live(fake, "texture")).toBe(0);
    expect(engine.transition?.kind).toBe("start");
  });

  it("versão calma: o retrato não avança (uZoom = 1 em todo quadro)", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.frame(createGlSignal(), 1 / 60);
    engine.setScene(B, true);
    for (let i = 0; i < 30; i++) engine.frame(createGlSignal(), 1 / 60, true);
    const zooms = fake.calls
      .filter(([n, a]) => n === "uniform1f" && (a[0] as { uniform: string }).uniform === "uZoom")
      .map(([, a]) => a[1] as number);
    expect(zooms.length).toBeGreaterThan(20);
    expect(zooms.every((z) => z === 1)).toBe(true);
  });
});

describe("xfadeAt", () => {
  it("começa opaca e termina transparente; o retrato avança 6%, nunca na versão calma", () => {
    expect(xfadeAt(0, false)).toEqual({ alpha: 1, zoom: 1, dim: 1 });
    const end = xfadeAt(1, false);
    expect(end.alpha).toBe(0);
    expect(end.zoom).toBeCloseTo(1 + XFADE_ZOOM, 9);
    for (const p of [0.1, 0.5, 0.9]) expect(xfadeAt(p, true).zoom).toBe(1);
    let prev = 1;
    for (let p = 0; p <= 1; p += 0.05) {
      const a = xfadeAt(p, false).alpha;
      expect(a).toBeLessThanOrEqual(prev + 1e-12);
      prev = a;
    }
  });
});
