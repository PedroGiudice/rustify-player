// src/lib/format.ts — Utilitários de formatação compartilhados entre views.
// NÃO modificar as views aqui — cada view tem tarefa de migração própria.

/** Formata duração em ms para "MM:SS". */
export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Tempo relativo a partir de unix timestamp em segundos. */
export function relTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
