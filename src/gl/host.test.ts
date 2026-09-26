/* ============================================================
   host.test.ts — o laço que hospeda o motor: toda falha vira
   glStatus.ok = false (o App volta ao 2D), nunca tela preta.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startGlHost } from "./host";
import { glActiveScene, glStatus, resetGlStatus, setGlActiveScene, type SceneKey } from "./meta";
import { DEFAULT_GL_CFG } from "./signal";
import type { GlPalette } from "./palette";
import { makeFakeCanvas, makeFakeGl } from "./__fixtures__/fakeGl";

const PAL: GlPalette = {
  canvas: { r: 0, g: 0, b: 0 },
  ink: { r: 198, g: 99, b: 61 },
  ink2: { r: 216, g: 122, b: 82 },
  soft: { r: 133, g: 130, b: 123 },
};

/** Trecho que só existe no fragment shader da Nébula. */
const NEBULA_FS = "fbm(p+2.0*r)";

function host(canvas: HTMLCanvasElement, scene: () => SceneKey) {
  return startGlHost({
    canvas,
    tag: "[teste]",
    scene,
    palette: () => PAL,
    cfg: () => DEFAULT_GL_CFG,
    bands: () => ({ low: 0.5, mid: 0.5, high: 0.5, fresh: true }),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetGlStatus();
  setGlActiveScene(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startGlHost", () => {
  it("sobe, publica ok + cena ativa, mede fps e desmonta soltando o contexto", () => {
    const fake = makeFakeGl();
    const { canvas } = makeFakeCanvas(fake.gl);
    const stop = host(canvas, () => "nebula");
    expect(glStatus()).toMatchObject({ ok: true, renderer: "Fake GPU" });
    expect(glActiveScene()).toBe("nebula");
    expect(canvas.width).toBe(800);
    vi.advanceTimersByTime(1200);
    expect(glStatus().fps).toBeGreaterThan(0);
    stop();
    expect(glActiveScene()).toBeNull();
    expect(fake.loseContext.calls).toBe(1);
  });

  it("sem WebGL2: ok = false com o motivo", () => {
    const { canvas } = makeFakeCanvas(null);
    host(canvas, () => "dust")();
    expect(glStatus()).toMatchObject({ ok: false, error: expect.stringMatching(/WebGL2/) });
  });

  it("shader que não compila: ok = false com a mensagem do driver", () => {
    const fake = makeFakeGl({ failCompile: (src) => (src.includes(NEBULA_FS) ? "ERROR: 0:9: boom" : null) });
    const { canvas } = makeFakeCanvas(fake.gl);
    host(canvas, () => "nebula");
    expect(glStatus().ok).toBe(false);
    expect(glStatus().error).toMatch(/^cena nebula: shader de fragmento não compilou: ERROR: 0:9: boom/);
    expect(glActiveScene()).toBeNull();
  });

  it("troca de cena em tempo real; a que falha derruba para o 2D", () => {
    const fake = makeFakeGl({ failCompile: (src) => (src.includes(NEBULA_FS) ? "ERROR: 0:1: x" : null) });
    const { canvas } = makeFakeCanvas(fake.gl);
    let want: SceneKey = "dust";
    host(canvas, () => want);
    vi.advanceTimersByTime(50);
    want = "orbits";
    vi.advanceTimersByTime(50);
    expect(glActiveScene()).toBe("orbits");
    expect(glStatus().ok).toBe(true);
    want = "nebula";
    vi.advanceTimersByTime(50);
    expect(glStatus().ok).toBe(false);
    expect(glActiveScene()).toBeNull();
  });

  it("contexto perdido pelo driver: ok = false", () => {
    const fake = makeFakeGl();
    const { canvas, fire } = makeFakeCanvas(fake.gl);
    host(canvas, () => "relief");
    fire("webglcontextlost");
    expect(glStatus()).toMatchObject({ ok: false, error: expect.stringMatching(/perdido/) });
  });
});
