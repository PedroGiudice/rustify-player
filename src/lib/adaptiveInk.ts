/* ============================================================
   lib/adaptiveInk.ts — Ink adaptativo: o bg animado (e as linhas
   do spectrum) seguem a cor dominante da capa da faixa tocando.
   Opcionalmente o ACCENT da UI (--primary e família) segue junto.

   Fluxo: TrackStarted atualiza player.currentTrackInfo → effect
   busca current_library_track (id) via getState → getTrackPalette
   (enrichment dominant_palette_v4 no backend — até 3 famílias de
   hue por densidade, [0] = dominante; fallback computa da capa e
   persiste) → deriveInk/deriveAccent normalizam pros papéis →
   setAdaptiveColor/setAdaptiveAccent (store/tweaks resolve
   precedência e aplica). Com o knob bgInkCycle (Tweaks) e paleta
   2+, o ink do bg ALTERNA entre as cores a cada ~40s (crossfade
   nativo); o accent da UI fica fixo na dominante.

   v3: derivação orientada a CONTRASTE. A v2 ancorava a luminância
   do ink na "profundidade do tema" (themeL + 0.24) — como todos os
   temas declaram background.ink = canvas, o ink nascia colado no
   fundo (capa escura → 1.2:1, invisível). Agora o alvo é razão de
   contraste mínima contra o canvas do tema; a luminância sobe (ou
   desce, em tema claro) até o alvo, preservando o hue da capa.
   ============================================================ */

import { createEffect, createRoot, createSignal } from "solid-js";
import { player } from "../store/player";
import {
  tweaks,
  setAdaptiveColor,
  setAdaptiveAccent,
  themeInkBase,
  type AdaptiveAccent,
} from "../store/tweaks";
import { getState, getTrackPalette } from "../tauri";
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

// Derivação pura movida pra lib/inkDerive.ts (14/08 — compartilhada com o
// mobile, que não pode arrastar os stores do desktop). Re-export mantém os
// consumidores/testes existentes.
export { deriveInk, deriveAccent } from "./inkDerive";
import { deriveInk, deriveAccent } from "./inkDerive";

// ── Wiring ────────────────────────────────────────────────────

/** Período do ciclo de cores do bg (paleta da capa). */
const INK_CYCLE_MS = 40_000;
/** Tau (s) da deriva de cor DO CICLO — bem mais lento que o lerp padrão
    (0.35s, troca de faixa/tema): a cor migra ao longo de ~10s, deriva
    ambiental em vez de evento. Anunciado ao canvas via --bg-ink-morph. */
const INK_CYCLE_MORPH_TAU = 3.5;

let _reqSeq = 0;
// Paleta BRUTA da capa da faixa corrente (até 3 cores, ordenadas por
// densidade — [0] é a dominante). Guardada pra re-derivar quando o TEMA
// troca mid-track (os alvos de contraste dependem do canvas do tema —
// sem re-derivação as cores ficariam calibradas pro tema antigo).
let _lastPalette: string[] | null = null;

// Inks DERIVADOS (contraste garantido) da paleta corrente — signal pra
// o effect do ciclo reagir a troca de faixa/tema sem re-derivar por tick.
const [derivedInks, setDerivedInks] = createSignal<string[] | null>(null);
let _cycleIdx = 0;

function applyDerived(palette: string[] | null) {
  _lastPalette = palette && palette.length ? palette : null;
  _cycleIdx = 0;
  // Mudança de faixa/tema/toggle: volta o lerp da tinta pro tau rápido
  // (o tau longo é só da deriva do ciclo).
  document.documentElement.style.removeProperty("--bg-ink-morph");
  if (!_lastPalette) {
    setDerivedInks(null);
    setAdaptiveColor(null);
    setAdaptiveAccent(null);
    return;
  }
  const base = themeInkBase();
  // Cada cor da paleta passa pelo MESMO piso de contraste da dominante;
  // dedup mantém o ciclo honesto (cores que derivam pro mesmo ink não
  // contam duas vezes).
  const inks = [...new Set(
    _lastPalette.map((hex) => deriveInk(hex, base)).filter((c): c is string => !!c),
  )];
  setDerivedInks(inks.length ? inks : null);
  // Sempre COMEÇA na dominante; o accent da UI fica FIXO nela (chips e
  // botões trocando de cor a cada ciclo seria ruído — o bg é ambiental,
  // a UI não).
  setAdaptiveColor(inks[0] ?? null);
  setAdaptiveAccent(deriveAccent(_lastPalette[0], base));
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
    const palette = await getTrackPalette(String(track.id));
    if (seq !== _reqSeq) return;
    applyDerived(palette?.length ? palette : null);
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

    // Ciclo de cores do bg: com 2+ inks derivados e o knob ligado, alterna
    // a cada INK_CYCLE_MS voltando sempre pra dominante ([0]) no wrap. O
    // crossfade visual é dos CANVASES (lerp local por frame, lib/rgbLerp) —
    // a var salta; transition CSS em custom property no :root é proibida
    // (restyle global por frame no WebKitGTK, fps pela metade). Troca de
    // faixa/tema recria a paleta → applyDerived reseta pro índice 0.
    let cycleTimer: ReturnType<typeof setInterval> | undefined;
    createEffect(() => {
      const inks = derivedInks();
      const t = tweaks();
      clearInterval(cycleTimer);
      cycleTimer = undefined;
      if (!t.adaptiveInk || !t.bgInkCycle || !inks || inks.length < 2) return;
      cycleTimer = setInterval(() => {
        _cycleIdx = (_cycleIdx + 1) % inks.length;
        // Deriva lenta: anuncia o tau longo ANTES de trocar a cor — o
        // canvas lê --bg-ink-morph no batch de 3Hz e suaviza o lerp.
        document.documentElement.style.setProperty(
          "--bg-ink-morph",
          String(INK_CYCLE_MORPH_TAU),
        );
        setAdaptiveColor(inks[_cycleIdx]);
      }, INK_CYCLE_MS);
    });
  });
  // Tema trocou mid-track: re-deriva a paleta da capa contra o canvas do
  // tema novo (tweaks.ts registra o listener dele primeiro, então
  // themeInkBase() já reflete o tema novo quando este handler roda).
  window.addEventListener("rustify:theme-applied", () => {
    if (_lastPalette && (tweaks().adaptiveInk || tweaks().adaptiveAccent)) {
      applyDerived(_lastPalette);
    }
  });
}
