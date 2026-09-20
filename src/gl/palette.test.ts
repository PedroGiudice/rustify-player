import { describe, it, expect } from "vitest";
import { MOBILE_VARS, parseColor, readGlPalette } from "./palette";

const reader = (map: Record<string, string>) => (name: string) => map[name] ?? "";

describe("parseColor", () => {
  it("aceita hex de 6 e de 3 digitos", () => {
    expect(parseColor("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("aceita rgb(), rgba() e a forma crua 'r, g, b' das CSS vars", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor(" 23, 23, 23 ")).toEqual({ r: 23, g: 23, b: 23 });
  });

  it("devolve null no que nao parseia, em vez de uma cor errada", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor("var(--x)")).toBeNull();
    expect(parseColor("chartreuse")).toBeNull();
  });
});

describe("readGlPalette", () => {
  it("le ink e accent das vars que o store ja resolve", () => {
    const p = readGlPalette(reader({
      "--bg-ink-rgb": "198, 99, 61",
      "--primary": "#d87a52",
      "--fg-5": "#85827b",
    }));
    expect(p.ink).toEqual({ r: 198, g: 99, b: 61 });
    expect(p.ink2).toEqual({ r: 216, g: 122, b: 82 });
    expect(p.soft).toEqual({ r: 133, g: 130, b: 123 });
  });

  it("canvas e preto puro, ignorando o canvas do tema (paridade com o 2D)", () => {
    const p = readGlPalette(reader({ "--bg-canvas": "#111110", "--bg-ink": "#c6633d" }));
    expect(p.canvas).toEqual({ r: 0, g: 0, b: 0 });
    const m = readGlPalette(reader({ "--s-base": "#0c0c0c", "--bg-ink-rgb": "240, 240, 240" }), MOBILE_VARS);
    expect(m.canvas).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("cai em --bg-ink quando --bg-ink-rgb nao existe", () => {
    const p = readGlPalette(reader({ "--bg-ink": "#c6633d" }));
    expect(p.ink).toEqual({ r: 198, g: 99, b: 61 });
  });

  it("sem accent do tema, deriva ink2 do proprio ink (nunca fica igual)", () => {
    const p = readGlPalette(reader({ "--bg-ink": "#404040" }));
    expect(p.ink2).not.toEqual(p.ink);
    // clareia em direcao ao branco: soma dos canais maior
    expect(p.ink2.r + p.ink2.g + p.ink2.b).toBeGreaterThan(p.ink.r + p.ink.g + p.ink.b);
  });

  it("no mobile le os tokens do design system de la", () => {
    const p = readGlPalette(reader({
      "--bg-ink-rgb": "240, 240, 240",
      "--accent": "#997081",
      "--accent-dim": "#a0a0a0",
      // vars do desktop presentes nao podem vazar pro mobile
      "--bg-canvas": "#fafafa",
      "--primary": "#2563eb",
    }), MOBILE_VARS);
    expect(p.ink).toEqual({ r: 240, g: 240, b: 240 });
    expect(p.ink2).toEqual({ r: 153, g: 112, b: 129 });
    expect(p.soft).toEqual({ r: 160, g: 160, b: 160 });
  });

  it("sem nenhuma var, entrega defaults utilizaveis (nao zera a cena)", () => {
    const p = readGlPalette(reader({}));
    expect(p.canvas).toEqual({ r: 0, g: 0, b: 0 });
    expect(p.ink).toBeTruthy();
    expect(p.soft).toBeTruthy();
  });
});
