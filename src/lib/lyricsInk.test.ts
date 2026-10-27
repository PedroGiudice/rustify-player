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
    const inactive = ratio(ink["--fg-5"], light);
    expect(active).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(inactive);
  });

  it("fundo escuro (WebGL): mantém a escala de desenho onde ela já passa", () => {
    const ink = lyricsInk(black);
    expect(ink["--fg-1"]).toBe(LYRICS_DESIGN_INK["--fg-1"]);
    expect(ink["--fg-4"]).toBe(LYRICS_DESIGN_INK["--fg-4"]);
    for (const v of VARS) expect(ratio(ink[v], black)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO[v]);
  });

  it("fundo escuro: as linhas distantes (--fg-5) passam 4,5:1 sem retoque", () => {
    // A3 (26/10/2026): elas saíram do --fg-7 (#565248, ~2,5:1 no preto).
    const ink = lyricsInk(black);
    expect(ink["--fg-5"]).toBe(LYRICS_DESIGN_INK["--fg-5"]);
    expect(ratio(ink["--fg-5"], black)).toBeGreaterThanOrEqual(4.5);
  });

  it("glass no máximo do slider sobre fundo claro também passa", () => {
    const solid = glassSurface({ backdrop: { r: 250, g: 250, b: 250 }, alpha: 0.65, brightness: null });
    const ink = lyricsInk(solid);
    for (const v of VARS) expect(ratio(ink[v], solid)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO[v]);
  });
});

/* A3 (26/10/2026): com o WebGL, medir só contra o vidro sobre o preto
   deixava a letra a 1,9-2,6:1 quando a Tinta passava rosa atrás do card.
   O card passa a receber as superfícies plausíveis (vidro sobre o preto,
   sobre o ink e sobre o accent) e cada tom tem de passar contra todas. */
describe("lyricsInk com várias superfícies (fundo WebGL)", () => {
  const glass = (r: number, g: number, b: number) =>
    glassSurface({ backdrop: { r, g, b }, alpha: 0.193, brightness: 0.82 });
  const black = glass(0, 0, 0);
  const pink = glass(232, 143, 176);

  it("uma superfície só dá o mesmo resultado de antes", () => {
    expect(lyricsInk([black])).toEqual(lyricsInk(black));
  });

  it("Tinta rosa atrás do vidro: todo papel passa contra o rosa e contra o preto", () => {
    const ink = lyricsInk([black, pink]);
    for (const v of VARS) {
      expect(ratio(ink[v], pink)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO[v]);
      expect(ratio(ink[v], black)).toBeGreaterThanOrEqual(LYRICS_MIN_RATIO[v]);
    }
  });

  it("a escala medida só contra o preto não passaria no rosa", () => {
    const onlyBlack = lyricsInk(black);
    expect(ratio(onlyBlack["--fg-5"], pink)).toBeLessThan(4.5);
  });

  it("a ordem das superfícies não muda o resultado", () => {
    expect(lyricsInk([pink, black])).toEqual(lyricsInk([black, pink]));
  });
});
