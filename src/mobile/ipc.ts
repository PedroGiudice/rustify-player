/* ============================================================
   ipc.ts — o contrato do Android v0 num lugar só.
   Fonte: docs/android/ipc-contrato-v0.md e o README de
   src-tauri/crates/tauri-plugin-rustify-audio.

   Regras que este módulo existe para não deixar ninguém quebrar:
   - ids são STRING (u64 hash-based; Number corrompe > 2^53);
   - args do plugin são camelCase;
   - a UI NÃO gerencia fila nem loga escuta: a fila vive no Kotlin
     e o journal do service é a verdade do que foi ouvido.
   ============================================================ */

import { addPluginListener, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  Folder,
  LyricLine,
  Origin,
  PlaybackState,
  QueueItem,
  QueueSnapshot,
  StationMeta,
  StepResult,
  Track,
} from "./types";

const PLUGIN = "rustify-audio";
const cmd = (name: string) => `plugin:${PLUGIN}|${name}`;

// ── Biblioteca (commands do app, src-tauri/src/mobile.rs) ──────

export const libListFolders = () => invoke<Folder[]>("lib_list_folders");
export const libListFolderTracks = (name: string) => invoke<Track[]>("lib_list_folder_tracks", { name });
export const libListTracks = () => invoke<Track[]>("lib_list_tracks");
export const libGetTracksByIds = (ids: string[]) => invoke<Track[]>("lib_get_tracks_by_ids", { ids });
export const libRescan = () => invoke<number>("lib_rescan");

// ── Inteligência local (CMR-190 — artefatos de .rustify/) ─────
// Sem artefatos exportados, tudo devolve lista vazia — a UI esconde.

export const libSimilarTracks = (id: string, k?: number) =>
  invoke<Track[]>("lib_similar_tracks", { id, k });
export const libListStations = () => invoke<StationMeta[]>("lib_list_stations");
export const libPlayStation = (id: string, limit?: number) =>
  invoke<Track[]>("lib_play_station", { id, limit });
export const libStationNext = (stationId: string, excludeIds: string[], limit?: number) =>
  invoke<Track[]>("lib_station_next", { stationId, excludeIds, limit });
export const libTastePositives = () => invoke<Track[]>("lib_taste_positives");
export const libGetLyrics = (trackId: string) => invoke<LyricLine[]>("lib_get_lyrics", { trackId });

// ── Player (plugin rustify-audio) ─────────────────────────────

/** 1x no boot, antes de qualquer outra chamada (pede POST_NOTIFICATIONS). */
export const playerInitialize = () => invoke<void>(cmd("initialize"));

export const playerSetQueue = (args: {
  items: QueueItem[];
  startIndex?: number;
  origin: Origin;
  contextId?: string | null;
  playNow?: boolean;
}) => invoke<void>(cmd("set_queue"), args as unknown as Record<string, unknown>);

export const playerPlay = () => invoke<void>(cmd("play"));
export const playerPause = () => invoke<void>(cmd("pause"));
/** `moved: false` = a fila acabou (ou começou) — o gesto não teve efeito. */
export const playerNext = () => invoke<StepResult>(cmd("next"));
export const playerPrevious = () => invoke<StepResult>(cmd("previous"));
export const playerSeekTo = (positionMs: number) => invoke<void>(cmd("seek_to"), { positionMs });
export const playerSkipToIndex = (index: number) => invoke<void>(cmd("skip_to_index"), { index });
export const playerGetState = () => invoke<PlaybackState>(cmd("get_state"));
/** Fila REAL do serviço. A UI não mantém espelho: esta é a verdade. */
export const playerGetQueue = () => invoke<QueueSnapshot>(cmd("get_queue"));

// ── Eventos (best-effort: perder não perde dado) ───────────────

type Unlisten = () => void;

async function on(event: string, cb: (s: PlaybackState) => void): Promise<Unlisten> {
  const handle = await addPluginListener(PLUGIN, event, cb as (payload: unknown) => void);
  return () => handle.unregister();
}

export const onStateChanged = (cb: (s: PlaybackState) => void) => on("state_changed", cb);
export const onTrackChanged = (cb: (s: PlaybackState) => void) => on("track_changed", cb);
export const onPosition = (cb: (s: PlaybackState) => void) => on("position", cb);

/** Bandas reais do SpectrumTap (CMR-192), ~25Hz enquanto toca. */
export const onFft = (cb: (f: { low: number; mid: number; high: number }) => void) =>
  addPluginListener(PLUGIN, "fft", cb as (payload: unknown) => void).then(
    (h) => () => h.unregister(),
  );

// ── Arquivos locais ───────────────────────────────────────────

/** Capa/arquivo local → URL que o WebView consegue carregar. */
export function assetSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/** Track do acervo → item da fila nativa (uri file:// como manda o contrato). */
export function toQueueItem(t: Track): QueueItem {
  return {
    trackId: t.id,
    uri: "file://" + t.path,
    title: t.title,
    artist: t.artist_name ?? "",
    album: t.album_title ?? "",
    artworkUri: t.album_cover_path ? "file://" + t.album_cover_path : null,
    durationMs: t.duration_ms,
  };
}

export const toQueueItems = (tracks: Track[]): QueueItem[] => tracks.map(toQueueItem);
