/* ============================================================
   store/player.ts — Estado global do player.
   Substitui as variáveis de módulo em player-bar.js:
   currentTrack, isPlaying, trackQueue, queueIndex, etc.

   Uso:
     import { player, setQueue, updatePosition } from "./player";
     player.isPlaying     // leitura reativa
     setQueue(tracks, 0)  // mutação
   ============================================================ */

import { createStore } from "solid-js/store";
import type { Track, TrackInfo } from "../tauri";
import { setVolume as ipcSetVolume } from "../tauri";
import { resetRadioSession } from "./radioSession";

// ── Tipos ──────────────────────────────────────────────────────

export interface TechInfo {
  format: string;
  bitDepth: number | null;
  sampleRate: number | null;
  channels: number | null;
}

// "curated" — fila vem de um contexto coerente que o usuario montou ou
//             curou (playlist, station). Shuffle dentro desse escopo
//             embaralha a propria queue.
// "open"    — fila vem de uma listagem generica (history, library, search,
//             home suggestions). Shuffle nesse modo entra em radio: troca
//             a queue por [current_track, ...autoplayNext()].
export type QueueScope = "curated" | "open";

/** Proveniência da fila — alimenta o chip de origem da PlayerBar e o
    origin das continuações (contOrigin no PlayerBar). null = música
    solta / fila avulsa (library, busca, história, single). */
export interface QueueSource {
  kind: "station" | "playlist" | "album" | "radio";
  name?: string;
}

export interface PlayerStore {
  // Faixa atual
  currentTrack: Track | null;
  currentTrackInfo: TrackInfo | null;
  // Queue
  queue: Track[];
  queueIndex: number;
  queueScope: QueueScope;
  /** Proveniência da fila. kind="station" faz continuações logarem
      origin="station" (régua + behavioral_signals — Fase 0 do
      session-awareness). null = fila comum (chip "solta"). */
  queueSource: QueueSource | null;
  // Estado de reprodução
  isPlaying: boolean;
  isLiked: boolean;
  isTransitioning: boolean;
  // Posição
  positionSecs: number;
  durationSecs: number;
  isScrubbing: boolean;
  // Volume
  volume: number;   // 0–1
  isMuted: boolean;
  // Controles
  shuffle: boolean;
  repeatMode: "off" | "all" | "one";
  // Metadados técnicos
  techInfo: TechInfo;
}

// ── Store singleton ────────────────────────────────────────────

export const [player, setPlayer] = createStore<PlayerStore>({
  currentTrack: null,
  currentTrackInfo: null,
  queue: [],
  queueIndex: -1,
  queueScope: "open",
  queueSource: null,
  isPlaying: false,
  isLiked: false,
  isTransitioning: false,
  positionSecs: 0,
  durationSecs: 0,
  isScrubbing: false,
  // Default 100%. O valor real do usuario e restaurado por
  // applyPersistedVolume() no boot (localStorage kv-volume) — volume e
  // preferencia de dispositivo, NAO estado de sessao: o state.json expira
  // em 6h e apagaria o volume junto (achado da auditoria: o comentario
  // antigo prometia restauracao via persistLoadState que nunca existiu).
  volume: 1.0,
  isMuted: false,
  shuffle: false,
  repeatMode: "off",
  techInfo: { format: "—", bitDepth: null, sampleRate: null, channels: null },
});

// ── Volume: preferência persistida ────────────────────────────
// Volume vive no localStorage (kv-volume), não no state.json: a sessão
// persistida expira em 6h e levaria o volume junto. O push pro engine
// no boot tem retry porque o engine pode ainda não ter subido.
const VOLUME_KEY = "kv-volume";

function loadPersistedVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  } catch {}
  return 1.0;
}

/** Fonte única de mudança de volume: store + persistência + engine.
    Handlers de UI (PlayerBar, Settings) chamam isto — nunca setVolume
    IPC direto, senão a preferência não persiste. */
