import { describe, expect, it } from "vitest";
import { contrastRatio, relLuminance } from "./color";
import { glassSurface, lyricsInk, LYRICS_DESIGN_INK, LYRICS_MIN_RATIO, type LyricsInkVar } from "./lyricsInk";

/* np-2 / ds-18 (auditoria 25/09): o card de letras pintava uma escala
   clara fixa sobre um vidro cuja luminância depende do fundo. No tema
   claro padrão a superfície fica em ~rgb(168,169,169) e a linha ativa
   caía para 2,13:1, a próxima para 1,10:1. A escala agora é derivada da
   superfície real, com piso de contraste por papel. */

const toHex = (c: { r: number; g: number; b: number }) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function ratio(fg: string, surface: { r: number; g: number; b: number }): number {
  return contrastRatio(relLuminance(fg)!, relLuminance(toHex(surface))!);
}

const VARS = Object.keys(LYRICS_MIN_RATIO) as LyricsInkVar[];

describe("glassSurface", () => {
  it("reproduz a medição da auditoria no tema claro padrão (#fafafa, glass default)", () => {
    const s = glassSurface({ backdrop: { r: 250, g: 250, b: 250 }, alpha: 0.193, brightness: 0.82 });
    expect(Math.abs(s.r - 168)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.g - 169)).toBeLessThanOrEqual(1);
  });

  it("sem backdrop-filter (modo sólido) o brightness não entra", () => {
    const s = glassSurface({ backdrop: { r: 250, g: 250, b: 250 }, alpha: 0.5, brightness: null });
    expect(Math.round(s.r)).toBe(Math.round(250 * 0.5 + 15 * 0.5));
  });
});

describe("lyricsInk", () => {
  const light = glassSurface({ backdrop: { r: 250, g: 250, b: 250 }, alpha: 0.193, brightness: 0.82 });
  const black = glassSurface({ backdrop: { r: 0, g: 0, b: 0 }, alpha: 0.193, brightness: 0.82 });

  it("tema claro padrão: todo papel atinge o contraste mínimo", () => {
    const ink = lyricsInk(light);
    for (const v of VARS) expect(ratio(ink[v], light)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO[v]);
  });

  it("tema claro padrão: ativa mais legível que a próxima, que é mais legível que a inativa", () => {
    const ink = lyricsInk(light);
    const active = ratio(ink["--fg-1"], light);
    const near = ratio(ink["--fg-4"], light);
    const inactive = ratio(ink["--fg-7"], light);
    expect(active).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(inactive);
  });

  it("fundo escuro (WebGL): mantém a escala de desenho onde ela já passa", () => {
    const ink = lyricsInk(black);
    expect(ink["--fg-1"]).toBe(LYRICS_DESIGN_INK["--fg-1"]);
    expect(ink["--fg-4"]).toBe(LYRICS_DESIGN_INK["--fg-4"]);
    for (const v of VARS) expect(ratio(ink[v], black)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO[v]);
  });

  it("fundo escuro: as linhas inativas saem dos ~2,5:1 da escala fixa", () => {
    const ink = lyricsInk(black);
    expect(ratio(LYRICS_DESIGN_INK["--fg-7"], black)).toBeLessThan(LYRICS_MIN_RATIO["--fg-7"]);
    expect(ratio(ink["--fg-7"], black)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO["--fg-7"]);
  });

  it("glass no máximo do slider sobre fundo claro também passa", () => {
    const solid = glassSurface({ backdrop: { r: 250, g: 250, b: 250 }, alpha: 0.65, brightness: null });
    const ink = lyricsInk(solid);
    for (const v of VARS) expect(ratio(ink[v], solid)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO[v]);
  });
});
