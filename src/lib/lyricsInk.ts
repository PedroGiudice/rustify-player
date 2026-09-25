/* ============================================================
   lib/lyricsInk.ts — escala de texto do card de letras flutuante,
   derivada da luminância REAL do vidro.

   O card é uma tinta escura translúcida (rgba(15,17,16, alpha)) com
   backdrop-filter brightness() sobre o fundo do app. O CSS fixava uma
   escala clara (#f5f3ee … #565248) pensando em vidro escuro; sobre o
   canvas claro padrão o vidro fica cinza médio e a linha ativa caía
   para 2,13:1 (np-2), e mesmo no escuro as inativas ficavam em ~2,5:1
   (ds-18). Aqui:
     - superfície = backdrop × brightness, composta com a tinta no alpha
       (mesma conta em sRGB que o navegador faz);
     - superfície escura (Y < 0,18, o ponto em que texto claro e escuro
       empatam) → escala clara de desenho, cada tom subindo só o
       necessário para o piso do seu papel;
     - superfície clara → a mesma escala espelhada (escura), descendo
       até o piso.
   A cor de desenho fica intocada sempre que já passa.
   ============================================================ */

import { contrastRatio, hexToHsl, hslToHex, relLuminance } from "./color";

export type LyricsInkVar = "--fg-1" | "--fg-2" | "--fg-4" | "--fg-5" | "--fg-6" | "--fg-7";

type Rgb = { r: number; g: number; b: number };

/** A escala quente de desenho do card (o que o CSS fixava). */
export const LYRICS_DESIGN_INK: Readonly<Record<LyricsInkVar, string>> = {
  "--fg-1": "#f5f3ee",
  "--fg-2": "#e0dcd2",
  "--fg-4": "#b6b1a5",
  "--fg-5": "#8a857a",
  "--fg-6": "#6f6a60",
  "--fg-7": "#565248",
};

/** Piso de contraste contra o vidro, por papel no card. */
export const LYRICS_MIN_RATIO: Readonly<Record<LyricsInkVar, number>> = {
  "--fg-1": 4.5, // linha ativa (parte do extremo da escala, fica bem acima)
  "--fg-2": 4.5, // letra corrida sem sincronismo
  "--fg-4": 4.5, // próxima linha
  "--fg-5": 4.5, // rótulo "Lyrics" e cabeçalhos de seção
  "--fg-6": 3, // fonte ("aligned") e alça de resize
  "--fg-7": 3, // linhas inativas
};

/** Tinta do vidro (extractor-lab.css, .np__lyrics-card--floating). */
export const LYRICS_TINT: Readonly<Rgb> = { r: 15, g: 17, b: 16 };

export interface GlassInput {
  /** Cor atrás do card: canvas do tema no fundo 2D, preto no WebGL. */
  backdrop: Rgb;
  /** Alpha da tinta (--lyrics-bg-alpha). */
  alpha: number;
  /** brightness() do backdrop-filter; null quando o filtro está desligado
      (modo sólido do slider). */
  brightness: number | null;
}

/** Cor aproximada da superfície do vidro (saturate e blur ignorados:
    sobre um canvas neutro eles não mudam a luminância). */
export function glassSurface(i: GlassInput): Rgb {
  const k = i.brightness ?? 1;
  const a = Math.max(0, Math.min(1, i.alpha));
  const ch = (c: number, t: number) => Math.min(255, c * k) * (1 - a) + t * a;
  return {
    r: ch(i.backdrop.r, LYRICS_TINT.r),
    g: ch(i.backdrop.g, LYRICS_TINT.g),
    b: ch(i.backdrop.b, LYRICS_TINT.b),
  };
}

const toHex = (c: Rgb) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

/** Anda a luminosidade HSL em passos de 0,01 na direção `dir` até o
    contraste contra `baseY` atingir `target` (ou o limite 0..1). */
function walk(h: number, s: number, l: number, dir: 1 | -1, baseY: number, target: number): string {
  let hex = hslToHex(h, s, l);
  for (;;) {
    if (contrastRatio(relLuminance(hex) ?? 0, baseY) >= target) return hex;
    const next = Math.round((l + dir * 0.01) * 100) / 100;
    if (next < 0 || next > 1) return hex;
    l = next;
    hex = hslToHex(h, s, l);
  }
}

/** Escala de texto do card para uma superfície de vidro. */
export function lyricsInk(surface: Rgb): Record<LyricsInkVar, string> {
  const surfaceHex = toHex(surface);
  const baseY = relLuminance(surfaceHex) ?? 0;
  const lightText = baseY < 0.18;
  const surfaceL = hexToHsl(surfaceHex)?.l ?? 0;
  const out = {} as Record<LyricsInkVar, string>;
  for (const v of Object.keys(LYRICS_DESIGN_INK) as LyricsInkVar[]) {
    const hsl = hexToHsl(LYRICS_DESIGN_INK[v])!;
    if (lightText) {
      out[v] = walk(hsl.h, hsl.s, hsl.l, 1, baseY, LYRICS_MIN_RATIO[v]);
    } else {
      // Espelho da escala, começando sempre do lado escuro da superfície
      // (um tom claro espelhado podia nascer mais claro que o vidro).
      const start = Math.max(0, Math.min(1 - hsl.l, surfaceL - 0.02));
      out[v] = walk(hsl.h, hsl.s, Math.round(start * 100) / 100, -1, baseY, LYRICS_MIN_RATIO[v]);
    }
  }
  return out;
}
