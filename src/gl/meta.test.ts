import { describe, it, expect, afterEach } from "vitest";
import {
  RELIEF_DEFAULT,
  effectiveReliefStyle,
  isReliefLines,
  reliefHasSurface,
  sanitizeReliefStyle,
  setGlReliefOverride,
  setGlReliefStyle,
} from "./meta";

afterEach(() => {
  setGlReliefOverride(null);
  setGlReliefStyle(RELIEF_DEFAULT);
});

describe("estilo do Relevo", () => {
  it("isReliefLines aceita só as variantes existentes", () => {
    for (const k of ["original", "mesh", "ridges", "contours", "weave"]) expect(isReliefLines(k)).toBe(true);
    for (const k of ["", "Mesh", "grid", 3, null, undefined]) expect(isReliefLines(k)).toBe(false);
  });

  it("reliefHasSurface só nas variantes por pixel", () => {
    expect(reliefHasSurface("original")).toBe(false);
    expect(reliefHasSurface("mesh")).toBe(false);
    expect(reliefHasSurface("ridges")).toBe(true);
    expect(reliefHasSurface("contours")).toBe(true);
    expect(reliefHasSurface("weave")).toBe(true);
  });

  it("sanitize cai no padrão campo a campo", () => {
    expect(sanitizeReliefStyle(null)).toEqual(RELIEF_DEFAULT);
    expect(sanitizeReliefStyle(undefined)).toEqual(RELIEF_DEFAULT);
    expect(sanitizeReliefStyle({ lines: "ridges", shape: "smooth", surface: "solid" })).toEqual({
      lines: "ridges", shape: "smooth", surface: "solid",
    });
    expect(sanitizeReliefStyle({ lines: "x", shape: "smooth", surface: "solid" })).toEqual({
      lines: RELIEF_DEFAULT.lines, shape: "smooth", surface: "solid",
    });
    expect(sanitizeReliefStyle({ lines: "weave", shape: 1, surface: "solid" })).toEqual({
      lines: "weave", shape: RELIEF_DEFAULT.shape, surface: "solid",
    });
    expect(sanitizeReliefStyle({ lines: "weave", shape: "smooth", surface: "opaco" })).toEqual({
      lines: "weave", shape: "smooth", surface: RELIEF_DEFAULT.surface,
    });
  });

  it("override da medição vence a preferência e some ao limpar", () => {
    const pref = { lines: "contours", shape: "smooth", surface: "open" } as const;
    setGlReliefStyle(pref);
    expect(effectiveReliefStyle()).toEqual(pref);
    const forced = { lines: "weave", shape: "smooth", surface: "open" } as const;
    setGlReliefOverride(forced);
    expect(effectiveReliefStyle()).toEqual(forced);
    setGlReliefOverride(null);
    expect(effectiveReliefStyle()).toEqual(pref);
  });
});
