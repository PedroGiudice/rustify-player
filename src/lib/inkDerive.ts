/* ============================================================
   lib/inkDerive.ts — derivação PURA de ink/accent a partir da cor
   dominante da capa (v3, contrast-driven). Extraída de
   adaptiveInk.ts em 14/08 pra ser compartilhada com o mobile
   (adaptiveInk.ts arrasta stores do desktop; aqui é só matemática
   de cor sobre lib/color.ts).
   ============================================================ */

import {
  ACHROMATIC_CHROMA, contrastRatio, hexToHsl, hexToOklch, hexToRgb, isAchromatic, oklchToHex,
  relLuminance, walkLForContrast,
} from "./color";

/** Alvos de contraste vs canvas do tema. O ink é wash de fundo (os
    renderers multiplicam alpha por cima): 4:1 basta. O accent é TEXTO
    (título da faixa atual, chip RÁDIO, botão ligado) e senta sobre
    paper, soft (hover) e a lavagem de 12 % da linha atual, todos mais
    claros que o canvas no tema escuro: 5,2:1 contra o canvas deixa o pior
    caso acima de 4,5:1 sobre o soft e a linha atual (A6, 31/10/2026; com
    4,0 azul, roxo e vermelho ficavam entre 3,67 e 3,91:1). */
const INK_CONTRAST_TARGET = 4.0;
const ACCENT_CONTRAST_TARGET = 5.2;
/** Piso do accent sobre a lavagem da linha atual (`--blue-bg` = accent a
    12 %). No tema claro a lavagem escurece o fundo e só o alvo do canvas
    não bastava (vermelho a 4,44:1). */
const ACCENT_WASH_TARGET = 4.5;
const ACCENT_WASH_ALPHA = 0.12;

export interface AdaptiveAccent {
  accent: string;
  container: string;
  /** Texto sobre o accent. */
  on: string;
  /** Texto sobre o container (o S24 pinta a aba ativa com ele). */
  onContainer: string;
}

const DARK_TEXT = "#141312", LIGHT_TEXT = "#f5f4f2";

/** `accentHex` a `alpha` sobre `bgHex`, em sRGB (como o color-mix do CSS). */
function washOver(accentHex: string, bgHex: string, alpha: number): string {
  const a = hexToRgb(accentHex), b = hexToRgb(bgHex);
  if (!a || !b) return bgHex;
  const m = (x: number, y: number) => Math.round(x * alpha + y * (1 - alpha)).toString(16).padStart(2, "0");
  return `#${m(a.r, b.r)}${m(a.g, b.g)}${m(a.b, b.b)}`;
}

/** O accent lê como texto: alvo contra o canvas E piso sobre a lavagem dele
    pintada no paper (a linha atual é `--blue-bg` sobre o paper). */
function accentReads(hex: string, canvasHex: string, paperHex: string): boolean {
  const y = relLuminance(hex) ?? 0;
  const canvasY = relLuminance(canvasHex) ?? 0.01;
  const washY = relLuminance(washOver(hex, paperHex, ACCENT_WASH_ALPHA)) ?? canvasY;
  return contrastRatio(y, canvasY) >= ACCENT_CONTRAST_TARGET
    && contrastRatio(y, washY) >= ACCENT_WASH_TARGET;
}

/** Quase-preto ou quase-branco, o que contrastar mais com `bgHex`. */
function textOn(bgHex: string): string {
  const y = relLuminance(bgHex) ?? 0.5;
  return contrastRatio(y, relLuminance(DARK_TEXT)!) >= contrastRatio(y, relLuminance(LIGHT_TEXT)!)
    ? DARK_TEXT
    : LIGHT_TEXT;
}

/** Normaliza a cor dominante da capa pro papel de ink: mantém o hue,
    reforça a saturação (clamp 0.50..0.90, boost 1.8x — a cor de capa
    tende ao lavado) e leva a luminância até >= 4:1 de contraste contra
    o ink base do tema (que nos temas atuais == canvas). Capas
    acromáticas (croma OKLCH < ACHROMATIC_CHROMA) ficam cinza — cinza é
    identidade também — mas ainda ganham a luminância de contraste. */
export function deriveInk(coverHex: string, baseInkHex: string): string | null {
  const cover = hexToHsl(coverHex);
  if (!cover) return null;
  const baseY = relLuminance(baseInkHex) ?? 0.01;
  const themeL = hexToHsl(baseInkHex)?.l ?? 0.09;
  const dark = themeL < 0.5;
  const s = isAchromatic(coverHex) ? 0 : Math.max(0.50, Math.min(0.90, cover.s * 1.8));
  const startL = dark
    ? Math.min(0.58, Math.max(0.32, cover.l))
    : Math.min(0.60, Math.max(0.30, cover.l));
  return walkLForContrast(cover.h, s, startL, dark, baseY, INK_CONTRAST_TARGET, dark ? 0.62 : 0.22);
}

/** Croma do accent: capa x 1,25, entre 0,07 (capa de pouca cor ainda tem
    papel) e 0,17 (capa saturada não vira néon atrás da moldura quieta). */
const ACCENT_CHROMA_GAIN = 1.25;
const ACCENT_CHROMA_MIN = 0.07;
const ACCENT_CHROMA_MAX = 0.17;

/** Deriva o conjunto de accent a partir da capa, em OKLCH (B25, 31/10/2026):
    matiz da capa, croma clamp(C x 1,25, 0,07, 0,17) e brilho L caminhando a
    partir do da capa (preso numa faixa) até ler como texto (5,2:1 contra o
    canvas, 4,5:1 sobre a lavagem da linha atual). Em HSL o mesmo papel saía
    com L de 0,56 a 0,85 e croma de 0,12 a 0,26 conforme a capa. Fora do
    sRGB o croma é que cede (oklchToHex), nunca o matiz.
    `on`/`onContainer` são o texto sobre o accent e sobre o container,
    escolhidos entre quase-preto e quase-branco pelo maior contraste (os
    testes travam >= 4,5:1 nas capas de referência; não é garantia
    matemática para toda cor).
    `baseInkHex` é o canvas do tema; `paperHex`, a superfície onde a linha
    atual pinta a lavagem (sem ele, o canvas).
    Capa acromática → null: accent cinza mataria a UI; o tema permanece. */
export function deriveAccent(
  coverHex: string,
  baseInkHex: string,
  paperHex: string = baseInkHex,
): AdaptiveAccent | null {
  const cover = hexToOklch(coverHex);
  if (!cover || cover.c < ACHROMATIC_CHROMA) return null;
  const dark = (hexToOklch(baseInkHex)?.l ?? 0.2) < 0.6;
  const c = Math.min(ACCENT_CHROMA_MAX, Math.max(ACCENT_CHROMA_MIN, cover.c * ACCENT_CHROMA_GAIN));
  let l = dark ? Math.min(0.80, Math.max(0.60, cover.l)) : Math.min(0.55, Math.max(0.40, cover.l));
  const stopL = dark ? 0.95 : 0.2;
  let accent = oklchToHex(l, c, cover.h);
  while (!accentReads(accent, baseInkHex, paperHex)) {
    const next = dark ? l + 0.01 : l - 0.01;
    if (dark ? next > stopL : next < stopL) break;
    l = next;
    accent = oklchToHex(l, c, cover.h);
  }
  const container = oklchToHex(
    Math.min(0.92, Math.max(0.2, l + (dark ? 0.06 : -0.08))),
    c * 0.9,
    cover.h,
  );
  return { accent, container, on: textOn(accent), onContainer: textOn(container) };
}
