/* ============================================================
   store/radioSession.ts — sinal de sessão client-side de UMA
   RODADA de audição de station (Fase 2/3 do session-awareness,
   docs/superpowers/specs/2026-07-12-session-awareness-design.md).

   Efêmero por design: nenhuma persistência, nenhum Mutex/Arc novo
   no backend — o único estado novo no backend é o context_id
   aditivo em play_events (audit trail, ver lib_station_next). A
   rodada morre no reload ou quando a fila troca de contexto pra
   algo que não é station (setQueue chama resetRadioSession — ver
   store/player.ts).

   seenIds alimenta exclude_ids do lib_station_next (hard filter —
   não repete o que já tocou/apareceu nesta rodada). skippedIds
   alimenta session_negative_ids (penaliza candidatos parecidos com
   o que foi rejeitado cedo) — Fase 3.
   ============================================================ */

// Mais frouxo que o hard-skip global (0.15, usado em
// behavioral_signals): ali o objetivo é pureza do sinal de longo
// prazo; aqui é reatividade de curto prazo dentro da rodada.
// "larguei no segundo 3" é rejeição forte; "larguei no segundo 178
// de uma faixa de 180" não é — a faixa quase terminou.
const SESSION_REJECT_RATIO = 0.35;

// A sessão não deve crescer sem limite numa rodada longa — só os
// skips mais recentes importam pro re-rank de curto prazo.
const SKIPPED_CAP = 15;

interface RadioSession {
  stationId: string | null;
  contextId: string | null;
  seenIds: string[];
  skippedIds: string[]; // mais recente primeiro, cap SKIPPED_CAP
  // Última faixa da rodada que TERMINOU (aceitação). É a semente do
  // re-fetch pós-skip no rádio: semear pela rejeitada fazia o picker
  // caminhar PRA DENTRO da vizinhança que o usuário estava rejeitando
  // (forense 18/08: sessões de martelo com 95% de skip).
  lastAcceptedId: string | null;
}

function emptySession(): RadioSession {
  return {
    stationId: null, contextId: null, seenIds: [], skippedIds: [],
    lastAcceptedId: null,
  };
}

let session: RadioSession = emptySession();

/** Inicia uma nova rodada: descarta o estado da rodada anterior e gera um
    contextId novo (usado como context_id do play_event — habilita
    skip-rate por posição-na-rodada). Retorna o contextId gerado pro
    caller repassar a playTrack/playerPlay. */
export function startRadioSession(stationId: string): string {
  const contextId = `station:${stationId}:${Date.now()}`;
  session = {
    stationId, contextId, seenIds: [], skippedIds: [], lastAcceptedId: null,
  };
  return contextId;
}

/** Garante uma rodada de RÁDIO ABERTO (autoplay) ativa. Idempotente
    dentro da mesma rodada; sessão de station corrente (ou nenhuma) vira
    rodada nova — station e rádio nunca compartilham seen/skipped. */
export function ensureOpenRadioSession(): void {
  if (session.stationId === null && session.contextId?.startsWith("radio:")) {
    return;
  }
  session = { ...emptySession(), contextId: `radio:${Date.now()}` };
}

/** Registra aceitação (TrackEnded na rodada de rádio) — vira a semente
    preferida do próximo re-fetch pós-skip. */
export function noteAccepted(id: string | null | undefined): void {
  if (id) session.lastAcceptedId = id;
}

/** Marca IDs como já vistos nesta rodada (exclude_ids do próximo lote).
    Sem dedup agressivo — repetição no array é inofensiva (o backend só
    usa os IDs como filtro), evita custo de indexOf a cada chamada. IDs
    vazios/nulos (track sem id) são descartados. */
export function registerSeen(ids: (string | null | undefined)[]): void {
  session.seenIds.push(...ids.filter((id): id is string => !!id));
}

/** Registra rejeição de sessão se o skip foi CEDO (posição relativa
    estritamente abaixo do threshold). Mais recente primeiro; repetir o
    mesmo trackId move pro topo sem duplicar; cap SKIPPED_CAP. Não exige
    sessão/station ativa — quem decide SE deve chamar (queueSource.kind
    === "station") é o caller. */
export function registerSkipIfEarly(
  trackId: string,
  positionSecs: number,
  durationSecs: number,
): void {
  if (!trackId || durationSecs <= 0) return;
  if (positionSecs / durationSecs >= SESSION_REJECT_RATIO) return;
  session.skippedIds = [
    trackId,
    ...session.skippedIds.filter((id) => id !== trackId),
  ].slice(0, SKIPPED_CAP);
}

/** Encerra a rodada corrente sem iniciar uma nova — chamado quando a fila
    ativa troca de contexto pra algo que não é station. */
export function resetRadioSession(): void {
  session = emptySession();
}

/** Snapshot readonly do estado da rodada corrente. */
export function currentSession(): Readonly<RadioSession> {
  return session;
}
