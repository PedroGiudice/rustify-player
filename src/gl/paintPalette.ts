/* ============================================================
   gl/paintPalette.ts — as 6 camadas de cor da Tinta, sem GL.

   Por quê (11/10, no app): a Tinta usava ink e ink2 tal como vinham
   da capa. Capa clara e de um tom só (Zero, do Yung Buda: ink e ink2
   verde-limão quase iguais) acendeu o fundo inteiro — 93% dos pixels
   numa faixa de luminância 0,6-0,8, média 0,73, matiz único.

   Regra: o BRILHO de cada camada é fixo (degraus de L do OKLab, do
   quase preto a um claro com teto) e a capa decide só o TOM e a
   saturação. As camadas escuras levam o tom de ink; as claras, o de
   ink2. Quando ink2 não serve como segundo tom (cinza, ou a menos de
   25° de ink), as claras giram 20° na direção do creme (70°) e as
   escuras recuam 10° no sentido oposto: o fundo nunca sai
   monocromático, a luz sobre a tinta esquenta (como no esboço
   aprovado, vermelho com realce creme) e o verde escuro não vira oliva.

   Puro e testável; paintLayers não aloca (escreve em `out`).
   ============================================================ */

export const PAINT_LAYERS = 6;

/** L do OKLab por camada, da mais funda à mais clara. Y (luminância
    relativa) fica perto de L³: ~0,003 na funda e ~0,49 na clara. */
export const PAINT_L = [0.15, 0.3, 0.43, 0.55, 0.67, 0.79] as const;

/** Teto de croma: tinta saturada demais vira néon atrás da interface. */
const C_MAX_DARK = 0.2;
const C_MAX_LIGHT = 0.17;
/** Abaixo disso o acento não é segundo tom: está perto demais de ink. */
const MIN_HUE_GAP = 25;
const HUE_SHIFT = 20;
/** No mesmo caso, as escuras recuam do creme: o verde-limão escuro não
    vira oliva (CEO, 11/10: "mais saturado no verde"). */
const HUE_BACK = 10;
const CREAM_HUE = 70;

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Luminância relativa (WCAG) de um sRGB 0..1. */
export function relLuminance(r: number, g: number, b: number): number {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

export interface Oklch {
  l: number;
  c: number;
  /** Graus, 0..360. */
  h: number;
}

export function srgbToOklch(r: number, g: number, b: number): Oklch {
  const lr = toLin(r), lg = toLin(g), lb = toLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** OKLCH -> sRGB linear em (r,g,b) de `out` a partir de `o`. */
function oklchToLin(L: number, C: number, hDeg: number, out: Float32Array, o: number): void {
  const hr = (hDeg * Math.PI) / 180;
  const A = C * Math.cos(hr), B = C * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  out[o] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[o + 1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[o + 2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

const inGamut = (out: Float32Array, o: number) =>
  out[o] >= -1e-5 && out[o] <= 1 + 1e-5 && out[o + 1] >= -1e-5 && out[o + 1] <= 1 + 1e-5 && out[o + 2] >= -1e-5 && out[o + 2] <= 1 + 1e-5;

/** Escreve em out[o..o+2] o sRGB 0..1 de OKLCH(L, C, h), reduzindo o
    croma (busca binária) até caber no sRGB. L e h se preservam. */
function writeOklch(L: number, C: number, h: number, out: Float32Array, o: number): void {
  oklchToLin(L, C, h, out, o);
  if (!inGamut(out, o)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      oklchToLin(L, mid, h, out, o);
      if (inGamut(out, o)) lo = mid;
      else hi = mid;
    }
    oklchToLin(L, lo, h, out, o);
  }
  for (let i = 0; i < 3; i++) {
    const v = out[o + i] < 0 ? 0 : out[o + i] > 1 ? 1 : out[o + i];
    out[o + i] = toSrgb(v);
  }
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Interpola matiz pelo arco mais curto. */
function mixHue(a: number, b: number, t: number): number {
  let d = (((b - a) % 360) + 540) % 360 - 180;
  const h = a + d * t;
  return ((h % 360) + 360) % 360;
}

/** Gira `h` de `by` graus na direção (arco mais curto) de `toward`. */
function rotateToward(h: number, toward: number, by: number): number {
  const d = (((toward - h) % 360) + 540) % 360 - 180;
  return (((h + Math.sign(d || 1) * by) % 360) + 360) % 360;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * As 6 camadas da Tinta em sRGB 0..1, da mais funda à mais clara,
 * escritas em `out` (length >= 18). `ink` e `ink2` em sRGB 0..1.
 */
export function paintLayers(ink: ArrayLike<number>, ink2: ArrayLike<number>, out: Float32Array): void {
  const a = srgbToOklch(ink[0], ink[1], ink[2]);
  const b = srgbToOklch(ink2[0], ink2[1], ink2[2]);
  let hA = a.h;
  let hB = b.h;
  let cB = b.c;
  if (b.c < 0.03 || hueDist(a.h, b.h) < MIN_HUE_GAP) {
    hB = rotateToward(a.h, CREAM_HUE, HUE_SHIFT);
    hA = rotateToward(a.h, CREAM_HUE, -HUE_BACK);
    cB = a.c;
  }
  const cA = Math.min(a.c, C_MAX_DARK);
  cB = Math.min(cB, C_MAX_LIGHT);
  for (let k = 0; k < PAINT_LAYERS; k++) {
    const t = k / (PAINT_LAYERS - 1);
    const w = smooth(0.35, 0.85, t);
    const L = PAINT_L[k];
    // Camada funda tem menos croma (tinta escura é densa, não néon).
    const C = (cA * (1 - w) + cB * w) * (0.7 + 0.3 * Math.min(1, t * 2));
    writeOklch(L, C, mixHue(hA, hB, w), out, k * 3);
  }
}
