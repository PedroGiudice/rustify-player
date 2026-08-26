/* ============================================================
   queueModel.ts — derivações puras sobre o snapshot da fila NATIVA.

   A fila real vive no ExoPlayer; `get_queue` devolve o snapshot
   (ids + origem por item + duração) e a biblioteca do aparelho
   resolve cada id em Track. Estas funções são puras de propósito:
   é o que dá para testar sem aparelho.

   Invariante que importa: o índice do snapshot indexa a lista do
   SERVIÇO. Uma faixa que não resolve vira `null` na posição dela —
   nunca some da lista, senão todo índice daqui para frente aponta
   para a faixa errada.
   ============================================================ */

import type { QueueEntry, QueueSnapshot, Track } from "./types";

export interface ResolvedQueue {
  items: (Track | null)[];
  index: number;
}

export function resolveQueue(
  snapshot: QueueSnapshot | null | undefined,
  byId: Map<string, Track>,
): ResolvedQueue {
  const entries = snapshot?.items ?? [];
  const items = entries.map((e) => byId.get(e.trackId) ?? null);
  return { items, index: clampIndex(snapshot?.index ?? -1, items.length) };
}

/** `-1` = nada tocando. Acima do fim, o serviço manda; clampa no último. */
function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index < 0 || length === 0) return -1;
  return Math.min(Math.trunc(index), length - 1);
}

export interface QueueSplit {
  past: (Track | null)[];
  current: Track | null;
  upcoming: (Track | null)[];
}

export function splitQueue(items: (Track | null)[], index: number): QueueSplit {
  if (index < 0) return { past: [], current: null, upcoming: [...items] };
  if (index >= items.length) return { past: [...items], current: null, upcoming: [] };
  return {
    past: items.slice(0, index),
    current: items[index],
    upcoming: items.slice(index + 1),
  };
}

/**
 * Tempo restante da fila: o que sobra da faixa corrente mais a soma
 * das próximas. Usa a duração da ENTRY (que vem do serviço) e não do
 * Track — a entry existe mesmo quando a faixa não resolve.
 */
export function remainingMs(
  entries: QueueEntry[],
  index: number,
  positionMs: number,
): number {
  let total = 0;
  for (let i = Math.max(0, index); i < entries.length; i++) {
    const dur = Math.max(0, entries[i]?.durationMs ?? 0);
    total += i === index ? Math.max(0, dur - Math.max(0, positionMs)) : dur;
  }
  return total;
}

/** "58:12" / "1:02:30" — subtítulo da fila. */
export function fmtRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Há o que embaralhar? Só com faixa corrente e pelo menos 2 a seguir — com 0
 * ou 1 a permutação é identidade e o botão viraria um no-op mudo (CMR-218).
 * Espelha o guard do Kotlin (`count - from >= 2`); aqui serve para desabilitar
 * o botão antes de gastar um IPC.
 */
export function canShuffleUpcoming(entries: QueueEntry[], index: number): boolean {
  return index >= 0 && entries.length - index - 1 >= 2;
}

/** O que o motor precisa saber quando o usuário abandona a faixa corrente. */
export interface SkipReport {
  trackId: string;
  positionMs: number;
  durationMs: number;
}

/**
 * Traduz um pulo em sinal — ou em nada.
 *
 * `target` ausente = "próxima" (sempre avanço). Voltar para uma faixa anterior
 * é REPLAY, não rejeição: reportá-lo empurraria o rádio para longe justamente
 * do que o usuário quis repetir. Sem faixa corrente não há o que reportar.
 *
 * O filtro de "cedo" (fração ouvida) fica no Rust, junto do mesmo limiar que
 * o caminho do journal usa — duas cópias do número divergiriam.
 */
export function skipReport(
  pb: { index: number; trackId: string | null; positionMs: number; durationMs: number },
  target?: number,
): SkipReport | null {
  if (!pb.trackId) return null;
  if (target !== undefined && target <= pb.index) return null;
  return {
    trackId: pb.trackId,
    positionMs: Math.max(0, Math.round(pb.positionMs)),
    durationMs: Math.max(0, Math.round(pb.durationMs)),
  };
}
