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

// ── Tipos ──────────────────────────────────────────────────────

export interface TechInfo {
  format: string;
  bitDepth: number | null;
  sampleRate: number | null;
  channels: number | null;
}

export interface PlayerStore {
  // Faixa atual
  currentTrack: Track | null;
  currentTrackInfo: TrackInfo | null;
  // Queue
  queue: Track[];
  queueIndex: number;
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
  isPlaying: false,
  isLiked: false,
  isTransitioning: false,
  positionSecs: 0,
  durationSecs: 0,
  isScrubbing: false,
  volume: 0.78,
  isMuted: false,
  shuffle: false,
  repeatMode: "off",
  techInfo: { format: "—", bitDepth: null, sampleRate: null, channels: null },
});

// ── Mutações (API pública do store) ───────────────────────────
// Sempre exportar funções — nunca expor setPlayer diretamente.

export function setQueue(tracks: Track[], startIndex: number) {
  setPlayer({
    queue: tracks,
    queueIndex: startIndex,
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
  const track = player.queue[next];
  setPlayer({ queueIndex: next, currentTrack: track });
  return track;
}

export function retreatQueue(): Track | null {
  const prev = player.queueIndex - 1;
  if (prev < 0) return null;
  const track = player.queue[prev];
  setPlayer({ queueIndex: prev, currentTrack: track });
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

export function setScrubbing(scrubbing: boolean) {
  setPlayer("isScrubbing", scrubbing);
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
