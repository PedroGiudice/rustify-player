/* ============================================================
   gl/palette.ts — as quatro cores que as cenas WebGL consomem.

   Nenhuma cor é inventada aqui: tudo vem das CSS vars que o
   app já resolve, então tema, capa (adaptiveInk/adaptiveAccent)
   e knob do usuário continuam mandando no fundo WebGL exatamente
   como mandam no Canvas 2D.

     canvas ← --bg-canvas          (superfície do tema; clear color)
     ink    ← --bg-ink-rgb         (precedência usuário > capa > tema,
                                    já com o piso WCAG do store)
     ink2   ← --primary            (accent; segue a capa quando
                                    adaptiveAccent está ligado)
     soft   ← --fg-5               (tom neutro pros realces de agudo)

   Leitura por callback (e não getComputedStyle direto) pra manter
   o módulo puro e testável — o componente passa o leitor real.
   ============================================================ */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface GlPalette {
  canvas: Rgb;
  ink: Rgb;
  ink2: Rgb;
  soft: Rgb;
}

/** Fallbacks quando o tema ainda não aplicou (primeiros frames do boot). */
const FALLBACK: GlPalette = {
  canvas: { r: 17, g: 17, b: 16 },
  ink: { r: 198, g: 99, b: 61 },
  ink2: { r: 216, g: 122, b: 82 },
  soft: { r: 133, g: 130, b: 123 },
};

const HEX6 = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
const HEX3 = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
const TRIPLE = /^(?:rgba?\()?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,.*)?\)?$/;

/** Converte o que as CSS vars do app entregam em RGB 0..255, ou null. */
export function parseColor(raw: string): Rgb | null {
  const v = (raw ?? "").trim();
  if (!v) return null;

  const h6 = HEX6.exec(v);
  if (h6) return { r: parseInt(h6[1], 16), g: parseInt(h6[2], 16), b: parseInt(h6[3], 16) };

  const h3 = HEX3.exec(v);
  if (h3) {
    return {
      r: parseInt(h3[1] + h3[1], 16),
      g: parseInt(h3[2] + h3[2], 16),
      b: parseInt(h3[3] + h3[3], 16),
    };
  }

  const t = TRIPLE.exec(v);
  if (t) {
    const r = Math.round(parseFloat(t[1]));
    const g = Math.round(parseFloat(t[2]));
    const b = Math.round(parseFloat(t[3]));
    if ([r, g, b].every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) return { r, g, b };
  }
  return null;
}

/** Clareia em direção ao branco (0..1). Usado só quando não há accent. */
function lighten(c: Rgb, amount: number): Rgb {
  return {
    r: Math.round(c.r + (255 - c.r) * amount),
    g: Math.round(c.g + (255 - c.g) * amount),
    b: Math.round(c.b + (255 - c.b) * amount),
  };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

export type VarReader = (name: string) => string;

/** De onde cada papel sai. Lista = ordem de preferência (a primeira que
    parsear vence). Desktop e mobile têm design systems diferentes; as
    cenas são as mesmas. */
export interface PaletteVars {
  canvas: readonly string[];
  ink: readonly string[];
  ink2: readonly string[];
  soft: readonly string[];
}

export const DESKTOP_VARS: PaletteVars = {
  canvas: ["--bg-canvas"],
  ink: ["--bg-ink-rgb", "--bg-ink"],
  ink2: ["--primary"],
  soft: ["--fg-5"],
};

export const MOBILE_VARS: PaletteVars = {
  canvas: ["--s-base"],
  ink: ["--bg-ink-rgb"],
  ink2: ["--accent"],
  soft: ["--accent-dim"],
};

function first(read: VarReader, names: readonly string[]): Rgb | null {
  for (const n of names) {
    const c = parseColor(read(n));
    if (c) return c;
  }
  return null;
}

export function readGlPalette(read: VarReader, vars: PaletteVars = DESKTOP_VARS): GlPalette {
  const canvas = first(read, vars.canvas) ?? FALLBACK.canvas;
  const ink = first(read, vars.ink) ?? FALLBACK.ink;
  // Sem accent utilizável, ink2 é o próprio ink clareado — dois tons da
  // mesma tinta, nunca a mesma cor duplicada (as cenas usam o par pra
  // criar profundidade).
  const ink2 = first(read, vars.ink2) ?? lighten(ink, 0.28);
  const soft = first(read, vars.soft) ?? mix(ink, canvas, 0.5);
  return { canvas, ink, ink2, soft };
}
