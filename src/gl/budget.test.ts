import { describe, expect, it } from "vitest";
import { NEBULA_MAX_ROWS, reducedBufferSize } from "./budget";

/* A Nébula custava 23-24 ms por quadro na cmr-auto (UHD 620, 1366x768)
   desenhando o fbm em todos os pixels. Ela passa a desenhar num buffer
   de no máximo 256 linhas, proporcional à largura, e é escalada para
   a tela com filtro linear. */

describe("reducedBufferSize", () => {
  it("limita a 256 linhas mantendo a proporção da tela (alvo cmr-auto)", () => {
    expect(NEBULA_MAX_ROWS).toBe(256);
    expect(reducedBufferSize(1366, 768, NEBULA_MAX_ROWS)).toEqual({ w: 455, h: 256 });
  });

  it("proporção preservada em tela larga", () => {
    const { w, h } = reducedBufferSize(3440, 1440, 256);
    expect(h).toBe(256);
    expect(Math.abs(w / h - 3440 / 1440)).toBeLessThan(0.01);
  });

  it("não aumenta telas já menores que o teto", () => {
    expect(reducedBufferSize(400, 200, 256)).toEqual({ w: 400, h: 200 });
  });

  it("nunca devolve dimensão zero", () => {
    expect(reducedBufferSize(0, 0, 256)).toEqual({ w: 1, h: 1 });
    expect(reducedBufferSize(3, 5000, 256)).toEqual({ w: 1, h: 256 });
  });
});
