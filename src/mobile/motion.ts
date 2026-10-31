/* ============================================================
   motion.ts — "Remover animações" do Android (A53).

   O desktop lê a preferência em store/tweaks.ts; o S24 não carrega
   aquele store (arrastaria o Tweaks inteiro para o chunk mobile), então
   tem o próprio sinal, com a MESMA regra de calma do fundo:
     - WebGL: calmGlCfg (relógio a CALM_SPEED, beat-sync desligado),
       `calm` e `reduced` no host (gl/host.ts);
     - 2D: o mesmo fator no relógio e o kick zerado (`calmBgKnobs`).
   Calmo, não parado: o fundo segue respirando com as bandas.

   Sem matchMedia (jsdom, WebView antigo) o sinal fica falso e nada muda.
   ============================================================ */

import { createSignal } from "solid-js";
import { CALM_SPEED } from "../gl/signal";

const QUERY = "(prefers-reduced-motion: reduce)";

function init(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    return mq.matches;
  } catch {
    return false;
  }
}

const [reducedMotion, setReducedMotion] = createSignal(false);
setReducedMotion(init());
export { reducedMotion, setReducedMotion };

/** Knobs de movimento do fundo 2D sob a preferência: velocidade a
    CALM_SPEED e beat-sync desligado (sem kick, sem pulso). */
export function calmBgKnobs(
  k: { speed: number; beatSync: number },
  reduced: boolean,
): { speed: number; beatSync: number } {
  return reduced ? { speed: k.speed * CALM_SPEED, beatSync: 0 } : k;
}

/** Rolagem programática: suave só sem a preferência. */
export const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");
