/* ============================================================
   lib/selection.ts — Regras puras da seleção múltipla de faixas.
   Ids são sempre string (u64 do Qdrant passa de Number.MAX_SAFE_INTEGER):
   nada aqui converte id em número.
   ============================================================ */

export interface SelState {
  ids: ReadonlySet<string>;
  /** Âncora do Shift+clique: a última faixa marcada ou desmarcada. */
  anchor: string | null;
}

export const EMPTY_SEL: SelState = { ids: new Set(), anchor: null };

/** Ctrl+clique: alterna a faixa e a torna âncora. */
export function toggleId(s: SelState, id: string): SelState {
  const ids = new Set(s.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ids, anchor: id };
}

/** Shift+clique: soma à seleção o intervalo âncora..id (na ordem da lista).
    Sem âncora válida na lista, vale como marcar só a faixa clicada. */
export function selectRange(s: SelState, ordered: readonly string[], id: string): SelState {
  const to = ordered.indexOf(id);
  const from = s.anchor === null ? -1 : ordered.indexOf(s.anchor);
  if (to < 0) return s;
  if (from < 0) return { ids: new Set([...s.ids, id]), anchor: id };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { ids: new Set([...s.ids, ...ordered.slice(lo, hi + 1)]), anchor: s.anchor };
}

export function selectAll(ordered: readonly string[]): SelState {
  return { ids: new Set(ordered), anchor: ordered[0] ?? null };
}

/** Mantém só o que ainda existe na lista (recarga depois de mover). */
export function pruneTo(s: SelState, ordered: readonly string[]): SelState {
  if (s.ids.size === 0) return s;
  const present = new Set(ordered);
  const ids = new Set([...s.ids].filter((id) => present.has(id)));
  if (ids.size === s.ids.size) return s;
  return { ids, anchor: s.anchor !== null && ids.has(s.anchor) ? s.anchor : null };
}

/** Tira da seleção só os ids dados (movidos, já no destino); o resto fica. */
export function withoutIds(s: SelState, drop: Iterable<string>): SelState {
  const gone = new Set(drop);
  const ids = new Set([...s.ids].filter((id) => !gone.has(id)));
  if (ids.size === s.ids.size) return s;
  return { ids, anchor: s.anchor !== null && ids.has(s.anchor) ? s.anchor : null };
}

/** Itens selecionados, na ordem da lista (não na ordem dos cliques). */
export function pickSelected<T extends { id: string }>(s: SelState, list: readonly T[]): T[] {
  return list.filter((t) => s.ids.has(t.id));
}

export function selLabel(n: number): string {
  return `${n} ${n === 1 ? "selecionada" : "selecionadas"}`;
}

export function moveLabel(n: number): string {
  return n === 1 ? "Mover para playlist…" : `Mover ${n} faixas para playlist…`;
}
