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

   Com o fundo WebGL o vidro não tem UMA cor atrás: a cena pinta ink e
   ink2 sobre o preto (A3, 26/10/2026: medir só contra o preto deixava a
   letra a 1,9-2,6:1 quando a Tinta passava rosa). O NowPlaying entrega
   as superfícies plausíveis e cada tom tem de passar contra todas: texto
   claro se mede contra o vidro mais claro, texto escuro contra o mais
   escuro.
   ============================================================ */

import { contrastRatio, hexToHsl, hslToHex, relLuminance } from "./color";

export type LyricsInkVar = "--fg-1" | "--fg-2" | "--fg-4" | "--fg-5" | "--fg-6";

type Rgb = { r: number; g: number; b: number };

/** A escala quente de desenho do card (o que o CSS fixava). */
export const LYRICS_DESIGN_INK: Readonly<Record<LyricsInkVar, string>> = {
  "--fg-1": "#f5f3ee",
  "--fg-2": "#e0dcd2",
  "--fg-4": "#b6b1a5",
  "--fg-5": "#8a857a",
  "--fg-6": "#6f6a60",
};

/** Piso de contraste contra o vidro, por papel no card. */
export const LYRICS_MIN_RATIO: Readonly<Record<LyricsInkVar, number>> = {
  "--fg-1": 4.5, // linha ativa (parte do extremo da escala, fica bem acima)
  "--fg-2": 4.5, // letra corrida sem sincronismo
  "--fg-4": 4.5, // próxima linha
  // Linhas distantes, cabeçalho do card ("Lyrics", "aligned") e de seção.
  // A linha distante bastaria 3:1, mas divide o tom com rótulos de 11 px.
  "--fg-5": 4.5,
  "--fg-6": 3, // alça de resize (não é texto)
};

/** Tons das linhas da letra, do mais apagado ao mais forte. */
const LINE_CHAIN: readonly LyricsInkVar[] = ["--fg-5", "--fg-4", "--fg-1"];
/** Ordem de cálculo: a cadeia das linhas primeiro, de baixo para cima. */
const INK_ORDER: readonly LyricsInkVar[] = ["--fg-5", "--fg-4", "--fg-1", "--fg-2", "--fg-6"];
/** Distância mínima de contraste entre degraus da cadeia (razão). */
const LINE_STEP = 1.2;

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

/** Escala de texto do card para uma superfície de vidro, ou para várias
    (fundo WebGL): o lado do texto sai da mais escura (havendo vidro
    escuro, o texto é claro) e o piso se mede contra a que mais o aperta. */
export function lyricsInk(surfaces: Rgb | Rgb[]): Record<LyricsInkVar, string> {
  const list = Array.isArray(surfaces) ? surfaces : [surfaces];
  const hexes = list.map(toHex);
  const ys = hexes.map((h) => relLuminance(h) ?? 0);
  const lightText = Math.min(...ys) < 0.18;
  // Texto claro perde contraste no vidro mais claro; escuro, no mais escuro.
  const pick = ys.indexOf(lightText ? Math.max(...ys) : Math.min(...ys));
  const surfaceHex = hexes[pick];
  const baseY = ys[pick];
  const surfaceL = hexToHsl(surfaceHex)?.l ?? 0;
  const out = {} as Record<LyricsInkVar, string>;
  const ratioOf = (hex: string) => contrastRatio(relLuminance(hex) ?? 0, baseY);
  // Distante → próxima → ativa: com o piso de 4,5:1 nas três, o vidro claro
  // as achatava no mesmo tom (a próxima chegava a ficar abaixo da distante).
  // Cada degrau da cadeia mira pelo menos LINE_STEP vezes o anterior.
  let prev = 0;
  for (const v of INK_ORDER) {
    const target = LINE_CHAIN.includes(v)
      ? Math.max(LYRICS_MIN_RATIO[v], prev * LINE_STEP)
      : LYRICS_MIN_RATIO[v];
    const hsl = hexToHsl(LYRICS_DESIGN_INK[v])!;
    if (lightText) {
      out[v] = walk(hsl.h, hsl.s, hsl.l, 1, baseY, target);
    } else {
      // Espelho da escala, começando sempre do lado escuro da superfície
      // (um tom claro espelhado podia nascer mais claro que o vidro).
      const start = Math.max(0, Math.min(1 - hsl.l, surfaceL - 0.02));
      out[v] = walk(hsl.h, hsl.s, Math.round(start * 100) / 100, -1, baseY, target);
    }
    if (LINE_CHAIN.includes(v)) prev = ratioOf(out[v]);
  }
  return out;
}
