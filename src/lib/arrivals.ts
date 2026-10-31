/* ============================================================
   lib/arrivals.ts — "Chegou esta semana" da Home (B12, 31/10/2026).

   A fonte é o `indexed_at` do payload (segundos, gravado no ingest): vale
   para toda porta de entrada (Crate, Tidal, Bandcamp, cópia manual), ao
   contrário do contador do Crate, que só vê o que o Crate baixou e zera ao
   fechar. A marca "já visto" é o instante da última visita, persistido em
   localStorage: faixa gravada depois dele é "nova". Conveniência por
   aparelho; sem localStorage tudo da semana aparece como novo.
   ============================================================ */

export const ARRIVALS_WINDOW_S = 7 * 86_400;
const SEEN_KEY = "kv-home-arrivals-seen";

/** Início da janela de chegadas (segundos Unix). */
export function arrivalsCutoff(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) - ARRIVALS_WINDOW_S;
}

/** Gravada depois da última visita (ou nunca houve visita). Sem data, não é nova. */
export function isUnseen(t: { indexed_at?: number | null }, seenAt: number | null): boolean {
  if (t.indexed_at == null) return false;
  return seenAt == null || t.indexed_at > seenAt;
}

export function countUnseen(ts: { indexed_at?: number | null }[], seenAt: number | null): number {
  let n = 0;
  for (const t of ts) if (isUnseen(t, seenAt)) n++;
  return n;
}

export function loadArrivalsSeen(): number | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Grava a visita; nunca volta no tempo (uma lista mais velha não reabre o que já foi visto). */
export function saveArrivalsSeen(at: number): void {
  try {
    const prev = loadArrivalsSeen();
    if (prev != null && prev >= at) return;
    localStorage.setItem(SEEN_KEY, String(Math.floor(at)));
  } catch {
    /* janela privada / armazenamento bloqueado: só perde a marca */
  }
}
