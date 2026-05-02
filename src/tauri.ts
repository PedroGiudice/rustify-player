/* ============================================================
   tauri.ts — Wrappers tipados para invoke/listen do Tauri.
   Centraliza todos os comandos IPC num único lugar.
   Os nomes dos comandos são EXATAMENTE os do backend Rust.
   ============================================================ */

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ── Tipos (espelham o que o backend Rust serializa via serde) ──

export interface Track {
  id: number;
  title: string;
  artist_name: string;
  artist_id: number | null;
  album_title: string;
  album_id: number | null;
  album_cover_path: string | null;
  duration_ms: number;
  path: string;
  lrc_path: string | null;
  track_number?: number | null;
  genre_name?: string | null;
  last_played?: number | null;
}

export interface Album {
  id: number;
  title: string;
  artist_name: string;
  album_artist_name?: string | null;
  artist_id?: number | null;
  cover_path: string | null;
  year: number | null;
  track_count: number;
}

export interface Artist {
  id: number;
  name: string;
  track_count: number;
  album_count: number;
}

export interface Playlist {
  id: number;
  name: string;
  track_count: number;
}

export interface LyricLine {
  t: number;
  line: string;
  header?: boolean;
}

export interface TrackInfo {
  path: string;
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  duration: { secs: number; nanos: number } | null;
}

export interface AppState {
  current_track: TrackInfo | null;
  current_library_track: Track | null;
  is_playing: boolean;
}

export interface PositionPayload {
  samples_played: number;
  sample_rate: number;
}

export type PlayerStatePayload =
  | { TrackStarted: TrackInfo }
  | { TrackEnded: null }
  | { Position: PositionPayload }
  | { StateChanged: "Playing" | "Paused" | "Idle" | "Stopped" };

// ── Player commands ────────────────────────────────────────────

export const playerPlay = (path: string, origin: string, trackId: number | null) =>
  invoke<void>("player_play", { path, origin, trackId });

export const playerPause = () => invoke<void>("player_pause");
export const playerResume = () => invoke<void>("player_resume");
export const playerSeek = (seconds: number) => invoke<void>("player_seek", { seconds });
export const playerEnqueueNext = (path: string) => invoke<void>("player_enqueue_next", { path });
export const playerSetOrigin = (origin: string, trackId: number | null) =>
  invoke<void>("player_set_origin", { origin, trackId });
export const cycleRepeat = () => invoke<void>("cycle_repeat");
export const setVolume = (volume: number) => invoke<void>("player_set_volume", { volume });

// ── Library commands ───────────────────────────────────────────

export const getState = () => invoke<AppState>("get_state");
export const libGetAlbum = (id: number) => invoke<Album>("lib_get_album", { id });
export const libGetArtist = (id: number) => invoke<any>("lib_get_artist", { id });
export const libGetAlbums = (limit?: number) => invoke<Album[]>("lib_list_albums", { limit: limit ?? 500 });
export const libGetAlbumsByArtist = (artistId: number, limit?: number) => invoke<Album[]>("lib_list_albums", { artistId, limit: limit ?? 100 });
export const libGetArtists = (limit?: number) => invoke<Artist[]>("lib_list_artists", { limit: limit ?? 500 });
export const libGetTracks = (opts?: { albumId?: number; artistId?: number; genreId?: number; limit?: number }) =>
  invoke<Track[]>("lib_list_tracks", { albumId: opts?.albumId, artistId: opts?.artistId, genreId: opts?.genreId, limit: opts?.limit ?? 5000 });
export const libGetTracksByAlbum = (albumId: number, limit?: number) =>
  invoke<Track[]>("lib_list_tracks", { albumId, limit: limit ?? 200 });
export const libGetTracksByArtist = (artistId: number, limit?: number) =>
  invoke<Track[]>("lib_list_tracks", { artistId, limit: limit ?? 200 });
export const libToggleLike = (trackId: number) => invoke<boolean>("lib_toggle_like", { trackId });
export const libIsLiked = (trackId: number) => invoke<boolean>("lib_is_liked", { trackId });
export const libGetLyrics = (trackId: number) => invoke<LyricLine[]>("lib_get_lyrics", { trackId });
export const libRecordPlay = (trackId: number) => invoke<void>("lib_record_play", { trackId });
export const libAutoplayNext = (trackId: number, excludeIds: number[], limit: number) =>
  invoke<Track[]>("lib_autoplay_next", { trackId, excludeIds, limit });
