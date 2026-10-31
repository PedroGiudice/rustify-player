/* ============================================================
   inkDerive.test.ts — contrato do acento e do ink da capa (A6).

   O acento é TEXTO (título da faixa atual, chip RÁDIO, botões
   ligados) e senta sobre paper, soft (hover) e a lavagem de 12 %
   da linha atual — não só sobre o canvas. Alvo 5,2:1 contra o
   canvas deixa o pior caso acima de 4,5:1 sobre o soft e a linha
   atual (simulação da varredura de 31/10, item A6).

   Capa quase cinza (JPEG preto e branco com leve matiz) não vira
   acento colorido: o portão é o CROMA OKLCH, não a saturação HSL,
   que dispara com croma imperceptível nas pontas de luminância.
   ============================================================ */

import { describe, it, expect } from "vitest";
import { deriveAccent, deriveInk } from "./inkDerive";
import { contrastRatio, relLuminance, hexToRgb } from "./color";

const RD = { canvas: "#050505", paper: "#0c0c0c", soft: "#161616" };
const LIGHT = { canvas: "#fafafa", paper: "#ffffff", soft: "#f7f6f3" };

const ratio = (a: string, b: string) => contrastRatio(relLuminance(a)!, relLuminance(b)!);

/** Lavagem da linha atual: acento a 12 % sobre o paper (`--blue-bg`). */
function wash(accent: string, paper: string, alpha = 0.12): string {
  const a = hexToRgb(accent)!, p = hexToRgb(paper)!;
  const mix = (x: number, y: number) => Math.round(x * alpha + y * (1 - alpha));
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(mix(a.r, p.r))}${h(mix(a.g, p.g))}${h(mix(a.b, p.b))}`;
}

// Capas que ficavam abaixo do piso com o alvo 4,0 (medidas em 31/10).
const SATURADAS = {
  vermelho: "#c0392b",
  azul: "#2c6fd1",
  azulEscuro: "#1a2a6c",
  roxo: "#8e44ad",
  laranja: "#e67e22",
  limao: "#a4de02",
  verde: "#27ae60",
  magenta: "#d4207a",
};

describe("deriveAccent: o acento lê como texto", () => {
  for (const [nome, capa] of Object.entries(SATURADAS)) {
    it(`${nome} no Really Dark: >= 4,5:1 sobre canvas, paper, soft e linha atual`, () => {
      const a = deriveAccent(capa, RD.canvas)!;
      expect(a).not.toBeNull();
      expect(ratio(a.accent, RD.canvas)).toBeGreaterThanOrEqual(5.2);
      expect(ratio(a.accent, RD.soft)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(a.accent, wash(a.accent, RD.paper))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(a.on, a.accent)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${nome} no repouso claro: >= 4,5:1 sobre canvas, soft e linha atual`, () => {
      const a = deriveAccent(capa, LIGHT.canvas)!;
      expect(a).not.toBeNull();
      expect(ratio(a.accent, LIGHT.canvas)).toBeGreaterThanOrEqual(5.2);
      expect(ratio(a.accent, LIGHT.soft)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(a.accent, wash(a.accent, LIGHT.paper))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(a.on, a.accent)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("texto sobre o container também lê (on-accent-c do S24)", () => {
    for (const capa of Object.values(SATURADAS)) {
      const a = deriveAccent(capa, RD.canvas)!;
      expect(ratio(a.onContainer, a.container)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("deriveAccent: capa quase cinza mantém o acento do tema", () => {
  // Croma OKLCH de 0,004 a 0,015: cinza aos olhos, saturação HSL alta nas pontas.
  for (const capa of ["#10131a", "#1a1410", "#0b0d12", "#a8a49c", "#d9d6cf", "#e9e9ee", "#f2f1f4", "#2a2a2e"]) {
    it(`${capa} -> null`, () => {
      expect(deriveAccent(capa, RD.canvas)).toBeNull();
      expect(deriveAccent(capa, LIGHT.canvas)).toBeNull();
    });
  }

  it("capa escura de cor de verdade ainda dá acento (The Chase #1e0f08, croma 0,029)", () => {
    expect(deriveAccent("#1e0f08", RD.canvas)).not.toBeNull();
    expect(deriveAccent("#3b2a1e", RD.canvas)).not.toBeNull();
  });
});

describe("deriveInk: capa quase cinza fica cinza", () => {
  for (const capa of ["#10131a", "#e9e9ee", "#d9d6cf"]) {
    it(`${capa} vira ink neutro, ainda com presença`, () => {
      const ink = deriveInk(capa, RD.canvas)!;
      const { r, g, b } = hexToRgb(ink)!;
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(4);
      expect(ratio(ink, RD.canvas)).toBeGreaterThanOrEqual(3.5);
    });
  }
});
