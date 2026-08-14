/* ============================================================
   adaptiveColor.ts — ink do bg + accents da UI seguem a cor
   dominante da capa da faixa tocando (pedido do CEO, 14/08:
   "small shit makes THE difference").

   A derivação é a MESMA do desktop (lib/inkDerive.ts, v3
   contrast-driven): hue da capa, saturação reforçada, luminância
   levada a >= 4:1 contra o canvas. A dominante vem pronta no
   manifest (`dominant_color`, enrichment cover.rs exportado) —
   o aparelho não analisa imagem.

   Aplicação:
   - `--bg-ink-rgb`: o canvas do spectrum já lê a var a cada ~20
     frames e faz lerp interno (tau 0.35s) — trocar o valor basta.
   - accents: --accent/--accent-c/--on-accent/--on-accent-c no
     :root. Capa acromática ou sem dominante → removeProperty
     (voltam os defaults do tokens.css).
   ============================================================ */

import { deriveAccent, deriveInk } from "../lib/inkDerive";
import { hexToHsl } from "../lib/color";

/** Canvas do tema mobile (tokens.css). Lido uma vez — o mobile tem tema
    único; se um dia houver temas, ler de novo no apply. */
let baseInk: string | null = null;

function themeBase(): string {
  if (baseInk) return baseInk;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--s-base").trim();
  baseInk = /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : "#0c0c0c";
  return baseInk;
}

function hexToRgbTriplet(hex: string): string | null {
  const h = hexToHsl(hex);
  if (!h) return null;
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const ACCENT_VARS = ["--accent", "--accent-c", "--on-accent", "--on-accent-c"] as const;

export function applyAdaptiveColor(dominant: string | null | undefined) {
  const root = document.documentElement.style;
  if (!dominant) {
    root.removeProperty("--bg-ink-rgb");
    for (const v of ACCENT_VARS) root.removeProperty(v);
    return;
  }
  const base = themeBase();

  const ink = deriveInk(dominant, base);
  const triplet = ink ? hexToRgbTriplet(ink) : null;
  if (triplet) root.setProperty("--bg-ink-rgb", triplet);
  else root.removeProperty("--bg-ink-rgb");

  const acc = deriveAccent(dominant, base);
  if (acc) {
    root.setProperty("--accent", acc.accent);
    root.setProperty("--accent-c", acc.container);
    root.setProperty("--on-accent", acc.on);
    root.setProperty("--on-accent-c", acc.on);
  } else {
    for (const v of ACCENT_VARS) root.removeProperty(v);
  }
}