export const libListHistory = (limit?: number) => invoke<Track[]>("lib_list_history", { limit: limit ?? 50 });
export const libSnapshot = () => invoke<any>("lib_snapshot");
export const libListGenres = () => invoke<any[]>("lib_list_genres");
export const libShuffle = (limit?: number) => invoke<Track[]>("lib_shuffle", { limit: limit ?? 50 });
export const libRecommendations = () => invoke<any>("lib_recommendations");
export const libRescan = () => invoke<void>("lib_rescan");
export const libSearch = (query: string, limit?: number) => invoke<any>("lib_search", { query, limit: limit ?? 8 });
export const libSemanticSearch = (query: string, limit?: number) => invoke<any[]>("lib_semantic_search", { query, limit: limit ?? 5 });
export const getMediaPort = () => invoke<number>("get_media_port");
export const libListFolders = () => invoke<any[]>("lib_list_folders");
export const libListFolderTracks = (folder: string) => invoke<Track[]>("lib_list_folder_tracks", { folder });
export const libListLiked = (limit?: number) => invoke<Track[]>("lib_list_liked", { limit: limit ?? 200 });
export const libListMoods = () => invoke<any[]>("lib_list_moods");
export const libListMoodTracks = (moodId: number) => invoke<Track[]>("lib_list_mood_tracks", { moodId });
export const checkForUpdate = () => invoke<any>("check_for_update");
export const installUpdate = () => invoke<void>("install_update");

// ── DSP commands ───────────────────────────────────────────────

export const dspSetBypass = (bypass: boolean) => invoke<void>("dsp_set_bypass", { bypass });
export const dspSetEqEnabled = (enabled: boolean) => invoke<void>("dsp_set_eq_enabled", { enabled });
export const dspSetEqMode = (mode: number) => invoke<void>("dsp_set_eq_mode", { mode });
export const dspSetEqGain = (input: number, output: number) => invoke<void>("dsp_set_eq_gain", { input, output });
export const dspSetEqBand = (band: number, freq: number, gainDb: number, q: number) =>
  invoke<void>("dsp_set_eq_band", { band, freq, gainDb, q });
export const dspSetEqFilterType = (band: number, filterType: number) =>
  invoke<void>("dsp_set_eq_filter_type", { band, filterType });
export const dspSetEqFilterMode = (band: number, mode: number) =>
  invoke<void>("dsp_set_eq_filter_mode", { band, mode });
export const dspSetEqSlope = (band: number, slope: number) =>
  invoke<void>("dsp_set_eq_slope", { band, slope });
export const dspSetEqSolo = (band: number, solo: boolean) =>
  invoke<void>("dsp_set_eq_solo", { band, solo });
export const dspSetEqMute = (band: number, mute: boolean) =>
  invoke<void>("dsp_set_eq_mute", { band, mute });
export const dspSetLimiterEnabled = (enabled: boolean) =>
  invoke<void>("dsp_set_limiter_enabled", { enabled });
export const dspSetLimiterThreshold = (thresholdDb: number) =>
  invoke<void>("dsp_set_limiter_threshold", { thresholdDb });
export const dspSetBassBypass = (bypass: boolean) => invoke<void>("dsp_set_bass_bypass", { bypass });
export const dspSetBassAmount = (amount: number) => invoke<void>("dsp_set_bass_amount", { amount });

// ── Event listeners ────────────────────────────────────────────

export const onPlayerState = (cb: (payload: PlayerStatePayload) => void) =>
  listen<PlayerStatePayload>("player-state", (e) => cb(e.payload));

export const onMprisCommand = (cb: (cmd: string) => void) =>
  listen<string>("mpris-command", (e) => cb(e.payload));

// ── Helpers ────────────────────────────────────────────────────

export { convertFileSrc };

export function coverUrl(path: string | null): string | null {
  return path ? convertFileSrc(path) : null;
}

export function formatDuration(secs: number): string {
  if (!secs) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function channelLabel(ch: number | null): string {
  switch (ch) {
    case 1: return "Mono";
    case 2: return "Stereo";
    case 6: return "5.1";
    case 8: return "7.1";
    default: return ch ? `${ch}ch` : "—";
  }
}
