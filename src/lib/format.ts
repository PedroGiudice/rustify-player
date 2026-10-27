// src/lib/format.ts — Utilitários de formatação compartilhados entre views.

/** Duração em ms para "M:SS" ("H:MM:SS" a partir de 1 h). Trunca os
    segundos (Math.floor), como o relógio da barra: a mesma faixa mostra o
    mesmo número na lista, no card e na barra. */
export function fmtDur(ms: number): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Quando foi, a partir de unix timestamp em SEGUNDOS, na hora local:
    "agora", "há 12 min", "hoje 14:32", "ontem 22:10", "sex 09:05" (até 6
    dias), "12 out" (mesmo ano), "12 out 2025". `now` em ms, para teste. */
export function relTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return "—";
  const diff = now / 1000 - ts;
  if (diff < 60) return "agora";
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  const then = new Date(ts * 1000);
  const today = new Date(now);
  const days = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return `hoje ${hhmm(then)}`;
  if (days === 1) return `ontem ${hhmm(then)}`;
  if (days <= 6) return `${WEEKDAYS[then.getDay()]} ${hhmm(then)}`;
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === today.getFullYear() ? date : `${date} ${then.getFullYear()}`;
}
