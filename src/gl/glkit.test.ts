import { describe, it, expect } from "vitest";
import { formatShaderError, makeProgram, makeTarget, runFeedback } from "./glkit";
import { makeFakeGl } from "./__fixtures__/fakeGl";

describe("formatShaderError", () => {
  it("cita rótulo, estágio, log e as linhas acusadas pelo driver", () => {
    const src = "#version 300 es\nprecision highp float;\nvoid main(){ x = 1.0; }\n";
    const msg = formatShaderError("shader de fragmento", "dust", "ERROR: 0:3: 'x' : undeclared identifier", src);
    expect(msg).toMatch(/^dust: shader de fragmento não compilou: ERROR: 0:3/);
    expect(msg).toContain("  3| void main(){ x = 1.0; }");
  });

  it("sem número de linha no log, só o log", () => {
    expect(formatShaderError("shader de vértice", "", "falhou", "a\nb")).toBe("shader de vértice não compilou: falhou");
  });

  it("log vazio não vira mensagem vazia", () => {
    expect(formatShaderError("shader de vértice", "x", "", "a")).toContain("(driver sem log)");
  });
});

describe("makeProgram", () => {
  it("lança com a mensagem de compilação e não deixa shader vivo", () => {
    const fake = makeFakeGl({ failCompile: (src) => (src.includes("BUG") ? "ERROR: 0:1: 'BUG' : syntax error" : null) });
    expect(() => makeProgram(fake.gl, "void main(){}", "BUG", { label: "cena" })).toThrow(
      /cena: shader de fragmento não compilou: ERROR: 0:1: 'BUG'/,
    );
    expect([...fake.live]).toEqual([]);
  });

  it("guarda a localização de cada uniform (uma consulta por nome)", () => {
    const fake = makeFakeGl();
    const p = makeProgram(fake.gl, "v", "f");
    p.f("uTime", 1);
    p.f("uTime", 2);
    p.v2("uRes", 1, 2);
    expect(fake.count("getUniformLocation")).toBe(2);
  });

  it("liga varyings de transform feedback e posições de atributo antes do link", () => {
    const fake = makeFakeGl();
    makeProgram(fake.gl, "v", "f", { feedback: ["vOut"], attribs: { aPos: 0 } });
    const order = fake.calls.map((c) => c[0]);
    expect(order.indexOf("transformFeedbackVaryings")).toBeLessThan(order.indexOf("linkProgram"));
    expect(order.indexOf("bindAttribLocation")).toBeLessThan(order.indexOf("linkProgram"));
  });

  it("dispose apaga o programa (shaders já saem no link)", () => {
    const fake = makeFakeGl();
    const p = makeProgram(fake.gl, "v", "f");
    expect([...fake.live].map((r) => r.kind)).toEqual(["program"]);
    p.dispose();
    expect([...fake.live]).toEqual([]);
  });
});

describe("makeTarget", () => {
  it("RGBA8 por padrão", () => {
    const fake = makeFakeGl({ colorBufferFloat: true });
    expect(makeTarget(fake.gl, 4, 4).half).toBe(false);
  });

  it("half-float só com EXT_color_buffer_float", () => {
    expect(makeTarget(makeFakeGl({ colorBufferFloat: false }).gl, 4, 4, { half: true }).half).toBe(false);
    expect(makeTarget(makeFakeGl({ colorBufferFloat: true }).gl, 4, 4, { half: true }).half).toBe(true);
  });

  it("extensão anunciada mas framebuffer half incompleto: cai para 8 bits", () => {
    const fake = makeFakeGl({ colorBufferFloat: true, framebufferComplete: (half) => !half });
    expect(makeTarget(fake.gl, 4, 4, { half: true }).half).toBe(false);
  });

  it("framebuffer que não fecha nem em 8 bits: lança e não vaza", () => {
    const fake = makeFakeGl({ framebufferComplete: () => false });
    expect(() => makeTarget(fake.gl, 4, 4)).toThrow(/incompleto/);
    expect([...fake.live]).toEqual([]);
  });
});

describe("runFeedback", () => {
  it("solta o ARRAY_BUFFER antes, desliga a rasterização só durante o passo e desliga tudo no fim", () => {
    const fake = makeFakeGl();
    const gl = fake.gl;
    runFeedback(gl, {
      tf: {} as WebGLTransformFeedback,
      vao: {} as WebGLVertexArrayObject,
      out: {} as WebGLBuffer,
      count: 100,
    });
    const seq = fake.calls.map((c) => c[0]);
    const i = (n: string, from = 0) => seq.indexOf(n, from);
    expect(i("bindBuffer")).toBeLessThan(i("bindTransformFeedback"));
    expect(fake.calls[i("bindBuffer")][1][1]).toBeNull();
    expect(i("enable")).toBeLessThan(i("beginTransformFeedback"));
    expect(i("endTransformFeedback")).toBeLessThan(i("disable"));
    const last = fake.calls.slice(-3).map((c) => [c[0], c[1][c[1].length - 1]]);
    expect(last).toEqual([
      ["bindBufferBase", null],
      ["bindTransformFeedback", null],
      ["bindVertexArray", null],
    ]);
  });
});
