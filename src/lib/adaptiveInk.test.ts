/* ============================================================
   adaptiveInk.test.ts — deriveInk/deriveAccent v3 (contrast-driven).

   Contrato central: a cor derivada da capa SEMPRE tem presença
   contra o canvas do tema (a v2 ancorava na profundidade do tema
   e produzia ink invisível — capa escura sobre canvas escuro dava
   1.2:1). Casos reais da regressão: The Chase #1e0f08 (quase
   preta) e o canvas do copper #111110.
   ============================================================ */

import { describe, it, expect, vi } from "vitest";

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
}));

// store/tweaks lê window.__TAURI__ no top-level.
(window as any).__TAURI__ = { core: { invoke: vi.fn().mockResolvedValue([]) } };

import { deriveInk, deriveAccent, relLuminance, contrastRatio } from "./adaptiveInk";

const COPPER_CANVAS = "#111110";
const LIGHT_CANVAS = "#fafafa";

function ratioVs(hex: string, base: string): number {
  return contrastRatio(relLuminance(hex)!, relLuminance(base)!);
}

function rgbOf(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

describe("deriveInk v3", () => {
  it("capa quase preta ganha presença sobre canvas escuro (caso The Chase)", () => {
    const ink = deriveInk("#1e0f08", COPPER_CANVAS)!;
    expect(ratioVs(ink, COPPER_CANVAS)).toBeGreaterThanOrEqual(3.5);
    // Hue preservado: laranja-marrom → canal r domina g domina b.
    const { r, g, b } = rgbOf(ink);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it("capa viva mantém hue e sai saturada", () => {
    const ink = deriveInk("#c81e28", COPPER_CANVAS)!;
    expect(ratioVs(ink, COPPER_CANVAS)).toBeGreaterThanOrEqual(3.5);
    const { r, g, b } = rgbOf(ink);
    expect(r).toBeGreaterThan(g + 60); // vermelho de verdade, não lama
    expect(r).toBeGreaterThan(b + 60);
  });

  it("capa acromática fica acromática mas ainda visível", () => {
    const ink = deriveInk("#3a3a3a", COPPER_CANVAS)!;
    const { r, g, b } = rgbOf(ink);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(4);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(4);
    expect(ratioVs(ink, COPPER_CANVAS)).toBeGreaterThanOrEqual(3.5);
  });

  it("tema claro: ink desce até contrastar", () => {
    const ink = deriveInk("#a8d5f2", LIGHT_CANVAS)!;
    expect(ratioVs(ink, LIGHT_CANVAS)).toBeGreaterThanOrEqual(3.5);
    expect(relLuminance(ink)!).toBeLessThan(relLuminance(LIGHT_CANVAS)!);
  });

  it("hex inválido retorna null", () => {
    expect(deriveInk("not-a-color", COPPER_CANVAS)).toBeNull();
  });
});

describe("deriveAccent v3", () => {
  it("capa acromática NÃO gera accent (tema permanece)", () => {
    expect(deriveAccent("#3a3a3a", COPPER_CANVAS)).toBeNull();
  });

  it("capa viva gera accent com presença e on-accent legível", () => {
    const a = deriveAccent("#1e0f08", COPPER_CANVAS)!;
    expect(a).not.toBeNull();
    expect(ratioVs(a.accent, COPPER_CANVAS)).toBeGreaterThanOrEqual(3.5);
    // Texto sobre o accent: legibilidade AA de texto normal.
    expect(ratioVs(a.on, a.accent)).toBeGreaterThanOrEqual(4.5);
    // Container acompanha a família (mesma dominância de canais).
    const acc = rgbOf(a.accent), cont = rgbOf(a.container);
    expect(Math.sign(acc.r - acc.b)).toBe(Math.sign(cont.r - cont.b));
  });

  it("accent de capa vermelha viva continua vermelho", () => {
    const a = deriveAccent("#c81e28", COPPER_CANVAS)!;
    const { r, g } = rgbOf(a.accent);
    expect(r).toBeGreaterThan(g + 60);
  });
});
