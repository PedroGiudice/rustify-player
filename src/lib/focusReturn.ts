/* ============================================================
   lib/focusReturn.ts — foco de quem abre e fecha por cima da vista.

   Menu de contexto, diálogo Mover, gaveta da fila e SelectionBar
   tiravam o foco do lugar e, ao fechar, ele caía no <body>: a próxima
   Tab recomeçava do topo da janela. Aqui:

   - rememberFocus() guarda onde o foco estava ao abrir e devolve
     restore(); restore só age se o foco ainda está DENTRO do overlay
     que fecha (ou caiu no <body> porque o overlay saiu do DOM). Quem
     fechou clicando em outro lugar já mandou o foco para lá: não se
     rouba esse foco de volta.
   - trapTab() prende o Tab dentro de um contêiner (diálogo modal).
   - focusables() lista o que recebe foco, na ordem do DOM.
   ============================================================ */

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
].join(",");

/** Elementos focáveis de `root`, na ordem do DOM, sem os ocultos por `hidden`/`inert`. */
export function focusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden], [inert]"),
  );
}

/** Prende o Tab em `root`: do último volta ao primeiro, e vice-versa com Shift.
    Chamar no keydown do contêiner. Devolve true quando tratou o evento. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== "Tab") return false;
  const list = focusables(root);
  if (list.length === 0) { e.preventDefault(); root.focus(); return true; }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && root.contains(active);
  if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); return true; }
  if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); return true; }
  return false;
}

export interface FocusReturn {
  /** Devolve o foco a quem o tinha ao abrir (ou ao `fallback`). Com `within`,
      só age se o foco atual está dentro dele ou caiu no <body>. */
  restore(opts?: { within?: Element | null }): void;
}

function usable(el: Element | null): el is HTMLElement {
  return !!el && el instanceof HTMLElement && el !== document.body && el.isConnected
    && !el.closest("[inert]");
}

/** Guarda o elemento focado agora. `fallback` responde quando ele sumiu ou era o <body>. */
export function rememberFocus(fallback?: () => HTMLElement | null): FocusReturn {
  const saved = document.activeElement;
  return {
    restore(opts) {
      const within = opts?.within ?? null;
      const now = document.activeElement;
      if (within && now && now !== document.body && !within.contains(now)) return;
      const target = usable(saved) && !(within && within.contains(saved)) ? saved : fallback?.() ?? null;
      if (usable(target)) target.focus({ preventScroll: true });
    },
  };
}
