/* ============================================================
   lib/canvasInk.ts — Tokens de cor do tema para o canvas 2D.

   O canvas não lê CSS: quem desenha precisa da cor resolvida. Um
   <span> de sonda recebe `color: var(--token)` e o computed style
   devolve rgb()/rgba() já substituído (vale para hex, rgba e
   color-mix do tema), formato que o fillStyle sempre aceita.

   Custo: um getComputedStyle por token. Ler no mount e de novo só
   quando o tema ou o acento mudam (watchCanvasInk), nunca por quadro.
   ============================================================ */

/** Token CSS -> cor de repouso, usada quando o token não resolve
    (jsdom, var ausente). */
export type InkSpec<K extends string> = Record<K, { token: string; fallback: string }>;

export function readCanvasInk<K extends string>(
  host: Element | null,
  spec: InkSpec<K>,
): Record<K, string> {
  const out = {} as Record<K, string>;
  const parent = host ?? (typeof document !== "undefined" ? document.body : null);
  if (!parent || typeof getComputedStyle === "undefined") {
    for (const k in spec) out[k] = spec[k].fallback;
    return out;
  }
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.display = "none";
  parent.appendChild(probe);
  try {
    for (const k in spec) {
      const { token, fallback } = spec[k];
      probe.style.color = "";
      probe.style.color = `var(${token}, ${fallback})`;
      const c = getComputedStyle(probe).color.trim();
      out[k] = c && !c.includes("var(") ? c : fallback;
    }
  } finally {
    probe.remove();
  }
  return out;
}

/** Avisa quando a tinta pode ter mudado: tema aplicado (evento do
    applyTheme) ou var inline escrita no <html> (acento da capa e ink do
    store/tweaks). Só sinaliza; quem desenha relê no próximo draw. */
export function watchCanvasInk(onChange: () => void): () => void {
  const onTheme = () => onChange();
  window.addEventListener("rustify:theme-applied", onTheme);
  let mo: MutationObserver | null = null;
  if (typeof MutationObserver !== "undefined") {
    mo = new MutationObserver(() => onChange());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }
  return () => {
    window.removeEventListener("rustify:theme-applied", onTheme);
    mo?.disconnect();
  };
}