export function changeVolume(vol: number): Promise<void> {
  const v = Math.min(1, Math.max(0, vol));
  setPlayer({ volume: v, isMuted: false });
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch {}
  return ipcSetVolume(v);
}

/** Restaura o volume persistido no boot. Chamar uma vez (main.tsx). */
export async function applyPersistedVolume(retries = 5): Promise<void> {
  const v = loadPersistedVolume();
  setPlayer("volume", v);
  try {
    await ipcSetVolume(v);
  } catch {
    if (retries > 0) {
      setTimeout(() => { applyPersistedVolume(retries - 1).catch(() => {}); }, 300);
    }
  }
}

// ── Mutações (API pública do store) ───────────────────────────
// Sempre exportar funções — nunca expor setPlayer diretamente.

// `scope` decide o comportamento do shuffle:
//   "curated" -> embaralha esta queue (mantem o contexto)
//   "open"    -> shuffle entra em radio mode (descarta a queue, usa current_track como seed)
// Default "open" porque a maioria das views serve listagens genericas;
// playlist/station devem passar "curated" explicito.
//
// `source` marca a PROVENIENCIA da fila alem do scope. Dois consumidores:
// (a) o chip de origem da PlayerBar (station/playlist/álbum/rádio/solta);
// (b) kind="station" faz as continuacoes (auto-advance e skip) logarem
// play_events com origin="station" em vez de "album_seq"/"queue" — sem
// isso so a 1a faixa de uma station carrega o origin certo, a regua de
// skip-rate por origin subconta e o behavioral_signals ignora a escuta
// (exclui album_seq dos positives). Default null: qualquer setQueue de
// outra fonte limpa a proveniencia (vira "solta").
// ── Exclusão do autoplay ────────────────────────────────────────────────
// Tracks que acabaram de tocar (terminadas OU interrompidas), FIFO cap 30.
// Vive AQUI porque os setters de fila são o choke point: qualquer troca de
// track passa por eles — call-sites manuais espalhados furavam o contrato
// (clicar numa track da biblioteca no meio de uma sugestão ruim não
// registrava a rejeitada, que voltava como sugestão).
const recentlyPlayedIds = new Set<string>();

/** Registra uma track na exclusão do autoplay. delete-antes-de-add é
    obrigatório: Set.add de membro existente NÃO refresca a posição de
    inserção — sem o delete, uma track recém-replayada continuaria a mais
    antiga do FIFO e seria evictada logo depois de tocar. */
export function rememberRecent(id: string) {
  recentlyPlayedIds.delete(id);
  recentlyPlayedIds.add(id);
  if (recentlyPlayedIds.size > 30) {
    recentlyPlayedIds.delete(recentlyPlayedIds.values().next().value!);
  }
}

/** Snapshot da exclusão — excludeIds do lib_autoplay_next e persistência. */
export function recentlyPlayed(): string[] {
  return [...recentlyPlayedIds];
}

function rememberCurrent() {
  const cur = player.currentTrack;
  if (cur?.id) rememberRecent(cur.id);
}

export function setQueue(
  tracks: Track[],
  startIndex: number,
  scope: QueueScope = "open",
  source: QueueSource | null = null,
) {
  rememberCurrent();
  // Troca de contexto de fila pra algo que NAO e station/radio encerra a
  // rodada de sessao (Fase 2/3 do session-awareness) — sem isto, seenIds/
  // skippedIds de uma station vazariam pra recomendacao de outra, ou
  // sobreviveriam depois do usuario ter saido pra uma playlist/album.
  // kind === "station" preserva a rodada corrente: tanto o handleResume
  // (que ja chamou startRadioSession antes) quanto o topup (que reusa o
  // mesmo source) passam por aqui sem clobber. kind === "radio" idem —
  // cada topup do radio passa por aqui; a troca station<->radio e coberta
  // pelo ensureOpenRadioSession (rodadas nunca se misturam).
  if (source?.kind !== "station" && source?.kind !== "radio") {
    resetRadioSession();
  }
  setPlayer({
    queue: tracks,
    queueIndex: startIndex,
    queueScope: scope,
    queueSource: source,
    currentTrack: tracks[startIndex] ?? null,
  });
}

