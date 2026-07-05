/* ============================================================
   color.test.ts — piso de visibilidade do ink (ensureInkContrast).

   Contrato: NENHUMA cor de bg resolvida — usuário, capa, tema ou
   default — fica invisível contra o canvas do tema ativo. Espelha
   o ensure_bg_ink_contrast do backend (lib.rs).
   ============================================================ */

import { describe, it, expect } from "vitest";
import { ensureInkContrast, relLuminance, contrastRatio, cssColorToRgb } from "./color";

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
