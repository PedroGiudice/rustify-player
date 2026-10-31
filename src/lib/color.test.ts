/* ============================================================
   color.test.ts — piso de visibilidade do ink (ensureInkContrast).

   Contrato: NENHUMA cor de bg resolvida — usuário, capa, tema ou
   default — fica invisível contra o canvas do tema ativo. Espelha
   o ensure_bg_ink_contrast do backend (lib.rs).
   ============================================================ */

import { describe, it, expect } from "vitest";
import { ensureInkContrast, relLuminance, contrastRatio, cssColorToRgb, hexToOklch, oklchToHex, isAchromatic } from "./color";

function ratio(a: string, b: string): number {
  return contrastRatio(relLuminance(a)!, relLuminance(b)!);
}

describe("ensureInkContrast", () => {
  it("ink igual ao canvas escuro é levantado até 3:1 (caso real: temas com ink = canvas)", () => {
    const out = ensureInkContrast("#111110", "#111110", 3.0);
    expect(ratio(out, "#111110")).toBeGreaterThanOrEqual(3.0);
  });

  it("knob do usuário quase preto sobre canvas escuro ganha presença", () => {
    const out = ensureInkContrast("#151515", "#111110", 3.0);
    expect(ratio(out, "#111110")).toBeGreaterThanOrEqual(3.0);
  });

  it("ink claro sobre canvas claro desce até contrastar", () => {
    const out = ensureInkContrast("#f0f0f0", "#fafafa", 3.0);
    expect(ratio(out, "#fafafa")).toBeGreaterThanOrEqual(3.0);
    expect(relLuminance(out)!).toBeLessThan(relLuminance("#fafafa")!);
  });

  it("ink com contraste suficiente passa intocado", () => {
    expect(ensureInkContrast("#c64a10", "#111110", 3.0)).toBe("#c64a10");
  });

  it("hue preservado na correção", () => {
    const out = ensureInkContrast("#2a1015", "#111110", 3.0);
    const r = parseInt(out.slice(1, 3), 16);
    const g = parseInt(out.slice(3, 5), 16);
    const b = parseInt(out.slice(5, 7), 16);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it("canvas não parseável (jsdom/sem tema) vira no-op", () => {
    expect(ensureInkContrast("#151515", "", 3.0)).toBe("#151515");
    expect(ensureInkContrast("#151515", "rgba(0,0,0,.5)", 3.0)).toBe("#151515");
  });
});

describe("cssColorToRgb", () => {
  it("aceita hex e os formatos rgb()/rgba() do getComputedStyle", () => {
    expect(cssColorToRgb("#c64a10")).toEqual({ r: 198, g: 74, b: 16 });
    // Formato devolvido por custom property <color> em transição
    expect(cssColorToRgb("rgb(105, 0, 0)")).toEqual({ r: 105, g: 0, b: 0 });
    expect(cssColorToRgb("rgba(105, 0, 0, 0.5)")).toEqual({ r: 105, g: 0, b: 0 });
    expect(cssColorToRgb("")).toBeNull();
    expect(cssColorToRgb("var(--x)")).toBeNull();
  });
});

describe("OKLCH", () => {
  it("valores de referência do OKLab (vermelho, branco)", () => {
    const red = hexToOklch("#ff0000")!;
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
    const white = hexToOklch("#ffffff")!;
    expect(white.l).toBeCloseTo(1, 3);
    expect(white.c).toBeLessThan(1e-3);
  });

  it("ida e volta preserva o hex", () => {
    for (const hex of ["#c0392b", "#2c6fd1", "#a4de02", "#10131a", "#808080"]) {
      const o = hexToOklch(hex)!;
      expect(oklchToHex(o.l, o.c, o.h)).toBe(hex);
    }
  });

  it("fora do sRGB reduz o croma e mantém L e matiz", () => {
    const hex = oklchToHex(0.7, 0.4, 260); // azul impossível
    const o = hexToOklch(hex)!;
    expect(o.l).toBeCloseTo(0.7, 2);
    expect(Math.abs(o.h - 260)).toBeLessThan(2);
    expect(o.c).toBeLessThan(0.4);
  });

  it("acromático = croma abaixo de 0,02 (cinza com leve matiz incluído)", () => {
    expect(isAchromatic("#10131a")).toBe(true);
    expect(isAchromatic("#e9e9ee")).toBe(true);
    expect(isAchromatic("#1e0f08")).toBe(false);
    expect(isAchromatic("#c0392b")).toBe(false);
  });
});
