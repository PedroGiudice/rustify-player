/* ============================================================
   lib/adaptiveInk.ts — Ink adaptativo: o bg animado (e as linhas
   do spectrum) seguem a cor dominante da capa da faixa tocando.
   Opcionalmente o ACCENT da UI (--primary e família) segue junto.

   Fluxo: TrackStarted atualiza player.currentTrackInfo → effect
   busca current_library_track (id) via getState → getTrackColor
   (enrichment dominant_color no backend, com fallback que computa
   da capa e persiste) → deriveInk/deriveAccent normalizam pros
   papéis → setAdaptiveColor/setAdaptiveAccent (store/tweaks
   resolve precedência e aplica).

   v3: derivação orientada a CONTRASTE. A v2 ancorava a luminância
   do ink na "profundidade do tema" (themeL + 0.24) — como todos os
   temas declaram background.ink = canvas, o ink nascia colado no
   fundo (capa escura → 1.2:1, invisível). Agora o alvo é razão de
   contraste mínima contra o canvas do tema; a luminância sobe (ou
   desce, em tema claro) até o alvo, preservando o hue da capa.
   ============================================================ */

import { createEffect, createRoot } from "solid-js";
import { player } from "../store/player";
import {
  tweaks,
  setAdaptiveColor,
  setAdaptiveAccent,
  themeInkBase,
  type AdaptiveAccent,
} from "../store/tweaks";
import { getState, getTrackColor } from "../tauri";
import {
  hexToHsl,
  hslToHex,
  relLuminance,
  contrastRatio,
  walkLForContrast,
} from "./color";

// Re-export pra consumidores/testes que conheciam estes nomes daqui.
export { relLuminance, contrastRatio };

// ── Derivação ─────────────────────────────────────────────────

/** Alvos de contraste vs canvas do tema. O ink é wash de fundo (os
    renderers multiplicam alpha por cima), o accent é UI interativa. */
const INK_CONTRAST_TARGET = 4.0;
const ACCENT_CONTRAST_TARGET = 4.0;

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

// ── Wiring ────────────────────────────────────────────────────

let _reqSeq = 0;
// Cor BRUTA da capa da faixa corrente. Guardada pra re-derivar quando o
// TEMA troca mid-track (os alvos de contraste dependem do canvas do tema —
// sem re-derivação a cor ficaria calibrada pro tema antigo).
let _lastCoverHex: string | null = null;

function applyDerived(hex: string | null) {
  _lastCoverHex = hex;
  setAdaptiveColor(hex ? deriveInk(hex, themeInkBase()) : null);
  setAdaptiveAccent(hex ? deriveAccent(hex, themeInkBase()) : null);
}

// O retry PRESERVA o seq da requisição original (achado da auditoria: a
// re-entrada fazia ++_reqSeq e o retry obsoleto da faixa anterior roubava
// o sequencial da corrente, matando o fetch da faixa nova — skip rápido
// A→B deixava B sem cor adaptativa). Retry stale morre no guard.
async function fetchAndApply(expectedPath: string, retryLeft = 5, seq = ++_reqSeq): Promise<void> {
  if (seq !== _reqSeq) return; // cadeia obsoleta: outra faixa assumiu
  const retry = () => {
    if (retryLeft > 0) {
      setTimeout(() => { void fetchAndApply(expectedPath, retryLeft - 1, seq); }, 300);
    } else if (seq === _reqSeq) {
      applyDerived(null);
    }
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
    applyDerived(hex || null);
  } catch {
    if (seq === _reqSeq) applyDerived(null);
  }
}

/** Liga o ink adaptativo. Chamar uma vez no boot (main.tsx). */
export function wireAdaptiveInk() {
  createRoot(() => {
    let prevOn: boolean | null = null;
    let prevPath: string | null = null;
    createEffect(() => {
      // Ink OU accent ligado justifica buscar a cor da capa; os resolvers
      // no store decidem individualmente o que aplicar.
      const t = tweaks();
      const on = t.adaptiveInk || t.adaptiveAccent;
      // Registra dependência na troca de faixa (TrackStarted seta
      // currentTrackInfo; path muda por faixa).
      const path = player.currentTrackInfo?.path ?? null;
      // tweaks() é um signal de objeto inteiro: QUALQUER knob re-roda este
      // effect. Só age quando o que importa (on/path) de fato mudou —
      // senão o arrasto de um slider viraria burst de IPCs.
      if (on === prevOn && path === prevPath) return;
      prevOn = on; prevPath = path;
      if (!on || !path) { applyDerived(null); return; }
      void fetchAndApply(path);
    });
  });
  // Tema trocou mid-track: re-deriva a cor da capa contra o canvas do tema
  // novo (tweaks.ts registra o listener dele primeiro, então themeInkBase()
  // já reflete o tema novo quando este handler roda).
  window.addEventListener("rustify:theme-applied", () => {
    if (_lastCoverHex && (tweaks().adaptiveInk || tweaks().adaptiveAccent)) {
      applyDerived(_lastCoverHex);
    }
  });
}
