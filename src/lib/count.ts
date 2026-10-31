// src/lib/count.ts — contagens e durações por extenso das telas da
// biblioteca: "1 faixa", "1.234 faixas", "3 h 05 min".
//
// Milhar com ponto (pt-BR): o toLocaleString() sem idioma seguia o do
// sistema e saía "1,234" (A44, varredura de 31/10).

/** "1 faixa", "12 faixas", "1.234 faixas". */
export function plural(n: number, um: string, varios: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;
}

/** Duração somada de uma lista: "48 min", "3 h 05 min". */
export function totalDur(ms: number): string {
  const totalMin = Math.round((ms || 0) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}
