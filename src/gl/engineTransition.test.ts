/* ============================================================
   engineTransition.test.ts — a dissolução de troca de cena e a
   chegada do motor (overdrive, 27/10), com o GL falso.

   Trava: o retrato é a cena que sai redesenhada com dt 0 (o último
   quadro visto), a cena nova desenha desde o primeiro quadro (nada
   espera a transição), tudo que a transição aloca volta no fim, no
   dispose e no resize, troca seca continua sem alocar nada, e a troca
   em rajada não recaptura (sem estalo). Modo ambient (B6): focused
   não aloca nem desvia da tela, ambient desenha a cena num buffer e
   compõe desfocado, a troca anda 420 ms, a calma só dissolve, resize
   realoca e falta de memória não derruba o motor.
   ============================================================ */

import { describe, it, expect, vi } from "vitest";
import { AMB_SETTLE_FRAMES, GlEngine, XFADE_SCENE_S, XFADE_START_S, XFADE_ZOOM, xfadeAt } from "./engine";
import type { SceneKey } from "./meta";
import { createGlSignal } from "./signal";
import type { GlPalette } from "./palette";
import { makeFakeCanvas, makeFakeGl, type FakeGl } from "./__fixtures__/fakeGl";
import { AMBIENT_MODE_S } from "./ambient";

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

/* ---------- modo ambient (B6, 28/10) ---------- */

/** Valores de um uniform escalar/vetorial gravados pelo GL falso. */
const uniformCalls = (fake: FakeGl, fn: string, name: string) =>
  fake.calls.filter(([n, a]) => n === fn && (a[0] as { uniform: string } | null)?.uniform === name).map(([, a]) => a.slice(1) as number[]);

/** Framebuffers ligados desde a chamada `from` (null = a tela). */
const bindsSince = (fake: FakeGl, from: number) =>
  fake.calls.slice(from).filter(([n]) => n === "bindFramebuffer").map(([, a]) => a[1]);

