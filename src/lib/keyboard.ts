/* ============================================================
   lib/keyboard.ts — filtro único dos atalhos globais de teclado.

   Atalho de uma letra (N, H, L, Q...) não pode disparar enquanto o
   usuário digita: campo de texto, <select> (a busca por letra do
   próprio select), elemento editável ou composição de IME (acento
   morto, teclado asiático). Antes cada listener ignorava só input e
   textarea, e o typeahead do select de fonte do Tweaks trocava de
   tela (auditoria de UI 25/09: shell-13, cfg-10, nowplaying-v4).
   ============================================================ */

const TYPING_TAGS = new Set(["input", "textarea", "select"]);

/** true quando a tecla pertence ao que o usuário está digitando e o
    atalho global deve ser ignorado. */
export function isTypingContext(e: KeyboardEvent): boolean {
  if (e.isComposing) return true;
  const t = e.target as HTMLElement | null;
  if (!t || typeof t.tagName !== "string") return false;
  if (TYPING_TAGS.has(t.tagName.toLowerCase())) return true;
  if (t.isContentEditable) return true;
  // jsdom não implementa isContentEditable; o closest cobre filho de
  // host editável nos dois ambientes.
  return !!t.closest?.('[contenteditable]:not([contenteditable="false"])');
}
