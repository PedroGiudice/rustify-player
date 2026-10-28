/* ============================================================
   host.test.ts — o laço que hospeda o motor: toda falha vira
   glStatus.ok = false (o App volta ao 2D), nunca tela preta.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { INK_TAU, inkMorphTau, startGlHost } from "./host";
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

/* ---------- modo ambient: a ligação host -> motor (B6) ---------- */

const uniforms = (fake: ReturnType<typeof makeFakeGl>, fn: string, name: string) =>
  fake.calls.filter(([n, a]) => n === fn && (a[0] as { uniform: string } | null)?.uniform === name).map(([, a]) => a.slice(1) as number[]);

describe("startGlHost: modo do fundo", () => {
  function hostMode(canvas: HTMLCanvasElement, mode: () => "focused" | "ambient", extra: { calm?: () => boolean; reduced?: () => boolean } = {}) {
    return startGlHost({
      canvas,
      tag: "[teste]",
      scene: () => "dust",
      palette: () => ({ ...PAL, back: { r: 43, g: 43, b: 42 } }),
      cfg: () => DEFAULT_GL_CFG,
      bands: () => ({ low: 0.5, mid: 0.5, high: 0.5, fresh: true }),
      mode,
      ...extra,
    });
  }

  it("ambient chega ao motor: desfoca na GPU e mistura com o fundo do tema", () => {
    const fake = makeFakeGl();
    const { canvas } = makeFakeCanvas(fake.gl);
    const stop = hostMode(canvas, () => "ambient");
    vi.advanceTimersByTime(50);
    expect(uniforms(fake, "uniform1f", "uMix").at(-1)).toEqual([1]);
    const back = uniforms(fake, "uniform3f", "uBack").at(-1)!;
    expect(back[0]).toBeCloseTo(43 / 255, 2);
    stop();
  });

  it("sem `mode` (mobile): nenhum passe do ambient nem buffer dele", () => {
    const fake = makeFakeGl();
    const { canvas } = makeFakeCanvas(fake.gl);
    const stop = host(canvas, () => "dust");
    vi.advanceTimersByTime(2000);
    expect(uniforms(fake, "uniform1f", "uMix")).toEqual([]);
    expect(fake.count("texImage2D")).toBe(0);
    stop();
  });

  it("com `mode`, os buffers já existem antes da primeira troca", () => {
    const fake = makeFakeGl();
    const { canvas } = makeFakeCanvas(fake.gl);
    let mode: "focused" | "ambient" = "focused";
    const stop = hostMode(canvas, () => mode);
    vi.advanceTimersByTime(1000);
    const allocated = fake.count("texImage2D");
    expect(allocated).toBe(3);
    mode = "ambient";
    vi.advanceTimersByTime(50);
    expect(fake.count("texImage2D")).toBe(allocated);
    stop();
  });

  it("reduzir animação vale para a troca mesmo com knobs fora do padrão (calma da cena desligada)", () => {
    const fake = makeFakeGl();
    const { canvas } = makeFakeCanvas(fake.gl);
    let mode: "focused" | "ambient" = "focused";
    const stop = hostMode(canvas, () => mode, { calm: () => false, reduced: () => true });
    vi.advanceTimersByTime(50);
    mode = "ambient";
    vi.advanceTimersByTime(100);
    // Versão calma da troca: o desfoque entra inteiro desde o primeiro
    // quadro (só a mistura anda), sem rampa de raio.
    const dirs = uniforms(fake, "uniform2f", "uDir").filter((v) => v[1] === 0).map((v) => v[0]);
    expect(dirs.length).toBeGreaterThan(1);
    expect(new Set(dirs).size).toBe(1);
    const mixes = uniforms(fake, "uniform1f", "uMix").map((v) => v[0]);
    expect(mixes.at(-1)!).toBeLessThan(1);
    stop();
  });
});

describe("inkMorphTau: o tau do morph de cor segue --bg-ink-morph", () => {
  it("valor anunciado pelo ciclo da paleta vale; ausente ou absurdo cai no padrão", () => {
    expect(inkMorphTau(3.5)).toBe(3.5); // ciclo da paleta (lib/adaptiveInk.ts)
    expect(inkMorphTau(null)).toBe(INK_TAU);
    expect(inkMorphTau(undefined)).toBe(INK_TAU);
    expect(inkMorphTau(0)).toBe(INK_TAU);
    expect(inkMorphTau(-1)).toBe(INK_TAU);
    expect(inkMorphTau(Number.NaN)).toBe(INK_TAU);
    expect(inkMorphTau(4000)).toBe(INK_TAU); // "4000ms" lido por parseFloat
  });
});
