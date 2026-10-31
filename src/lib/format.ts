// src/lib/format.ts — Utilitários de formatação compartilhados entre views.
//
// Um formato por grandeza (A44, varredura de 31/10): contagem, tamanho,
// tempo estimado, duração de faixa e duração de lista moram aqui, em
// pt-BR fixo (o toLocaleString() sem idioma seguia o sistema: "2,203").

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

const INT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const DEC1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Inteiro com milhar em pt-BR: "2.203". */
export function fmtInt(n: number): string {
  return INT.format(n || 0);
}

/** "1 faixa", "12 faixas", "1.234 faixas". */
export function plural(n: number, um: string, varios: string): string {
  return `${fmtInt(n)} ${n === 1 ? um : varios}`;
}

/** Tamanho em MB decimal (o mesmo número em todo o app): exato "7,1 MB" /
    "1,1 GB"; estimativa (`approx`) com til e MB inteiro: "~360 MB". */
export function fmtSize(bytes: number, approx = false): string {
  if (!(bytes > 0)) return "0 MB";
  const mb = bytes / 1_000_000;
  const tilde = approx ? "~" : "";
  if (mb >= 1000) return `${tilde}${DEC1.format(mb / 1000)} GB`;
  return approx ? `~${Math.max(1, Math.round(mb))} MB` : `${DEC1.format(mb)} MB`;
}

/** Tempo estimado a partir de SEGUNDOS: "<1 min", "~6 min", "~1 h 20 min". */
export function fmtEta(seconds: number): string {
  if (!(seconds > 0)) return "0 min";
  if (seconds < 60) return "<1 min";
  const min = Math.round(seconds / 60);
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `~${h} h ${m} min` : `~${h} h`;
}

/** Duração somada de uma lista, a partir de ms: "48 min", "3 h 05 min",
    "2 h". Faixa avulsa usa fmtDur ("3:02"). */
export function fmtListDur(ms: number): string {
  const totalMin = Math.round((ms || 0) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, "0")} min` : `${h} h`;
}
