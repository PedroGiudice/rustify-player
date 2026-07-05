/* ============================================================
   lib/adaptiveInk.ts — Ink adaptativo: o bg animado (e as linhas
   do spectrum) seguem a cor dominante da capa da faixa tocando.

   Fluxo: TrackStarted atualiza player.currentTrackInfo → effect
   busca current_library_track (id) via getState → getTrackColor
   (enrichment dominant_color no backend, com fallback que computa
   da capa e persiste) → deriveInk normaliza pro papel de ink →
   setAdaptiveColor (store/tweaks resolve precedência e anima).

   A cor dominante vem de média (resize 1x1) — capas multicoloridas
   tendem ao lamacento. deriveInk clampa luminância na faixa útil de
   ink do tema e garante saturação mínima, salvando a maioria.
   ============================================================ */

import { createEffect, createRoot } from "solid-js";
import { player } from "../store/player";
import { tweaks, setAdaptiveColor, themeInkBase } from "../store/tweaks";
import { getState, getTrackColor } from "../tauri";

// ── Cor: hex ↔ HSL ────────────────────────────────────────────

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
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

function hslToHex(h: number, s: number, l: number): string {
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

// ── Derivação ─────────────────────────────────────────────────

/** Normaliza a cor dominante da capa pro papel de ink: mantém o hue,
    clampa a luminância na faixa útil do tema (dark → ink escuro; light →
    ink claro) e garante saturação mínima quando a cor tem croma. Capas
    acromáticas (s < 0.05) ficam acromáticas — cinza é identidade também. */
export function deriveInk(coverHex: string, baseInkHex: string): string | null {
  const cover = hexToHsl(coverHex);
  if (!cover) return null;
  const base = hexToHsl(baseInkHex);
  const darkTheme = (base?.l ?? 0.1) < 0.5;
  const [lMin, lMax] = darkTheme ? [0.10, 0.32] : [0.55, 0.85];
  const l = Math.min(lMax, Math.max(lMin, cover.l));
  const s = cover.s < 0.05 ? cover.s : Math.max(0.15, Math.min(0.85, cover.s));
  return hslToHex(cover.h, s, l);
}

// ── Wiring ────────────────────────────────────────────────────

let _reqSeq = 0;

async function fetchAndApply(retryLeft = 1): Promise<void> {
  const seq = ++_reqSeq;
  try {
    const snap = await getState();
    const track = snap.current_library_track;
    if (seq !== _reqSeq) return; // faixa já trocou de novo
    if (!track) {
      // TrackStarted chega um tick antes do snapshot popular a library
      // track em algumas trocas — um retry curto cobre o gap.
      if (retryLeft > 0) setTimeout(() => { void fetchAndApply(retryLeft - 1); }, 300);
      else setAdaptiveColor(null);
      return;
    }
    const hex = await getTrackColor(String(track.id));
    if (seq !== _reqSeq) return;
    setAdaptiveColor(hex ? deriveInk(hex, themeInkBase()) : null);
  } catch {
    if (seq === _reqSeq) setAdaptiveColor(null);
  }
}

/** Liga o ink adaptativo. Chamar uma vez no boot (main.tsx). */
export function wireAdaptiveInk() {
  createRoot(() => {
    createEffect(() => {
      const on = tweaks().adaptiveInk;
      // Registra dependência na troca de faixa (TrackStarted seta
      // currentTrackInfo; path muda por faixa).
      const path = player.currentTrackInfo?.path ?? null;
      if (!on || !path) { setAdaptiveColor(null); return; }
      void fetchAndApply();
    });
  });
}