describe("GlEngine: modo ambient", () => {
  it("focused (padrão, e o mobile que nunca chama setMode): nada alocado, cena direto na tela", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(engine.ambient).toBe(0);
    expect(live(fake, "texture")).toBe(0);
    expect(bindsSince(fake, from).every((fb) => fb === null)).toBe(true);
    expect(uniformCalls(fake, "uniform1f", "uMix")).toEqual([]);
  });

  it("app que abre fora do Now Playing já nasce desfocado (sem rampa)", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.setMode("ambient");
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(engine.ambient).toBe(1);
    // Tela cheia + dois buffers a 1/4.
    expect(live(fake, "texture")).toBe(3);
    expect(live(fake, "framebuffer")).toBe(3);
    const sizes = fake.calls
      .filter(([n]) => n === "texImage2D")
      .map(([, a]) => `${a[3]}x${a[4]}`);
    expect(sizes).toEqual(["800x450", "200x113", "200x113"]);
    // A cena vai para o buffer; o último passe do quadro é a tela.
    const binds = bindsSince(fake, from);
    expect(binds[0]).not.toBeNull();
    expect(binds[binds.length - 1]).toBeNull();
    expect(uniformCalls(fake, "uniform1f", "uMix").at(-1)).toEqual([1]);
    expect(uniformCalls(fake, "uniform1f", "uSat").at(-1)![0]).toBeCloseTo(0.9, 9);
    expect(uniformCalls(fake, "uniform1f", "uGain").at(-1)![0]).toBeCloseTo(0.8, 9);
  });

  it("focused -> ambient anda 420 ms integrados por dt, a mistura sobe", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.frame(createGlSignal(), 1 / 60); // crava focused
    engine.setMode("ambient");
    let frames = 0;
    while (engine.ambient < 1 && frames < 100) {
      engine.frame(createGlSignal(), 1 / 60);
      frames++;
    }
    expect(frames).toBe(Math.ceil(AMBIENT_MODE_S * 60 - 1e-9));
    const mixes = uniformCalls(fake, "uniform1f", "uMix").map((v) => v[0]);
    expect(mixes.length).toBe(frames);
    for (let i = 1; i < mixes.length; i++) expect(mixes[i]).toBeGreaterThanOrEqual(mixes[i - 1]);
    // Desfoque crescendo junto (versão normal).
    const dirs = uniformCalls(fake, "uniform2f", "uDir").filter((v) => v[1] === 0).map((v) => v[0]);
    expect(dirs[0]).toBeLessThan(dirs[dirs.length - 1]);
  });

  it("versão calma: o desfoque entra inteiro e só a mistura anda", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.setMode("focused", true);
    engine.frame(createGlSignal(), 1 / 60);
    engine.setMode("ambient", true);
    for (let i = 0; i < 10; i++) engine.frame(createGlSignal(), 1 / 60);
    expect(engine.ambient).toBeGreaterThan(0);
    expect(engine.ambient).toBeLessThan(1);
    const dirs = uniformCalls(fake, "uniform2f", "uDir").filter((v) => v[1] === 0).map((v) => v[0]);
    expect(dirs.length).toBe(10);
    expect(dirs.every((d) => d === 1 / 200)).toBe(true);
    const mixes = uniformCalls(fake, "uniform1f", "uMix").map((v) => v[0]);
    expect(mixes[9]).toBeCloseTo(10 / 60 / AMBIENT_MODE_S, 9);
  });

  it("volta ao focused: passes do ambient param quando a troca termina", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.setMode("ambient");
    engine.frame(createGlSignal(), 1 / 60);
    engine.setMode("focused");
    for (let i = 0; i < 40; i++) engine.frame(createGlSignal(), 1 / 60);
    expect(engine.ambient).toBe(0);
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(bindsSince(fake, from).every((fb) => fb === null)).toBe(true);
  });

  it("a dissolução de cena acontece no buffer do ambient (o véu sai desfocado)", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.setMode("ambient");
    engine.frame(createGlSignal(), 1 / 60);
    engine.setScene(B, true);
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    const slice = fake.calls.slice(from);
    const alphaAt = slice.findIndex(([n, a]) => n === "uniform1f" && (a[0] as { uniform: string }).uniform === "uAlpha");
    expect(alphaAt).toBeGreaterThan(-1);
    const lastBind = slice.slice(0, alphaAt).filter(([n]) => n === "bindFramebuffer").at(-1)!;
    expect(lastBind[1]).not.toBeNull();
    expect(engine.transition?.kind).toBe("scene");
  });

  it("resize realoca os buffers no tamanho novo; dispose devolve tudo", () => {
    const { engine, fake } = two();
    engine.setScene(A);
    engine.setMode("ambient");
    engine.frame(createGlSignal(), 1 / 60);
    engine.resize(1857, 1048);
    expect(live(fake, "texture")).toBe(0);
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(live(fake, "texture")).toBe(3);
    const sizes = fake.calls
      .slice(from)
      .filter(([n]) => n === "texImage2D")
      .map(([, a]) => `${a[3]}x${a[4]}`);
    expect(sizes).toEqual(["1857x1048", "465x262", "465x262"]);
    engine.dispose();
    expect([...fake.live]).toEqual([]);
  });

  it("sem memória para os buffers: o fundo segue nítido, sem derrubar o motor", () => {
    const fake = makeFakeGl({ framebufferComplete: () => false });
    const { canvas } = makeFakeCanvas(fake.gl);
    const s = spyScene();
    const engine = new GlEngine(canvas, { scenes: { a: { key: "dust", create: () => s } } });
    engine.resize(800, 450);
    engine.setScene(A);
    engine.setMode("ambient");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => engine.frame(createGlSignal(), 1 / 60)).not.toThrow();
    engine.frame(createGlSignal(), 1 / 60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(s.frame).toHaveBeenCalledTimes(2);
    expect(live(fake, "texture")).toBe(0);
    warn.mockRestore();
  });
});

/* ---------- revisão do passe ambient (28/10) ---------- */

/** Motor com uma cena espiã de def arbitrária (ambientDirect, maxRows). */
function withDef(def: { ambientDirect?: boolean; maxRows?: number }) {
  const fake = makeFakeGl();
  const { canvas } = makeFakeCanvas(fake.gl);
  const s = spyScene();
  const o = spyScene();
  const engine = new GlEngine(canvas, {
    scenes: { s: { key: "paint", ...def, create: () => s }, o: { key: "dust", create: () => o } },
  });
  engine.resize(800, 450);
  engine.setPalette(PAL);
  return { engine, fake, s, o };
}
const S = "s" as SceneKey;
const O = "o" as SceneKey;
const draws = (fake: FakeGl, from: number) => fake.calls.slice(from).filter(([n]) => n === "drawArrays").length;

