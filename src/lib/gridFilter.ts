// src/lib/gridFilter.ts — filtro por texto das grades de Álbuns e
// Artistas (B3, varredura de 31/10). Centenas de cartões sem filtro: o
// dono rolava a grade inteira atrás de um nome.
//
// Sem acento e sem caixa (normWords, a mesma normalização do dedup do
// Crate); cada palavra digitada precisa aparecer, em qualquer campo e em
// qualquer ordem ("queen greatest" acha "Greatest Hits · Queen").

import { normWords } from "./dedup";

export function filterByText<T>(list: readonly T[], query: string, text: (item: T) => string): T[] {
  const words = normWords(query).split(" ").filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((item) => {
    const hay = ` ${normWords(text(item))} `;
    return words.every((w) => hay.includes(w));
  });
}
