/* ============================================================
   lib/animatedColorProps.ts — registra as cores dinâmicas como
   custom properties tipadas (<color>) via CSS.registerProperty.

   HISTÓRICO: o registro existia pra habilitar `transition` dessas
   props no :root (crossfade nativo). Essa transition foi REMOVIDA
   em 2026-07-17: animar custom property herdada no root força
   restyle da árvore inteira por frame no WebKitGTK — medido no app
   real: 60fps -> 29fps durante os 480ms, stall de 382ms. Hoje as
   vars saltam; a suavidade é local (canvases via lib/rgbLerp.ts,
   consumidores DOM via transition nas propriedades concretas).

   O registro permanece pelo initialValue: garante valor válido
   quando a var está unset (boot sem tema, consumidores color-mix
   sem fallback). Não reintroduzir transition nessas props.
   ============================================================ */

const COLOR_PROPS: ReadonlyArray<[name: string, fallback: string]> = [
  ["--bg-ink", "#171717"],
  ["--primary", "#2563eb"],
  ["--primary-container", "#3b82f6"],
  ["--primary-fixed-dim", "#3b82f6"],
  ["--on-primary", "#ffffff"],
  ["--on-primary-container", "#ffffff"],
  ["--blue-fg", "#2563eb"],
  ["--blue-ring", "#3b82f6"],
  ["--blue-bg", "#eff6ff"],
];

/** Chamar uma vez no boot (main.tsx), depois do CSS carregado. Idempotente
    por construção: re-registro lança e é engolido pelo catch. */
export function registerAnimatedColorProps() {
  if (typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return;
  const cs = getComputedStyle(document.documentElement);
  for (const [name, fallback] of COLOR_PROPS) {
    try {
      CSS.registerProperty({
        name,
        syntax: "<color>",
        inherits: true,
        initialValue: cs.getPropertyValue(name).trim() || fallback,
      });
    } catch {
      // já registrada (HMR/dev) ou valor inválido — segue sem transição nela
    }
  }
}
