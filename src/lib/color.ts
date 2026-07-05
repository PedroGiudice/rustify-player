/* ============================================================
   lib/color.ts — conversores e métricas de cor compartilhados.

   Fonte única (antes triplicado em adaptiveInk/tweaks/backend —
   CMR-112). A matemática de luminância/contraste replica o
   checker WCAG do backend (lib.rs: relative_luminance,
   contrast_ratio) — mesmos coeficientes, mesmos thresholds.
   ============================================================ */

export interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  const c = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/** Valor CSS de cor → {r,g,b}. Aceita "#rrggbb" e "rgb()/rgba()" — o
    formato que getComputedStyle devolve pra custom property registrada
    como <color> (inclusive NO MEIO de uma transição). */
export function cssColorToRgb(value: string): { r: number; g: number; b: number } | null {
  const v = value.trim();
  const hex = hexToRgb(v);
  if (hex) return hex;
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(v);
  if (!m) return null;
  return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) };
}

/** Luminância relativa WCAG (0..1) a partir de hex. */
export function relLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** Razão de contraste WCAG entre duas luminâncias relativas. */
export function contrastRatio(y1: number, y2: number): number {
  const hi = Math.max(y1, y2), lo = Math.min(y1, y2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Caminha a luminância HSL a partir de `startL` na direção que afasta a
    cor do fundo (sobe em fundo escuro, desce em claro) até a razão de
    contraste vs `baseY` atingir `target` — ou o limite `stopL`. Passos de
    0.02 bastam: o alvo é presença perceptual, não precisão colorimétrica. */
export function walkLForContrast(
  h: number, s: number, startL: number,
  dark: boolean, baseY: number, target: number, stopL: number,
): string {
  let l = startL;
  let hex = hslToHex(h, s, l);
  for (let i = 0; i < 30; i++) {
    const y = relLuminance(hex) ?? 0;
    if (contrastRatio(y, baseY) >= target) break;
    const next = dark ? l + 0.02 : l - 0.02;
    if (dark ? next > stopL : next < stopL) break;
    l = next;
    hex = hslToHex(h, s, l);
  }
  return hex;
}

/** Piso de visibilidade do ink resolvido: qualquer cor de bg — do usuário,
    da capa ou do tema — precisa de `minRatio` contra o canvas ativo. Se já
    contrasta (ou algum hex não parseia), devolve a cor intocada. Espelha o
    `ensure_bg_ink_contrast` do backend (lib.rs), que cobre o tema na fonte;
    aqui cobre o knob manual e o default. */
export function ensureInkContrast(inkHex: string, canvasHex: string, minRatio: number): string {
  const inkY = relLuminance(inkHex);
  const canvasY = relLuminance(canvasHex);
  if (inkY === null || canvasY === null) return inkHex;
  if (contrastRatio(inkY, canvasY) >= minRatio) return inkHex;
  const hsl = hexToHsl(inkHex)!;
  const dark = canvasY < 0.18; // ~L 0.5 em luminância relativa
  return walkLForContrast(hsl.h, hsl.s, hsl.l, dark, canvasY, minRatio, dark ? 0.85 : 0.08);
}
