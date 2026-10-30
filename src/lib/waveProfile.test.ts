import { describe, it, expect } from "vitest";
import { waveBars, WAVE_FLOOR } from "./waveProfile";

describe("perfil de volume no seek", () => {
  it("reamostra para o número de barras pelo máximo de cada trecho", () => {
    const p = [0, 0, 255, 0, 0, 0, 0, 0];
    const b = waveBars(p, 4);
    expect(b).toHaveLength(4);
    expect(b[1]).toBe(1);
    expect(b[0]).toBe(WAVE_FLOOR);
  });
  it("normaliza pela própria faixa: master alto ainda mostra o contorno", () => {
    // tudo entre 200 e 240 (master alto): o mais baixo vira o piso, o mais alto 1
    const p = [200, 210, 220, 240, 230, 200];
    const b = waveBars(p, 6);
    expect(b[3]).toBe(1);
    expect(Math.min(...b)).toBe(WAVE_FLOOR);
    expect(b[2]).toBeGreaterThan(b[1]);
  });
  it("faixa sem variação ou vazia não quebra", () => {
    expect(waveBars([128, 128, 128], 3)).toEqual([1, 1, 1]);
    expect(waveBars([], 5)).toEqual([]);
    expect(waveBars([10, 20], 0)).toEqual([]);
  });
});
