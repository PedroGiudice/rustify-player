/* ============================================================
   lib/animatedColorProps.ts — registra as cores dinâmicas como
   custom properties tipadas (<color>) via CSS.registerProperty.

   Sem registro, custom property é string opaca e a `transition`
   declarada no :root (extractor-lab.css) é ignorada — a troca de
   cor corta seco. Registrada, o compositor interpola: accent
   adaptativo, ink e troca de tema fazem crossfade nativo, e
   getComputedStyle devolve o valor EM TRANSIÇÃO (o EqCanvas lê
   isso direto). Validado no WebKitGTK real via probe MCP
   (2026-07-05: rgb intermediário correto no meio da transição).

   initialValue: o valor computado no boot quando existir (tema já
   aplicado), senão o default do design system — só vale quando a
   var está unset (ex: "sem tema").
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
