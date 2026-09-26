/* ============================================================
   engine.test.ts — o motor WebGL2 com um GL falso.

   O que importa travar aqui é o contrato do motor, não pixels (a
   paridade visual com o three foi medida no WebKitGTK real, ver
   scripts/gl-bench):
     - um contexto só; trocar de cena libera TUDO da anterior;
     - cena que não compila lança com a mensagem, não é recompilada
       a cada quadro e não derruba o motor;
     - buffer reduzido só quando a cena pede e a tela é maior;
     - onPalette só quando a paleta muda;
     - contexto perdido avisa; o próprio dispose não.
   ============================================================ */

import { describe, it, expect, vi } from "vitest";
import { GlEngine } from "./engine";
import { SCENES } from "./registry";
import { SCENE_KEYS, type SceneKey } from "./meta";
import { createGlSignal } from "./signal";
import type { GlPalette } from "./palette";
import type { GlScene, SceneCtx, SceneDef } from "./scene";
import { makeFakeCanvas, makeFakeGl, type FakeGl } from "./__fixtures__/fakeGl";

const PAL: GlPalette = {
  canvas: { r: 0, g: 0, b: 0 },
  ink: { r: 198, g: 99, b: 61 },
  ink2: { r: 216, g: 122, b: 82 },
  soft: { r: 133, g: 130, b: 123 },
};

function spyScene() {
  return {
    resize: vi.fn(),
    frame: vi.fn(),
    onPalette: vi.fn(),
    dispose: vi.fn(),
  };
}

function setup(defs?: Record<string, SceneDef>, fakeOpts = {}) {
  const fake = makeFakeGl(fakeOpts);
  const { canvas, fire } = makeFakeCanvas(fake.gl);
  const onLost = vi.fn();
  const engine = new GlEngine(canvas, { onLost, scenes: defs });
  return { fake, canvas, fire, onLost, engine };
}

/** Recursos do próprio motor (VAO vazio + programa do composite). */
function engineOwned(fake: FakeGl) {
  return [...fake.live].filter((r) => r.kind !== "shader");
}

describe("GlEngine: contexto", () => {
  it("sem WebGL2 o construtor lança (quem hospeda cai pro 2D)", () => {
    const { canvas } = makeFakeCanvas(null);
    expect(() => new GlEngine(canvas)).toThrow(/WebGL2/);
  });

  it("dispose solta o contexto e não conta como perda", () => {
    const { engine, fake, fire, onLost } = setup();
    engine.dispose();
    expect(fake.loseContext.calls).toBe(1);
    fire("webglcontextlost");
    expect(onLost).not.toHaveBeenCalled();
  });

  it("contexto perdido pelo driver avisa uma vez e para de desenhar", () => {
    const scene = spyScene();
    const { engine, fire, onLost } = setup({ a: { key: "dust", create: () => scene } });
    engine.setScene("a" as SceneKey);
    fire("webglcontextlost");
    fire("webglcontextlost");
    expect(onLost).toHaveBeenCalledTimes(1);
    engine.frame(createGlSignal(), 1 / 60);
    expect(scene.frame).not.toHaveBeenCalled();
  });
});

describe("GlEngine: troca de cena", () => {
  it("dispõe a anterior e monta a nova com o tamanho atual", () => {
    const a = spyScene();
    const b = spyScene();
    const { engine } = setup({
      a: { key: "dust", create: () => a },
      b: { key: "relief", create: () => b },
    });
    engine.resize(800, 450);
    engine.setScene("a" as SceneKey);
    engine.setScene("a" as SceneKey); // idempotente
    engine.setScene("b" as SceneKey);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.resize).toHaveBeenCalledWith(800, 450);
    expect(engine.sceneKey).toBe("b");
  });

  it("shader que não compila: lança com a chave, não repete e o motor segue vivo", () => {
    const create = vi.fn((_ctx: SceneCtx): GlScene => {
      throw new Error("shader de fragmento não compilou: ERROR: 0:3: 'x' : undeclared");
    });
    const ok = spyScene();
    const { engine } = setup({ bad: { key: "dust", create }, good: { key: "relief", create: () => ok } });
    expect(() => engine.setScene("bad" as SceneKey)).toThrow(/cena bad: shader de fragmento/);
    expect(engine.sceneKey).toBeNull();
    // Mesmo pedido no quadro seguinte: não recompila.
    engine.setScene("bad" as SceneKey);
    expect(create).toHaveBeenCalledTimes(1);
    engine.frame(createGlSignal(), 1 / 60); // sem cena: limpa e segue
    engine.setScene("good" as SceneKey);
    expect(engine.sceneKey).toBe("good");
  });

  it("frame entrega sinal, paleta em float e o tamanho da saída", () => {
    const s = spyScene();
    const { engine } = setup({ a: { key: "dust", create: () => s } });
    engine.resize(640, 360);
    engine.setPalette(PAL);
    engine.setScene("a" as SceneKey);
    const sig = createGlSignal();
    engine.frame(sig, 0.016);
    const [gotSig, pal, dt, w, h] = s.frame.mock.calls[0];
    expect(gotSig).toBe(sig);
    expect(dt).toBe(0.016);
    expect([w, h]).toEqual([640, 360]);
    expect(pal.ink[0]).toBeCloseTo(198 / 255, 6);
    expect(Array.from(pal.canvas)).toEqual([0, 0, 0]);
  });
});

