/* ============================================================
   tauri.ts — Wrappers tipados para invoke/listen do Tauri.
   Centraliza todos os comandos IPC num único lugar.
   Os nomes dos comandos são EXATAMENTE os do backend Rust.
   ============================================================ */

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ── Tipos (espelham o que o backend Rust serializa via serde) ──

export interface Track {
  id: string;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  album_cover_path: string | null;
  album_year: number | null;
  duration_ms: number;
  path: string;
  lrc_path: string | null;
  track_number?: number | null;
  genre_name?: string | null;
  last_played?: number | null;
  play_count?: number;
  liked_at?: number | null;
}

export interface Album {
  title: string;
  artist_name: string | null;
  cover_path: string | null;
  year: number | null;
  track_count: number;
}

export interface Artist {
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
export const playerSetOrigin = (origin: string, trackId: string | null) =>
  invoke<void>("player_set_origin", { origin, trackId });
export const cycleRepeat = () => invoke<void>("cycle_repeat");
export const setVolume = (volume: number) => invoke<void>("player_set_volume", { volume });

// ── Library commands ───────────────────────────────────────────

export const getState = () => invoke<AppState>("get_state");
export const libGetAlbums = (opts?: { artist?: string; genre?: string; limit?: number }) =>
  invoke<Album[]>("lib_list_albums", { artist: opts?.artist, genre: opts?.genre, limit: opts?.limit ?? 500 });
export const libGetArtists = (opts?: { genre?: string; limit?: number }) =>
  invoke<Artist[]>("lib_list_artists", { genre: opts?.genre, limit: opts?.limit ?? 500 });
export const libGetTracks = (opts?: { album?: string; artist?: string; genre?: string; limit?: number }) =>
  invoke<Track[]>("lib_list_tracks", { album: opts?.album, artist: opts?.artist, genre: opts?.genre, limit: opts?.limit ?? 5000 });
export const libGetTracksByAlbum = (albumTitle: string, limit?: number) =>
  invoke<Track[]>("lib_list_tracks", { album: albumTitle, limit: limit ?? 200 });
export const libGetAlbumsByArtist = (artistName: string, limit?: number) =>
  invoke<Album[]>("lib_list_albums", { artist: artistName, limit: limit ?? 100 });
export const libGetTracksByArtist = (artistName: string, limit?: number) =>
  invoke<Track[]>("lib_list_tracks", { artist: artistName, limit: limit ?? 200 });
export const libToggleLike = (trackId: string) => invoke<boolean>("lib_toggle_like", { trackId });
export const libIsLiked = (trackId: string) => invoke<boolean>("lib_is_liked", { trackId });
export const libGetLyrics = (trackId: string) => invoke<LyricLine[]>("lib_get_lyrics", { trackId });
export const libRecordPlay = (trackId: string) => invoke<void>("lib_record_play", { trackId });
export const libAutoplayNext = (trackId: string, excludeIds: string[], limit: number) =>
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
export const libMoodSearch = (query: string, limit?: number) => invoke<Track[]>("lib_mood_search", { query, limit: limit ?? 50 });
export const checkForUpdate = () => invoke<any>("check_for_update");
export const installUpdate = () => invoke<void>("install_update");
export const restartApp = () => invoke<void>("restart_app");

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
export const dspSetLimiterMode = (mode: number) => invoke<void>("dsp_set_limiter_mode", { mode });
export const dspSetLimiterKnee = (knee: number) => invoke<void>("dsp_set_limiter_knee", { knee });
export const dspSetLimiterLookahead = (lookahead: number) => invoke<void>("dsp_set_limiter_lookahead", { lookahead });
export const dspSetLimiterAttack = (attack: number) => invoke<void>("dsp_set_limiter_attack", { attack });
export const dspSetLimiterRelease = (release: number) => invoke<void>("dsp_set_limiter_release", { release });
export const dspSetLimiterGain = (input: number, output: number) => invoke<void>("dsp_set_limiter_gain", { input, output });
export const dspSetLimiterBoost = (boost: boolean) => invoke<void>("dsp_set_limiter_boost", { boost });
export const dspSetLimiterScPreamp = (preamp: number) => invoke<void>("dsp_set_limiter_sc_preamp", { preamp });
export const dspSetLimiterStereoLink = (link: number) => invoke<void>("dsp_set_limiter_stereo_link", { link });
export const dspSetLimiterOversampling = (ovs: number) => invoke<void>("dsp_set_limiter_oversampling", { ovs });
export const dspSetLimiterDither = (dither: number) => invoke<void>("dsp_set_limiter_dither", { dither });
export const dspSetLimiterAlr = (alr: boolean) => invoke<void>("dsp_set_limiter_alr", { alr });
export const dspSetLimiterAlrAttack = (attack: number) => invoke<void>("dsp_set_limiter_alr_attack", { attack });
export const dspSetLimiterAlrRelease = (release: number) => invoke<void>("dsp_set_limiter_alr_release", { release });
export const dspSetBassAmount = (amount: number) => invoke<void>("dsp_set_bass_amount", { amount });
export const dspSetBassDrive = (drive: number) => invoke<void>("dsp_set_bass_drive", { drive });
export const dspSetBassBlend = (blend: number) => invoke<void>("dsp_set_bass_blend", { blend });
export const dspSetBassFreq = (freq: number) => invoke<void>("dsp_set_bass_freq", { freq });
export const dspSetBassFloor = (floor: number) => invoke<void>("dsp_set_bass_floor", { floor });
export const dspSetBassFloorActive = (active: boolean) => invoke<void>("dsp_set_bass_floor_active", { active });
export const dspSetBassListen = (listen: boolean) => invoke<void>("dsp_set_bass_listen", { listen });
export const dspSetBassLevels = (input: number, output: number) => invoke<void>("dsp_set_bass_levels", { input, output });

export const listBackgrounds = () => invoke<string[]>("list_backgrounds");
export const getTrackColor = (trackId: string) =>
  invoke<string>("get_track_color", { trackId });

// ── Event listeners ────────────────────────────────────────────

export const onPlayerState = (cb: (payload: PlayerStatePayload) => void) =>
  listen<PlayerStatePayload>("player-state", (e) => cb(e.payload));

export const onMprisCommand = (cb: (cmd: string) => void) =>
  listen<string>("mpris-command", (e) => cb(e.payload));

export const onAudioFft = (cb: (data: number[]) => void) =>
  listen<number[]>("audio-fft", (e) => cb(e.payload));

export const spectrumSubscribe = () => invoke("spectrum_subscribe");
export const spectrumUnsubscribe = () => invoke("spectrum_unsubscribe");

export interface SpectrumRange {
  label: string;
  from_hz: number;
  to_hz: number;
  gain: number;
}

export interface SpectrumConfig {
  ranges: SpectrumRange[];
  sample_rate: number;
  bands: number;
}

export const getSpectrumConfig = () => invoke<SpectrumConfig>("get_spectrum_config");
export const setSpectrumConfig = (ranges: SpectrumRange[]) =>
  invoke("set_spectrum_config", { ranges });

export const listShapes = () => invoke<string[]>("list_shapes");

export interface ThemeInfo {
  filename: string;
  name: string;
  author: string;
}

export const listThemes = () => invoke<ThemeInfo[]>("list_themes");
export interface ContrastCheck {
  pair: string;
  ratio: number;
  pass_aa: boolean;
  pass_aaa: boolean;
}

export interface ThemeLoadResult {
  vars: Record<string, string>;
  contrast: ContrastCheck[];
}

export const loadTheme = (filename: string) => invoke<ThemeLoadResult>("load_theme", { filename });

export function applyTheme(vars: Record<string, string>) {
  const root = document.documentElement;
  for (const [prop, val] of Object.entries(vars)) {
    root.style.setProperty(prop, val);
  }
}

export async function applyThemeByName(filename: string): Promise<ContrastCheck[]> {
  const result = await loadTheme(filename);
  applyTheme(result.vars);
  localStorage.setItem("rustify-theme", filename);
  return result.contrast;
}

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
