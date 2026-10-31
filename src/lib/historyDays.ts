// src/lib/historyDays.ts — o Histórico agrupado por dia (B13, varredura
// de 31/10). A lista era uma coluna só, lida linha a linha para saber o
// que tocou em que dia, e não dizia quantas vezes a faixa já tinha tocado.
//
// O histórico vem do backend uma linha por FAIXA, ordenado pela última
// vez que tocou (`last_played`, unix em segundos); o dia do grupo é o
// dessa última vez, na hora local. A coluna da linha leva a hora e, se
// passou de uma, o total de vezes (`play_count`).

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

interface Played {
  last_played?: number | null;
  play_count?: number;
}

const WEEKDAYS = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabel(then: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return "Hoje";
  if (days === 1) return "Ontem";
  if (days <= 6) return WEEKDAYS[then.getDay()];
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === now.getFullYear() ? date : `${date} ${then.getFullYear()}`;
}

/** Grupos por dia, na ordem da lista (que já vem da mais recente). */
export function groupByDay<T extends Played>(list: readonly T[], now: number = Date.now()): DayGroup<T>[] {
  const today = new Date(now);
  const groups: DayGroup<T>[] = [];
  const undated: T[] = [];
  for (const item of list) {
    if (!item.last_played) { undated.push(item); continue; }
    const then = new Date(item.last_played * 1000);
    const key = `${then.getFullYear()}-${then.getMonth()}-${then.getDate()}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(then, today), items: [item] });
  }
  if (undated.length) groups.push({ key: "sem-data", label: "Sem data", items: undated });
  return groups;
}

/** Coluna da linha: "14:32", ou "14:32 · 7 vezes" quando tocou mais de uma vez. */
export function playedWhen(item: Played): string {
  if (!item.last_played) return "—";
  const d = new Date(item.last_played * 1000);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = item.play_count ?? 0;
  return n > 1 ? `${hhmm} · ${n.toLocaleString("pt-BR")} vezes` : hhmm;
}
