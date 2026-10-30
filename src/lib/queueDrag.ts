// src/lib/queueDrag.ts — matemática do arraste na fila (QueueDrawer).
// Puro: o componente mede a altura da linha e o deslocamento do ponteiro.

/** Posição de destino: anda uma linha a cada meia linha arrastada. */
export function dropIndex(from: number, deltaY: number, rowH: number, count: number): number {
  if (rowH <= 0 || count <= 0) return from;
  const to = from + Math.round(deltaY / rowH);
  return to < 0 ? 0 : to > count - 1 ? count - 1 : to;
}

/** Quanto a linha `i` desliza (px) para abrir o espaço do destino. */
export function shiftFor(i: number, from: number, to: number, rowH: number): number {
  if (from < to && i > from && i <= to) return -rowH;
  if (from > to && i >= to && i < from) return rowH;
  return 0;
}
