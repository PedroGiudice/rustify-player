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

export const playerPlay = (path: string, origin: string, trackId: string | null) =>
  invoke<void>("player_play", { path, origin, trackId });

export const playerPause = () => invoke<void>("player_pause");
export const playerResume = () => invoke<void>("player_resume");
export const playerSeek = (seconds: number) => invoke<void>("player_seek", { seconds });
export const playerEnqueueNext = (path: string) => invoke<void>("player_enqueue_next", { path });
export const playerLoadPaused = (path: string, positionMs: number, trackId: string | null) =>
  invoke<void>("player_load_paused", { path, positionMs, trackId });
export const playerSetOrigin = (origin: string, trackId: string | null) =>
  invoke<void>("player_set_origin", { origin, trackId });

// ── Session persistence ────────────────────────────────────────
// IDs sao string porque os track_ids do Qdrant sao u64 hashes que
// frequentemente passam de Number.MAX_SAFE_INTEGER (2^53). Converter
// pra Number perde precisao silenciosamente (ID acaba em zeros), o
// que quebra o resume porque os IDs corrompidos nao existem no Qdrant.
export interface PersistedState {
  track_id: string | null;
  position_ms: number;
  queue_ids: string[];
  queue_index: number;
  shuffle: boolean;
  repeat_mode: string;
  recently_played: string[];
  saved_at: number;
}
export const persistLoadState = () => invoke<PersistedState | null>("persist_load_state");
export const persistSaveState = (state: PersistedState) =>
  invoke<void>("persist_save_state", { state });
export const libGetTracksByIds = (ids: string[]) =>
  invoke<Track[]>("lib_get_tracks_by_ids", { ids });
export const cycleRepeat = () => invoke<void>("cycle_repeat");
export const setVolume = (volume: number) => invoke<void>("player_set_volume", { volume });

// ── Loudness normalization ─────────────────────────────────────
export const normGetState = () => invoke<boolean>("norm_get_state");
export const normSetEnabled = (enabled: boolean) =>
  invoke<void>("norm_set_enabled", { enabled });
export const normGetTarget = () => invoke<number>("norm_get_target");
export const normSetTarget = (lufs: number) =>
  invoke<void>("norm_set_target", { lufs });

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
export interface FolderPlaylist {
  name: string;          // = folder (renomeado no serde)
  track_count: number;
  cover_path: string | null;
  cover_paths: string[]; // ate 4 distintas (absolute)
}
export const libListFolders = () => invoke<FolderPlaylist[]>("lib_list_folders");
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

export interface FftPayload {
  stream_time_ms: number;
  magnitudes: number[];
  /** Envelope follower 20-200 Hz (attack ~5ms, release ~100ms). 0..1. */
  low_band_mag: number;
  /** Envelope follower 200-2000 Hz (mesma resposta temporal). 0..1. */
  mid_band_mag: number;
  /** Envelope follower 2000-12000 Hz (mesma resposta temporal). 0..1. */
  high_band_mag: number;
  /** RMS slow-averaged (lowpass ~2 Hz) sobre todas as bands. 0..1. */
  rms_energy: number;
  /** Sample rate negociada do PipeWire (Hz). 0 enquanto nao negociado. */
  sample_rate: number;
}

export const onAudioFft = (cb: (payload: FftPayload) => void) =>
  listen<FftPayload>("audio-fft", (e) => cb(e.payload));

export const spectrumSubscribe = () => invoke("spectrum_subscribe");
export const spectrumUnsubscribe = () => invoke("spectrum_unsubscribe");

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

// Snapshot das vars do tema ativo. O accent adaptativo (store/tweaks)
// sobrescreve --primary e família nas inline vars; restaurar o tema
// exige reler os valores originais daqui — removeProperty cairia nos
// defaults do :root, não no tema.
let _themeVars: Record<string, string> | null = null;

/** Valor que o tema ATIVO declarou pra var, ou null (sem tema / não declara). */
export function themeVar(name: string): string | null {
  return _themeVars?.[name] ?? null;
}

/** Esquece o tema ativo (caminho "sem tema" do Settings). */
export function clearThemeVars() {
  _themeVars = null;
}

export function applyTheme(vars: Record<string, string>) {
  const root = document.documentElement;
  _themeVars = { ...vars };
  for (const [prop, val] of Object.entries(vars)) {
    root.style.setProperty(prop, val);
  }
  // Tema aplicado sobrescreve inline vars que Tweaks/adaptive ink também
  // controlam. O listener em store/tweaks.ts re-asserta os overrides do
  // usuário e re-resolve o ink (usuário > capa > tema). CustomEvent evita
  // import circular (tweaks.ts já importa deste módulo).
  window.dispatchEvent(new CustomEvent("rustify:theme-applied", {
    detail: { ink: vars["--bg-ink"] ?? null },
  }));
}

export async function applyThemeByName(filename: string): Promise<ContrastCheck[]> {
  const result = await loadTheme(filename);
  applyTheme(result.vars);
  localStorage.setItem("rustify-theme", filename);
  return result.contrast;
}

export const watchTheme = (filename: string) =>
  invoke("watch_theme", { filename });

export const onThemeChanged = (cb: (filename: string) => void) =>
  listen<string>("theme-changed", (e) => cb(e.payload));

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

// ── Stations ────────────────────────────────────────────────────

export type StationKind = "seed" | "mood";

export interface StationStats {
  played: number;
  last_played_at: number | null; // Unix timestamp em segundos
  match_avg: number | null;
}

export interface Station {
  id: string;
  name: string;
  icon: string;
  tone: string;
  desc: string;
  kind: StationKind;
  seed_track_ids: number[];
  query: string | null;
  stats: StationStats;
}

export interface StationDetail extends Station {
  tracks: Track[];
}

export const libListStations = () =>
  invoke<Station[]>("lib_list_stations");

export const libGetStation = (id: string, limit?: number) =>
  invoke<StationDetail | null>("lib_get_station", { id, limit: limit ?? 40 });

export const libCreateStation = (opts: {
  name: string;
  kind: StationKind;
  seedTrackIds?: number[];
  query?: string;
  icon?: string;
  tone?: string;
  desc?: string;
}) =>
  invoke<Station>("lib_create_station", {
    name: opts.name,
    kind: opts.kind,
    seedTrackIds: opts.seedTrackIds ?? [],
    query: opts.query ?? null,
    icon: opts.icon ?? null,
    tone: opts.tone ?? null,
    desc: opts.desc ?? null,
  });

export const libDeleteStation = (id: string) =>
  invoke<boolean>("lib_delete_station", { id });

export const libPlayStation = (id: string, limit?: number) =>
  invoke<Track[]>("lib_play_station", { id, limit: limit ?? 40 });
