/* ============================================================
   adaptiveColor.test.ts — accent da capa no S24 (A6).

   O texto da aba ativa senta sobre o CONTAINER: --on-accent-c é
   escolhido contra ele, não contra o accent. Capa quase cinza
   devolve os accents do tema.
   ============================================================ */

import { afterEach, describe, it, expect } from "vitest";
import { applyAdaptiveColor } from "./adaptiveColor";
import { contrastRatio, relLuminance } from "../lib/color";

const css = (name: string) => document.documentElement.style.getPropertyValue(name);
const ratio = (a: string, b: string) => contrastRatio(relLuminance(a)!, relLuminance(b)!);

afterEach(() => applyAdaptiveColor(null));

describe("applyAdaptiveColor", () => {
  it("texto sobre o container lê a >= 4,5:1", () => {
    for (const capa of ["#c0392b", "#2c6fd1", "#8e44ad", "#a4de02", "#e67e22"]) {
      applyAdaptiveColor(capa);
      expect(ratio(css("--on-accent-c"), css("--accent-c"))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(css("--on-accent"), css("--accent"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("capa quase cinza não pinta accent", () => {
    applyAdaptiveColor("#10131a");
    expect(css("--accent")).toBe("");
    expect(css("--on-accent-c")).toBe("");
    // o ink do fundo continua, neutro
    expect(css("--bg-ink-rgb")).not.toBe("");
  });
});