describe("GlEngine: resolução reduzida", () => {
  it("cena com maxRows desenha num buffer menor, na proporção da tela", () => {
    const s = spyScene();
    const { engine, fake } = setup({ neb: { key: "nebula", maxRows: 256, create: () => s } });
    engine.resize(1366, 768);
    engine.setScene("neb" as SceneKey);
    expect(engine.outputSize).toEqual({ w: 455, h: 256 });
    expect(s.resize).toHaveBeenLastCalledWith(455, 256);
    expect([...fake.live].some((r) => r.kind === "framebuffer")).toBe(true);
    engine.frame(createGlSignal(), 1 / 60);
    expect(s.frame.mock.calls[0].slice(3)).toEqual([455, 256]);
  });

  it("tela menor que o teto: desenha direto, sem buffer", () => {
    const { engine, fake } = setup({ neb: { key: "nebula", maxRows: 256, create: () => spyScene() } });
    engine.resize(400, 200);
    engine.setScene("neb" as SceneKey);
    expect(engine.outputSize).toEqual({ w: 400, h: 200 });
    expect([...fake.live].some((r) => r.kind === "framebuffer")).toBe(false);
  });

  it("sair da cena reduzida libera o buffer", () => {
    const { engine, fake } = setup({
      neb: { key: "nebula", maxRows: 256, create: () => spyScene() },
      full: { key: "dust", create: () => spyScene() },
    });
    engine.resize(1366, 768);
    engine.setScene("neb" as SceneKey);
    engine.setScene("full" as SceneKey);
    expect([...fake.live].some((r) => r.kind === "framebuffer" || r.kind === "texture")).toBe(false);
    expect(engine.outputSize).toEqual({ w: 1366, h: 768 });
  });
});

describe("GlEngine: paleta", () => {
  it("onPalette só quando algum canal muda meio degrau de 8 bits", () => {
    const s = spyScene();
    const { engine } = setup({ a: { key: "dust", create: () => s } });
    engine.setPalette(PAL);
    engine.setScene("a" as SceneKey);
    expect(s.onPalette).toHaveBeenCalledTimes(1); // estado inicial
    engine.setPalette(PAL);
    engine.setPalette({ ...PAL, ink: { r: 198.2, g: 99, b: 61 } });
    expect(s.onPalette).toHaveBeenCalledTimes(1);
    engine.setPalette({ ...PAL, ink: { r: 200, g: 99, b: 61 } });
    expect(s.onPalette).toHaveBeenCalledTimes(2);
  });
});

describe("GlEngine + registro: nenhuma cena vaza recursos", () => {
  it.each(SCENE_KEYS)("%s monta, desenha e devolve tudo na troca e no dispose", (key) => {
    const { engine, fake } = setup();
    engine.resize(1366, 768);
    engine.setPalette(PAL);
    const baseline = new Set(engineOwned(fake));
    engine.setScene(key);
    const sig = createGlSignal();
    for (let i = 0; i < 3; i++) {
      sig.clock += 1 / 60;
      sig.low = sig.mid = sig.high = sig.beat = 0.5;
      engine.frame(sig, 1 / 60);
    }
    // Troca para outra cena e volta: o que a primeira criou sumiu.
    const other = SCENE_KEYS.find((k) => k !== key)!;
    engine.setScene(other);
    engine.setScene(key);
    engine.setScene(other);
    const otherOwned = new Set([...fake.live].filter((r) => !baseline.has(r)));
    engine.dispose();
    expect([...fake.live]).toEqual([]);
    // Sanidade: shaders nunca ficam vivos depois do link.
    expect([...otherOwned].some((r) => r.kind === "shader")).toBe(false);
  });

  it("todas as cenas do registro têm def.key igual à chave", () => {
    for (const k of SCENE_KEYS) expect(SCENES[k].key).toBe(k);
  });
});