export function enqueueNext(track: Track) {
  setPlayer("queue", (q) => {
    const next = [...q];
    next.splice(player.queueIndex + 1, 0, track);
    return next;
  });
}

export function enqueueEnd(track: Track) {
  setPlayer("queue", (q) => [...q, track]);
}

export function advanceQueue(): Track | null {
  const next = player.queueIndex + 1;
  if (next >= player.queue.length) return null;
  rememberCurrent();
  const track = player.queue[next];
  setPlayer({ queueIndex: next, currentTrack: track });
  return track;
}

export function retreatQueue(): Track | null {
  const prev = player.queueIndex - 1;
  if (prev < 0) return null;
  rememberCurrent();
  const track = player.queue[prev];
  setPlayer({ queueIndex: prev, currentTrack: track });
  return track;
}

/** Pula direto pra um índice arbitrário da fila — distinto de
    advanceQueue/retreatQueue (sempre ±1). Usado quando o clique vem de
    uma posição qualquer (ex.: item da lista "Up next" na queue), não
    sequencial. Fora de alcance retorna null sem mexer no estado. */
export function jumpToQueueIndex(index: number): Track | null {
  if (index < 0 || index >= player.queue.length) return null;
  rememberCurrent();
  const track = player.queue[index];
  setPlayer({ queueIndex: index, currentTrack: track });
  return track;
}

export function shuffleQueue() {
  const current = player.queue[player.queueIndex];
  const remaining = player.queue.filter((_, i) => i !== player.queueIndex);
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }
  setPlayer({ queue: [current, ...remaining], queueIndex: 0 });
}

// Chamado quando o engine emite TrackStarted
export function applyTrackStarted(info: TrackInfo) {
  setPlayer({
    currentTrackInfo: info,
    isPlaying: true,
    isTransitioning: false,
    positionSecs: 0,
    durationSecs: info.duration?.secs ?? 0,
    techInfo: {
      // FIXME: TrackInfo no backend nao expoe format/codec — assumindo FLAC
      // (90%+ da biblioteca real). Para suportar mp3/ogg/opus, expor
      // codec_short_name do symphonia em TrackInfo.
      format: "FLAC",
      bitDepth: info.bit_depth ?? null,
      sampleRate: info.sample_rate ?? null,
      channels: info.channels ?? null,
    },
  });
}

// Chamado no evento Position (a cada ~100ms do engine)
export function updatePosition(samplesPlayed: number, sampleRate: number) {
  if (player.isScrubbing) return;
  setPlayer("positionSecs", samplesPlayed / sampleRate);
}

export function setPlayingState(playing: boolean) {
  setPlayer("isPlaying", playing);
}

export function setLiked(liked: boolean) {
  setPlayer("isLiked", liked);
}

export function cycleRepeat() {
  const modes: PlayerStore["repeatMode"][] = ["off", "all", "one"];
  const cur = modes.indexOf(player.repeatMode);
  setPlayer("repeatMode", modes[(cur + 1) % modes.length]);
}

// Reconcilia estado com snapshot do backend (visibilitychange)
export function reconcileFromState(backendTrack: Track | null, backendPlaying: boolean) {
  if (!backendTrack) {
    setPlayer({ isPlaying: false });
    return;
  }
  const trackChanged = !player.currentTrack || player.currentTrack.id !== backendTrack.id;
  if (trackChanged) {
    setPlayer({
      currentTrack: backendTrack,
      durationSecs: (backendTrack.duration_ms ?? 0) / 1000,
    });
    const qIdx = player.queue.findIndex((t) => t.id === backendTrack.id);
    if (qIdx >= 0) setPlayer("queueIndex", qIdx);
  }
  setPlayer("isPlaying", backendPlaying);
}
