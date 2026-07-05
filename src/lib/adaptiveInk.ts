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
    ancora a luminância NO INK DO TEMA ATUAL (o bg da capa fica na mesma
    "profundidade" do tema: really-dark segue profundo, temas mais claros
    ganham ink com mais presença) e reforça a saturação — a cor média de
    capa tende ao lamacento, então boost 1.6x com piso 0.35. Capas
    acromáticas (s < 0.05) ficam acromáticas — cinza é identidade também. */
export function deriveInk(coverHex: string, baseInkHex: string): string | null {
  const cover = hexToHsl(coverHex);
  if (!cover) return null;
  const base = hexToHsl(baseInkHex);
  const themeL = base?.l ?? 0.09;
  const darkTheme = themeL < 0.5;
  const [lMin, lMax] = darkTheme
    ? [Math.max(0.10, themeL), Math.min(0.45, themeL + 0.24)]
    : [Math.max(0.50, themeL - 0.24), Math.min(0.90, themeL)];
  const l = Math.min(lMax, Math.max(lMin, cover.l));
  const s = cover.s < 0.05 ? cover.s : Math.max(0.35, Math.min(0.90, cover.s * 1.6));
  return hslToHex(cover.h, s, l);
}

// ── Wiring ────────────────────────────────────────────────────

let _reqSeq = 0;
// Cor BRUTA da capa da faixa corrente. Guardada pra re-derivar quando o
// TEMA troca mid-track (a faixa de luminância do deriveInk depende do
// ink do tema — sem re-derivação a cor ficaria presa na faixa antiga).
let _lastCoverHex: string | null = null;

async function fetchAndApply(expectedPath: string, retryLeft = 5): Promise<void> {
  const seq = ++_reqSeq;
  const retry = () => {
    if (retryLeft > 0) setTimeout(() => { void fetchAndApply(expectedPath, retryLeft - 1); }, 300);
    else { _lastCoverHex = null; setAdaptiveColor(null); }
  };
  try {
    const snap = await getState();
    const track = snap.current_library_track;
    if (seq !== _reqSeq) return; // faixa já trocou de novo
    // TrackStarted chega um tick antes do snapshot atualizar — o snapshot
    // pode vir vazio OU ainda com a faixa ANTERIOR. Validar contra o path
    // que disparou o effect evita aplicar a cor da capa errada num skip.
    if (!track || track.path !== expectedPath) { retry(); return; }
    const hex = await getTrackColor(String(track.id));
    if (seq !== _reqSeq) return;
    _lastCoverHex = hex || null;
    setAdaptiveColor(hex ? deriveInk(hex, themeInkBase()) : null);
  } catch {
    if (seq === _reqSeq) { _lastCoverHex = null; setAdaptiveColor(null); }
  }
}

/** Liga o ink adaptativo. Chamar uma vez no boot (main.tsx). */
export function wireAdaptiveInk() {
  createRoot(() => {
    let prevOn: boolean | null = null;
    let prevPath: string | null = null;
    createEffect(() => {
      const on = tweaks().adaptiveInk;
      // Registra dependência na troca de faixa (TrackStarted seta
      // currentTrackInfo; path muda por faixa).
      const path = player.currentTrackInfo?.path ?? null;
      // tweaks() é um signal de objeto inteiro: QUALQUER knob re-roda este
      // effect. Só age quando o que importa (on/path) de fato mudou —
      // senão o arrasto de um slider viraria burst de IPCs.
      if (on === prevOn && path === prevPath) return;
      prevOn = on; prevPath = path;
      if (!on || !path) { _lastCoverHex = null; setAdaptiveColor(null); return; }
      void fetchAndApply(path);
    });
  });
  // Tema trocou mid-track: re-deriva a cor da capa contra o ink do tema
  // novo (tweaks.ts registra o listener dele primeiro, então themeInkBase()
  // já reflete o tema novo quando este handler roda).
  window.addEventListener("rustify:theme-applied", () => {
    if (_lastCoverHex && tweaks().adaptiveInk) {
      setAdaptiveColor(deriveInk(_lastCoverHex, themeInkBase()));
    }
  });
}
