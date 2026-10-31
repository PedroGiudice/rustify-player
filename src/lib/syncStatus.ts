/* lib/syncStatus.ts — quando o celular sincronizou (B14).

   O S24 manda plays e curtidas pela tailnet ao receptor do desktop; até
   aqui nada na tela confirmava, e uma falha passava dias despercebida.
   Texto puro e testado: "S24: último sync há 12 min · 34 plays, 2
   curtidas"; passadas 24 h a linha fica âmbar (syncStale). */

import type { DeviceSync } from "../tauri";

const DAY_S = 86_400;

/** "s24" -> "S24". */
export function deviceLabel(id: string): string {
  if (id === "desconhecido") return "Aparelho sem nome";
  return /^s\d+$/i.test(id) ? id.toUpperCase() : id;
}

function since(ts: number, now: number): string {
  const diff = now / 1000 - ts;
  if (diff < 60) return "agora";
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < DAY_S) return `há ${Math.floor(diff / 3600)} h`;
  const days = Math.floor(diff / DAY_S);
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

export function syncLine(d: DeviceSync, now: number = Date.now()): string {
  return `${deviceLabel(d.device_id)}: último sync ${since(d.last_batch_at, now)}`;
}

/** O que veio no último lote aceito. */
export function syncDetail(d: DeviceSync): string {
  const parts: string[] = [];
  if (d.plays > 0 || d.likes > 0) {
    parts.push(`${d.plays === 1 ? "1 escuta" : `${d.plays} escutas`}, ${d.likes === 1 ? "1 curtida" : `${d.likes} curtidas`}`);
  } else if (d.accepted > 0) {
    parts.push(d.accepted === 1 ? "1 evento" : `${d.accepted} eventos`);
  } else {
    parts.push("lote vazio");
  }
  if (d.rejected > 0) parts.push(d.rejected === 1 ? "1 recusado" : `${d.rejected} recusados`);
  return parts.join(" · ");
}

/** Mais de 24 h sem lote: âmbar. */
export function syncStale(d: DeviceSync, now: number = Date.now()): boolean {
  return now / 1000 - d.last_batch_at > DAY_S;
}

/** Evento `sync-received`: troca o registro do aparelho e o põe no topo. */
export function mergeSync(list: readonly DeviceSync[], d: DeviceSync): DeviceSync[] {
  return [d, ...list.filter((x) => x.device_id !== d.device_id)];
}
