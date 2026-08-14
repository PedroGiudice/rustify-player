/* ============================================================
   lib/inkDerive.ts — derivação PURA de ink/accent a partir da cor
   dominante da capa (v3, contrast-driven). Extraída de
   adaptiveInk.ts em 14/08 pra ser compartilhada com o mobile
   (adaptiveInk.ts arrasta stores do desktop; aqui é só matemática
   de cor sobre lib/color.ts).
   ============================================================ */

import { contrastRatio, hexToHsl, hslToHex, relLuminance, walkLForContrast } from "./color";

/** Alvos de contraste vs canvas do tema. O ink é wash de fundo (os
    renderers multiplicam alpha por cima), o accent é UI interativa. */
const INK_CONTRAST_TARGET = 4.0;
const ACCENT_CONTRAST_TARGET = 4.0;

export interface AdaptiveAccent {
  accent: string;
  container: string;
  on: string;
}

/** Normaliza a cor dominante da capa pro papel de ink: mantém o hue,
    reforça a saturação (clamp 0.50..0.90, boost 1.8x — a cor de capa
    tende ao lavado) e leva a luminância até >= 4:1 de contraste contra
    o ink base do tema (que nos temas atuais == canvas). Capas
    acromáticas (s < 0.05) ficam acromáticas — cinza é identidade
    também — mas ainda ganham a luminância de contraste. */
export function deriveInk(coverHex: string, baseInkHex: string): string | null {
  const cover = hexToHsl(coverHex);
  if (!cover) return null;
  const baseY = relLuminance(baseInkHex) ?? 0.01;
  const themeL = hexToHsl(baseInkHex)?.l ?? 0.09;
  const dark = themeL < 0.5;
  const s = cover.s < 0.05 ? cover.s : Math.max(0.50, Math.min(0.90, cover.s * 1.8));
  const startL = dark
    ? Math.min(0.58, Math.max(0.32, cover.l))
    : Math.min(0.60, Math.max(0.30, cover.l));
  return walkLForContrast(cover.h, s, startL, dark, baseY, INK_CONTRAST_TARGET, dark ? 0.62 : 0.22);
}

/** Deriva o conjunto de accent a partir da capa: hue da capa, saturação
    alta, luminância com >= 4:1 vs canvas. `on` é o texto sobre o accent,
    escolhido entre quase-preto e quase-branco pelo maior contraste
    (>= 4.5:1 garantido por construção em accents 4:1 sobre canvas escuro).
    Capa acromática → null: accent cinza mataria a UI; o tema permanece. */
export function deriveAccent(coverHex: string, baseInkHex: string): AdaptiveAccent | null {
  const cover = hexToHsl(coverHex);
  if (!cover || cover.s < 0.05) return null;
  const baseY = relLuminance(baseInkHex) ?? 0.01;
  const themeL = hexToHsl(baseInkHex)?.l ?? 0.09;
  const dark = themeL < 0.5;
  const s = Math.max(0.55, Math.min(0.95, cover.s * 1.8));
  const startL = dark
    ? Math.min(0.62, Math.max(0.45, cover.l))
    : Math.min(0.50, Math.max(0.30, cover.l));
  const accent = walkLForContrast(cover.h, s, startL, dark, baseY, ACCENT_CONTRAST_TARGET, dark ? 0.72 : 0.22);
  const aHsl = hexToHsl(accent)!;
  const container = hslToHex(
    aHsl.h,
    Math.max(0, aHsl.s * 0.9),
    Math.min(0.85, Math.max(0.15, aHsl.l + (dark ? 0.08 : -0.08))),
  );
  const aY = relLuminance(accent) ?? 0.5;
  const DARK_TEXT = "#141312", LIGHT_TEXT = "#f5f4f2";
  const on =
    contrastRatio(aY, relLuminance(DARK_TEXT)!) >= contrastRatio(aY, relLuminance(LIGHT_TEXT)!)
      ? DARK_TEXT
      : LIGHT_TEXT;
  return { accent, container, on };
}
