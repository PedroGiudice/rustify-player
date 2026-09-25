/* ============================================================
   engine.test.ts — quando o canvas 2D está desenhando de fato
   (mobile-2 / mobile-v5).

   O que manda é o que o App MONTA, não a preferência: com WebGL
   escolhido e funcionando, shape/render não têm alvo; com WebGL
   que falhou, o 2D reassume e passa a precisar dos controles.
   ============================================================ */

import { afterEach, describe, expect, it } from "vitest";
import { is2dActive, setBgEngine } from "./engine";
import { resetGlStatus, setGlStatus } from "../../gl/meta";

const gl = (ok: boolean | null) => setGlStatus({ ok, renderer: "", error: ok === false ? "sem contexto" : "", fps: 0 });

afterEach(() => {
  setBgEngine("2d");
  resetGlStatus();
});

describe("is2dActive", () => {
  it("motor 2D escolhido: 2D ativo", () => {
    setBgEngine("2d");
    expect(is2dActive()).toBe(true);
  });

  it("WebGL escolhido e montado: 2D inativo", () => {
    setBgEngine("webgl");
    gl(true);
    expect(is2dActive()).toBe(false);
  });

  it("WebGL escolhido mas falhou: o 2D assumiu e está ativo", () => {
    setBgEngine("webgl");
    gl(false);
    expect(is2dActive()).toBe(true);
  });

  it("WebGL ainda montando (status nulo): o motor escolhido é o WebGL", () => {
    setBgEngine("webgl");
    gl(null);
    expect(is2dActive()).toBe(false);
  });
});