describe("GlEngine: ambient parado sem tela cheia", () => {
  it("ambientDirect: a cena desenha direto a 1/4, sem redução; volta à tela cheia na troca", () => {
    const { engine, fake, s } = withDef({ ambientDirect: true });
    engine.setScene(S);
    engine.setMode("ambient");
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(s.resize).toHaveBeenLastCalledWith(200, 113);
    expect(s.frame.mock.calls.at(-1)!.slice(3)).toEqual([200, 113]);
    // horizontal + vertical + composição; nenhuma redução.
    expect(draws(fake, from)).toBe(3);
    expect(uniformCalls(fake, "uniform2f", "uScale")).toEqual([]);
    // Saindo do ambient: a nítida entra na mistura já no primeiro quadro.
    engine.setMode("focused");
    engine.frame(createGlSignal(), 1 / 60);
    expect(s.resize).toHaveBeenLastCalledWith(800, 450);
    expect(s.frame.mock.calls.at(-1)!.slice(3)).toEqual([800, 450]);
    expect(engine.ambient).toBeLessThan(1);
  });

  it("ambientDirect: sem resize da cena a cada quadro parado", () => {
    const { engine, s } = withDef({ ambientDirect: true });
    engine.setScene(S);
    engine.setMode("ambient");
    for (let i = 0; i < 5; i++) engine.frame(createGlSignal(), 1 / 60);
    // Montagem (800x450) + entrada no direto (200x113).
    expect(s.resize.mock.calls).toEqual([[800, 450], [200, 113]]);
  });

  it("dissolução a partir do ambient direto: retrato em tela cheia e caminho cheio", () => {
    const { engine, fake, s } = withDef({ ambientDirect: true });
    engine.setScene(S);
    engine.setMode("ambient");
    engine.frame(createGlSignal(), 1 / 60);
    const before = s.frame.mock.calls.length;
    engine.setScene(O, true);
    // O retrato redesenha a cena no tamanho da tela.
    expect(s.frame.mock.calls[before].slice(3)).toEqual([800, 450]);
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(uniformCalls(fake, "uniform2f", "uScale").length).toBeGreaterThan(0);
    expect(draws(fake, from)).toBeGreaterThanOrEqual(4);
  });

  it("maxRows (Nébula): o desfoque lê o buffer da cena, sem ampliar e reduzir de novo", () => {
    const { engine, fake } = withDef({ maxRows: 120 });
    engine.setScene(S);
    engine.setMode("ambient");
    const from = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(draws(fake, from)).toBe(3);
    expect(uniformCalls(fake, "uniform2f", "uScale")).toEqual([]);
    // Na troca de modo volta o caminho cheio (composição do rt + redução).
    engine.setMode("focused");
    const from2 = fake.calls.length;
    engine.frame(createGlSignal(), 1 / 60);
    expect(draws(fake, from2)).toBe(5);
  });

  it("ganho mistura com o fundo atrás do canvas (paleta.back), não com o preto", () => {
    const { engine, fake } = two();
    engine.setPalette({ ...PAL, back: { r: 43, g: 43, b: 42 } });
    engine.setScene(A);
    engine.setMode("ambient");
    engine.frame(createGlSignal(), 1 / 60);
    const v = uniformCalls(fake, "uniform3f", "uBack").at(-1)!;
    expect(v[0]).toBeCloseTo(43 / 255, 6);
    expect(v[2]).toBeCloseTo(42 / 255, 6);
  });

  it("prepareAmbient: aloca no focused depois que o tamanho assenta, nunca no mobile", () => {
    const { engine, fake } = two();
    engine.prepareAmbient();
    engine.setScene(A);
    for (let i = 0; i < AMB_SETTLE_FRAMES - 1; i++) engine.frame(createGlSignal(), 1 / 60);
    expect(live(fake, "texture")).toBe(0);
    engine.frame(createGlSignal(), 1 / 60);
    expect(live(fake, "texture")).toBe(3);
    expect(engine.ambient).toBe(0);
    // Resize no focused: solta e só realoca com o tamanho parado de novo.
    engine.resize(900, 500);
    engine.frame(createGlSignal(), 1 / 60);
    expect(live(fake, "texture")).toBe(0);
    // A troca para o ambient depois disso não aloca no meio.
    for (let i = 0; i < AMB_SETTLE_FRAMES; i++) engine.frame(createGlSignal(), 1 / 60);
    expect(live(fake, "texture")).toBe(3);
    const from = fake.calls.length;
    engine.setMode("ambient");
    engine.frame(createGlSignal(), 1 / 60);
    expect(fake.calls.slice(from).filter(([n]) => n === "texImage2D")).toEqual([]);
  });
});
