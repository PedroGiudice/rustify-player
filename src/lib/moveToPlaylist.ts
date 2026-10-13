/* ============================================================
   lib/moveToPlaylist.ts — Regras puras do "Mover para playlist…"
   (CMR-298). Playlist = pasta de 1º nível em ~/Music; o backend
   (lib_move_tracks) move os arquivos e leva o histórico junto.
   ============================================================ */

import type { MoveReport, Track } from "../tauri";

/** Faixas por chamada ao backend: dá progresso em lote grande sem
    pagar o scroll dos play_events a cada faixa. */
export const MOVE_CHUNK = 10;

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Mesmo filtro do backend: sem pastas ocultas (`.`) e de sistema (`_`). */
export function isValidPlaylistName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !n.startsWith(".") && !n.startsWith("_") && !/[\\/]/.test(n);
}

/** Espelho do `sanitize_component` do backend (slskd-client/stage_plan):
    `/ \ \0` viram espaço, `: " * ? < > |` viram `_`, espaços colapsam,
    teto de 120 bytes UTF-8. Só se aplica a pasta NOVA — existente vai
    como está. */
export function sanitizePlaylistName(name: string): string {
  const replaced = name.replace(/[/\\\0]/g, " ").replace(/[:"*?<>|]/g, "_");
  const collapsed = replaced.split(/\s+/).filter(Boolean).join(" ");
  // Corta por code point (Array.from), nunca no meio de um par surrogate
  // (emoji, CJK estendido): slice por unidade UTF-16 deixaria meio caractere.
  const enc = new TextEncoder();
  const chars = Array.from(collapsed);
  while (enc.encode(chars.join("")).length > 120) chars.pop();
  return chars.join("");
}

export function filterPlaylists(names: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return names;
  return names.filter((n) => n.toLowerCase().includes(q));
}

/** Nome FINAL (já sanitizado) da pasta nova para o que foi digitado, ou
    null: inválido depois da sanitização (vazio, começa com `.`/`_`) ou já
    existe uma playlist com esse nome (sem diferenciar caixa — no Android e
    no olho são iguais). */
export function newFolderCandidate(names: string[], query: string): string | null {
  if (names.includes(query.trim())) return null;
  const q = sanitizePlaylistName(query);
  if (!isValidPlaylistName(q)) return null;
  // Mesma regra do backend (resolve_dest_playlist): nome novo que colide
  // com uma existente só na caixa (ou na forma sanitizada) é recusado — o
  // storage do Android é case-insensitive.
  const lower = q.toLowerCase();
  return names.some((n) => n.toLowerCase() === lower || sanitizePlaylistName(n).toLowerCase() === lower)
    ? null
    : q;
}

export function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/** Linha de confirmação de lote: "Mover 14 faixas de X para Y?". */
export function confirmText(count: number, label: string | null, dest: string): string {
  const what = plural(count, "faixa", "faixas");
  return label ? `Mover ${what} de ${label} para ${dest}?` : `Mover ${what} para ${dest}?`;
}

export function mergeReports(dest: string, reports: MoveReport[]): MoveReport {
  return {
    dest_playlist: reports[0]?.dest_playlist ?? dest,
    moved: reports.reduce((s, r) => s + r.moved, 0),
    already_there: reports.reduce((s, r) => s + r.already_there, 0),
    failed: reports.reduce((s, r) => s + r.failed, 0),
    pending: reports.reduce((s, r) => s + (r.pending ?? 0), 0),
    items: reports.flatMap((r) => r.items),
  };
}

/** Resumo do resultado em uma linha: "13 movidas · 1 falhou". */
export function summaryText(r: MoveReport): string {
  const parts: string[] = [];
  if (r.moved) parts.push(plural(r.moved, "movida", "movidas"));
  if (r.already_there) parts.push(`${r.already_there} já ${r.already_there === 1 ? "estava" : "estavam"} lá`);
  if (r.failed) parts.push(`${r.failed} ${r.failed === 1 ? "falhou" : "falharam"}`);
  if (r.pending) parts.push(`${r.pending} ainda em andamento`);
  return parts.length ? parts.join(" · ") : "Nada a mover";
}

/** Função de remapeamento para a fila em memória: troca id, caminho e
    pasta de 1º nível das faixas movidas; as outras passam intactas. */
export function trackRemapper(report: MoveReport): (t: Track) => Track {
  const moved = new Map(
    report.items
      .filter((i) => i.status === "moved" && i.new_track_id && i.new_path)
      .map((i) => [i.track_id, i] as const),
  );
  return (t) => {
    const it = moved.get(t.id);
    if (!it) return t;
    const path = it.new_path!;
    return {
      ...t,
      id: it.new_track_id!,
      path,
      lrc_path: it.new_lrc_path,
      genre_name: report.dest_playlist,
    };
  };
}
