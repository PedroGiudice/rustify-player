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
  RadioStart,
  RepeatMode,
  StationMeta,
  StepResult,
  Track,
  UpdateCheck,
  UpdaterProgress,
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

/**
 * Primeiro lote do rádio de uma faixa. Ao contrário de `libSimilarTracks`,
 * NUNCA volta vazio com acervo não-vazio: faixa sem vetor (leva nova que ainda
 * não passou pelo MERT) cai pra artista/pasta e, no limite, pro acervo. O
 * `layer` existe para a UI ser honesta sobre o modo degradado.
 */
export const libRadioStart = (id: string, limit?: number) =>
  invoke<RadioStart>("lib_radio_start", { id, limit });
export const libListStations = () => invoke<StationMeta[]>("lib_list_stations");
export const libPlayStation = (id: string, limit?: number) =>
  invoke<Track[]>("lib_play_station", { id, limit });
export const libStationNext = (
  stationId: string,
  excludeIds: string[],
  sessionNegativeIds?: string[],
  limit?: number,
) => invoke<Track[]>("lib_station_next", { stationId, excludeIds, sessionNegativeIds, limit });
export const libTastePositives = () => invoke<Track[]>("lib_taste_positives");
/**
 * Shelf "Recently played" (CMR-215): faixas DISTINTAS que CONTARAM como play
 * (>= 20s ou >= 25% da faixa), mais recente primeiro. O Rust drena o journal
 * antes de ler o anel — chamar depois de uma troca de faixa já vê a que fechou.
 */
export const libRecentPlays = (limit?: number) => invoke<Track[]>("lib_recent_plays", { limit });
export const libGetLyrics = (trackId: string) => invoke<LyricLine[]>("lib_get_lyrics", { trackId });

// ── Continuidade (epic B) — o tender vive no Rust ─────────────
// A UI só ARMA o modo; quem decide a próxima faixa é a thread nativa, porque
// o WebView é suspenso com a tela apagada e não pode ser o dono da decisão.

export const continuityArm = (args: {
  mode: "off" | "radio" | "station";
  stationId?: string | null;
  seedTrackId?: string | null;
}) => invoke<void>("continuity_arm", args as unknown as Record<string, unknown>);

export const continuitySetEnabled = (enabled: boolean) =>
  invoke<void>("continuity_set_enabled", { enabled });

/**
 * Skip feito dentro do app. Existe só por LATÊNCIA: o mesmo skip chegaria pelo
 * journal no próximo ciclo do tender (até 20s), e nesse intervalo a fila velha
 * continuaria na tela. O Rust decide se foi cedo o bastante para contar.
 */
export const continuityNoteSkip = (trackId: string, positionMs: number, durationMs: number) =>
  invoke<void>("continuity_note_skip", { trackId, positionMs, durationMs });

export const continuityStatus = () =>
  invoke<{
    enabled: boolean;
    mode: string;
    contextId: string | null;
    seen: number;
    negatives: number;
    negativeIds: string[];
    journalCursor: number;
    lastTopupAt: number;
    lastError: string | null;
  }>("continuity_status");

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

/** Descarta a cauda não tocada. O Kotlin nunca corta a faixa corrente. */
export const playerTruncateQueue = (fromIndex: number) =>
  invoke<QueueSnapshot>(cmd("truncate_queue"), { fromIndex });

/**
 * "Embaralhar o restante" (CMR-218): o Kotlin permuta SÓ a cauda depois da
 * corrente, de uma vez (`replaceMediaItems`), e devolve o snapshot novo. Sem
 * args — o corte é resolvido contra o índice do próprio player.
 */
export const playerShuffleUpcoming = () => invoke<QueueSnapshot>(cmd("shuffle_upcoming"));

export const playerSetRepeatMode = (mode: RepeatMode) =>
  invoke<void>(cmd("set_repeat_mode"), { mode });

/**
 * Enfileira sem destruir a fila viva. O `mode` é resolvido no Kotlin contra o
 * índice do próprio player — a UI NUNCA calcula posição de fila, porque a fila
 * é nativa e avança sozinha (o índice do JS já pode estar velho na chegada).
 * Devolve o snapshot novo: o store aplica o que voltou, não o que supôs.
 */
export const playerAddItems = (args: {
  items: QueueItem[];
  origin: Origin;
  contextId?: string | null;
  mode: "next" | "end";
}) => invoke<QueueSnapshot>(cmd("add_items"), args as unknown as Record<string, unknown>);

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

// ── Atualização (spec 2026-08-24-android-auto-update) ─────────
// HTTP e instalação vivem no Kotlin (TLS da plataforma). A UI só pede o
// check, dispara o install e escuta o progresso.

export const appVersion = () => invoke<string>("app_version");
export const updaterCheck = (manifestUrl?: string) =>
  invoke<UpdateCheck>(cmd("updater_check"), { manifestUrl: manifestUrl ?? null });
export const updaterInstall = (args: { url: string; sha256: string | null; size: number }) =>
  invoke<{ status: "started" | "needs_permission" | "busy" }>(
    cmd("updater_install"),
    args as unknown as Record<string, unknown>,
  );
export const onUpdaterProgress = (cb: (p: UpdaterProgress) => void) =>
  addPluginListener(PLUGIN, "updater_progress", cb as (payload: unknown) => void).then(
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
