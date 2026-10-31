// src/lib/tabKeys.ts — teclado das abas (Library e Crate), padrão de abas
// do WAI-ARIA (A36, varredura de 31/10).
//
// As abas tinham role="tab" mas não respondiam às setas: o Tab passava por
// cada uma e as setas não faziam nada. No padrão, a lista de abas é UMA
// parada do Tab (só a ativa tem tabindex 0); setas esquerda/direita andam
// entre elas dando a volta, Home e End vão às pontas, e a aba que recebe o
// foco já é selecionada (ativação automática: trocar de aba é barato).

/** A aba que a tecla leva, ou null se a tecla não é das abas. */
export function nextTabKey<T extends string>(keys: readonly T[], current: T, key: string): T | null {
  const n = keys.length;
  if (n === 0) return null;
  const i = Math.max(0, keys.indexOf(current));
  switch (key) {
    case "ArrowRight": return keys[(i + 1) % n];
    case "ArrowLeft": return keys[(i - 1 + n) % n];
    case "Home": return keys[0];
    case "End": return keys[n - 1];
    default: return null;
  }
}

/** onKeyDown da lista de abas: seleciona a aba da tecla e põe o foco nela
    (`idOf` dá o id do botão). Tecla com modificador passa adiante. */
export function tabKeyHandler<T extends string>(
  keys: readonly T[],
  current: () => T,
  select: (key: T) => void,
  idOf: (key: T) => string,
) {
  return (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const next = nextTabKey(keys, current(), e.key);
    if (next === null) return;
    e.preventDefault();
    select(next);
    document.getElementById(idOf(next))?.focus();
  };
}
