/* ============================================================
   tauri.ts — Wrappers tipados para invoke/listen do Tauri.
   Centraliza todos os comandos IPC num único lugar.
   Os nomes dos comandos são EXATAMENTE os do backend Rust.
   ============================================================ */

import { cssColorToRgb, relLuminance } from "./lib/color";

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
  /** Qualidade medida no conteúdo (corte espectral do indexador). Ausente =
      ainda não medida. Ver `lib/quality.ts`. */
  quality_class?: QualityClass | null;
  quality_cutoff_hz?: number | null;
}

/** `library_indexer::spectral::QualityClass`. */
export type QualityClass = "sem_corte" | "provavel_lossy" | "lossy" | "hires_de_cd";

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

// contextId (4º parâmetro): identifica a RODADA de audição corrente (ex.:
// sessão de station) — aditivo, Fase 2 do session-awareness. Opcional,
// default null preserva o comportamento de todo call-site pré-existente.
export const playerPlay = (
  path: string,
  origin: string,
  trackId: string | null,
  contextId: string | null = null,
) => invoke<void>("player_play", { path, origin, trackId, contextId });

export const playerPause = () => invoke<void>("player_pause");
export const playerResume = () => invoke<void>("player_resume");
export const playerSeek = (seconds: number) => invoke<void>("player_seek", { seconds });
export const playerEnqueueNext = (path: string) => invoke<void>("player_enqueue_next", { path });
export const playerLoadPaused = (path: string, positionMs: number, trackId: string | null) =>
  invoke<void>("player_load_paused", { path, positionMs, trackId });
export const playerSetOrigin = (
  origin: string,
  trackId: string | null,
  contextId: string | null = null,
) => invoke<void>("player_set_origin", { origin, trackId, contextId });

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
  // Proveniência da fila (chip + contOrigin) — opcionais pra snapshots
  // legados; ausência = fila "solta".
  queue_scope?: string | null;
  queue_source_kind?: string | null;
  queue_source_name?: string | null;
}
export const persistLoadState = () => invoke<PersistedState | null>("persist_load_state");
export const persistSaveState = (state: PersistedState) =>
  invoke<void>("persist_save_state", { state });
export const libGetTracksByIds = (ids: string[]) =>
  invoke<Track[]>("lib_get_tracks_by_ids", { ids });
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
// Listagens de álbuns/artistas: o backend ordena por nome e só trunca
// quando recebe um número. `limit: null` = acervo inteiro; omitido =
// default. Quem navega o acervo (grades, detalhe) passa null — corte
// alfabético silencioso escondia parte da biblioteca.
export const libGetAlbums = (opts?: { artist?: string; genre?: string; limit?: number | null }) =>
  invoke<Album[]>("lib_list_albums", { artist: opts?.artist, genre: opts?.genre, limit: opts?.limit === undefined ? 500 : opts.limit });
export const libGetArtists = (opts?: { genre?: string; limit?: number | null }) =>
  invoke<Artist[]>("lib_list_artists", { genre: opts?.genre, limit: opts?.limit === undefined ? 500 : opts.limit });
export const libGetTracks = (opts?: { album?: string; artist?: string; genre?: string; limit?: number }) =>
  invoke<Track[]>("lib_list_tracks", { album: opts?.album, artist: opts?.artist, genre: opts?.genre, limit: opts?.limit ?? 5000 });
export const libGetTracksByAlbum = (albumTitle: string, limit?: number) =>
  invoke<Track[]>("lib_list_tracks", { album: albumTitle, limit: limit ?? 200 });
export const libGetAlbumsByArtist = (artistName: string, limit?: number | null) =>
  invoke<Album[]>("lib_list_albums", { artist: artistName, limit: limit === undefined ? 100 : limit });
export const libGetTracksByArtist = (artistName: string, limit?: number) =>
  invoke<Track[]>("lib_list_tracks", { artist: artistName, limit: limit ?? 200 });
export const libToggleLike = (trackId: string) => invoke<boolean>("lib_toggle_like", { trackId });
export const libIsLiked = (trackId: string) => invoke<boolean>("lib_is_liked", { trackId });
export const libGetLyrics = (trackId: string) => invoke<LyricLine[]>("lib_get_lyrics", { trackId });
export const libRecordPlay = (trackId: string) => invoke<void>("lib_record_play", { trackId });
/** sessionNegativeIds = skips cedos da rodada de rádio (radioSession) —
    penalizam candidatos parecidos com o rejeitado, paridade com
    libStationNext. mixSlot = posição da próxima faixa no ciclo
    conhecida, conhecida, descoberta da rodada (radioSession.mixSlot). */
export const libAutoplayNext = (
  trackId: string,
  excludeIds: string[],
  sessionNegativeIds: string[],
  limit: number,
  mixSlot?: number,
) =>
  invoke<Track[]>("lib_autoplay_next", { trackId, excludeIds, sessionNegativeIds, limit, mixSlot });
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

// ── Mover para playlist (CMR-298) ──────────────────────────────
// Playlist = pasta de 1º nível em ~/Music. O backend move os arquivos e
// leva vetores, like/vibe e play_events para o id novo (hash do caminho).
/** "pending" = o indexador não respondeu a tempo; o pedido segue na fila e
    o resultado chega pelo evento lib-tracks-moved. */
export type MoveStatus = "moved" | "already_there" | "failed" | "pending";
export interface MoveItem {
  track_id: string;
  new_track_id: string | null;
  new_path: string | null;
  /** Sidecar .lrc que acompanhou a faixa (null = sem letra sincronizada). */
  new_lrc_path: string | null;
  title: string | null;
  status: MoveStatus;
  /** Motivo da falha, ou avisos de migração parcial num item movido. */
  detail: string | null;
}
export interface MoveReport {
  dest_playlist: string;
  moved: number;
  already_there: number;
  failed: number;
  pending: number;
  items: MoveItem[];
}
/** Pastas de 1º nível no disco (inclui vazias; sem `.` e `_`). */
export const libListPlaylists = () => invoke<string[]>("lib_list_playlists");
export const libMoveTracks = (trackIds: string[], destPlaylist: string) =>
  invoke<MoveReport>("lib_move_tracks", { trackIds, destPlaylist });
export const onTracksMoved = (cb: (r: MoveReport) => void) =>
  listen<MoveReport>("lib-tracks-moved", (e) => cb(e.payload));
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

/** Paleta dominante da capa (até 3 cores, ordenadas por densidade;
    item 0 == dominant_color). Cache lazy dominant_palette_v4. */
export const getTrackPalette = (trackId: string) =>
  invoke<string[]>("get_track_palette", { trackId });

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

/** Tira do <html> as vars que o tema ativo escreveu e o esquece (caminho
    "Default" do Settings). Só as DELE: zoom, vars dos Tweaks e do adaptive
    ink continuam — o listener de rustify:theme-applied re-asserta o resto. */
export function clearThemeVars() {
  const root = document.documentElement;
  for (const prop of Object.keys(_themeVars ?? {})) root.style.removeProperty(prop);
  _themeVars = null;
  root.style.removeProperty("color-scheme");
}

/** Esquema de cor nativo pela luminância do paper: 'dark' quando o paper
    contrasta mais com branco do que com preto (luminância < 0,179). É o
    que faz o WebKitGTK pintar escuros a lista aberta do <select>, as
    barras de rolagem e o caret num tema escuro. null = cor ilegível. */
export function colorSchemeFor(paper: string | undefined | null): "dark" | "light" | null {
  const rgb = paper ? cssColorToRgb(paper) : null;
  if (!rgb) return null;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  const y = relLuminance(`#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`);
  if (y == null) return null;
  return y < 0.179 ? "dark" : "light";
}

export function applyTheme(vars: Record<string, string>) {
  const root = document.documentElement;
  // Vars que o tema anterior declarou e este não: removidas, senão o valor
  // de A continuava valendo sob B (mistura de temas). Overrides do usuário
  // sobre elas voltam pelo listener de rustify:theme-applied.
  for (const prop of Object.keys(_themeVars ?? {})) {
    if (!(prop in vars)) root.style.removeProperty(prop);
  }
  _themeVars = { ...vars };
  for (const [prop, val] of Object.entries(vars)) {
    root.style.setProperty(prop, val);
  }
  // Sem --bg-paper declarado, o paper é o do :root (claro): cai no CSS.
  const scheme = colorSchemeFor(vars["--bg-paper"]);
  if (scheme) root.style.setProperty("color-scheme", scheme);
  else root.style.removeProperty("color-scheme");
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

/** Derruba o watcher do tema ativo no backend (volta ao Default). */
export const unwatchTheme = () => invoke<void>("unwatch_theme");

export const onThemeChanged = (cb: (filename: string) => void) =>
  listen<string>("theme-changed", (e) => cb(e.payload));

/** Hot-reload do tema: quando o watcher avisa que o YAML mudou, re-aplica —
    mas só se o arquivo ainda é o tema ATIVO. Um evento atrasado do tema
    anterior (ou chegado depois de voltar ao Default) não pode ressuscitá-lo
    nem regravar a escolha do usuário. Registrar UMA vez, no boot, com ou
    sem tema salvo: quem parte do Default e escolhe um YAML no Settings
    também ganha o recarregamento a quente. */
export function wireThemeHotReload() {
  return onThemeChanged(async (fname) => {
    if (localStorage.getItem("rustify-theme") !== fname) return;
    try {
      await applyThemeByName(fname);
      console.log("[theme] hot-reloaded:", fname);
    } catch (e) {
      console.warn("[theme] hot-reload failed:", e);
    }
  });
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
  // Track IDs sao u64 > 2^53: viajam como STRING no wire (serde custom no
  // backend), igual Track.id — number aqui corromperia silenciosamente.
  seed_track_ids: string[];
  query: string | null;
  stats: StationStats;
}

export interface StationDetail extends Station {
  tracks: Track[];
}

export interface MoodVocabulary {
  moods: string[];
  activities: string[];
  genres: string[];
}

export const libMoodVocabulary = () =>
  invoke<MoodVocabulary>("lib_mood_vocabulary");

export const libListStations = () =>
  invoke<Station[]>("lib_list_stations");

export const libGetStation = (id: string, limit?: number) =>
  invoke<StationDetail | null>("lib_get_station", { id, limit: limit ?? 40 });

export const libCreateStation = (opts: {
  name: string;
  kind: StationKind;
  seedTrackIds?: string[];
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

/** Lote incremental de uma station EM ANDAMENTO (Fase 2 do
    session-awareness) — usado pelo topup (topUpStation em PlayerBar.tsx),
    disparado perto do fim da fila ou imediatamente após um skip cedo
    (Fase 3). excludeIds = seenIds da rodada (hard filter); sessionNegativeIds
    = skippedIds da rodada (penaliza candidatos parecidos com o que foi
    rejeitado). Default de limit (6) espelha o topup do autoplay/radio. */
export const libStationNext = (
  stationId: string,
  excludeIds: string[],
  sessionNegativeIds: string[],
  limit?: number,
) =>
  invoke<Track[]>("lib_station_next", {
    stationId,
    excludeIds,
    sessionNegativeIds,
    limit: limit ?? 6,
  });

// ── Crate (busca + download Soulseek in-app) ────────────────────
// Tipos espelham EXATAMENTE o que o Rust serializa
// (src-tauri/src/slsk/{mod,board,coordinator}.rs) — não o esboço da spec.

/** Três estados distinguíveis (spec §3.3) — nunca colapsar. */
export interface SlskStatus {
  reachable: boolean;
  logged_in: boolean;
  network_connected: boolean;
  message: string;
}

export type SearchState = "running" | "done" | "empty" | "failed" | "canceled";

export interface OwnedVerdict {
  track_id: string;
  title: string;
  artist: string;
}

/** Candidato de download — um peer/arquivo dentro de um ResultGroup. */
export interface Candidate {
  id: string;
  username: string;
  filename: string;
  directory: string;
  size: number;
  bit_depth: number | null;
  sample_rate: number | null;
  bit_rate: number | null;
  length_secs: number | null;
  free_slot: boolean;
  upload_speed: number;
  queue_length: number;
  score: number;
  warn: string | null;
}

/** Faixa agregada (N peers colapsados por artista+título+duração). */
export interface ResultGroup {
  group_key: string;
  display_title: string;
  display_artist: string | null;
  album_hint: string | null;
  duration_secs: number | null;
  quality_label: string;
  owned: OwnedVerdict | null;
  suggested_dest: string | null;
  best: Candidate;
  alternates: Candidate[];
}

export interface SearchSnapshot {
  state: SearchState;
  elapsed_ms: number;
  responses_seen: number;
  groups: ResultGroup[];
  note: string | null;
}

/** RejectReason — serde externally-tagged (sem `tag=`, board.rs):
    variantes unitárias viram string snake_case; `AlreadyOwned` vira
    `{ already_owned: { track_id } }`. */
export type RejectReason =
  | { already_owned: { track_id: string } }
  | "bit32_unsupported"
  | "not_flac"
  | "corrupt"
  | { lossy_format: { format: string } }
  | { lossy_inside: { cutoff_hz: number } }
  | { below_cd: { sample_rate: number; bit_depth: number } }
  | "no_download";

/** JobState — 12 estados, `#[serde(tag = "kind")]` (board.rs): internamente
    tagged, `kind` sempre presente. Terminais: ready/rejected/manual/failed/
    canceled (podem voltar a `queued` via [Trocar fonte] — CR-3 no backend). */
export type JobState =
  | { kind: "queued" }
  | { kind: "enqueued"; queue_position: number | null }
  | { kind: "downloading"; pct: number; bps: number; eta_s: number | null }
  | { kind: "stalled"; since_secs: number }
  | { kind: "processing" }
  | { kind: "indexing" }
  | { kind: "ready"; track_id: string }
  | { kind: "rejected"; reason: RejectReason }
  | { kind: "manual"; path: string; why: string }
  | { kind: "failed"; reason: string; retryable: boolean }
  | { kind: "canceled" }
  | { kind: "waiting"; reason: "purchase" | "email_link"; url: string; since_secs: number };

/** Origem do job — `#[serde(tag = "kind")]` (board.rs `Source`). */
export type Source =
  | { kind: "soulseek"; username: string; remote_filename: string; size: number }
  | { kind: "sound_cloud"; track_id: number; permalink_url: string }
  | { kind: "bandcamp"; item_type: string; item_id: number; url: string };

/** O que o CEO confirmou no card; vazio nos jobs Soulseek. */
export interface ConfirmedMeta {
  artist: string;
  title: string;
  album: string;
  year: number | null;
  label: string | null;
}

export type FormatIn = "flac" | "wav24" | "wav16" | "aiff";

export interface DownloadJob {
  job_id: string;
  source: Source;
  meta: ConfirmedMeta;
  /** Capa na fonte (SoundCloud, vinda do card); null no Soulseek. */
  artwork_url: string | null;
  /** Formato de origem detectado; null até a sondagem (e sempre no Soulseek). */
  format_in: FormatIn | null;
  tracks: number;
  display: string;
  dest_playlist: string;
  state: JobState;
  /** "FLAC 16/44" da fonte atual; "" em job reconciliado de um
      slsk_jobs.json anterior ao campo (frontend cai no tamanho). */
  quality_label: string;
  alternates: Candidate[];
  tried_source_ids: string[];
  created_at: number;
  attempt: number;
}

/** Disponibilidade do original no SoundCloud (`soundcloud-client`). */
export type Availability =
  | { kind: "native" }
  | { kind: "quota_exhausted" }
  | { kind: "external_gate"; url: string }
  | { kind: "none" };

/** Faixa do SoundCloud na busca do Crate (slsk/mod.rs `ScResult`). */
export interface ScResult {
  id: number;
  title: string;
  permalink_url: string;
  user_name: string;
  user_permalink: string;
  duration_ms: number;
  playback_count: number;
  created_at: string;
  release_date: string | null;
  genre: string | null;
  artwork_url: string | null;
  availability: Availability;
  suggested_dest: string | null;
}

/** Sondagem do original para o card; o ffprobe decide depois de baixar. */
export interface ScProbe {
  ext: string;
  size: number | null;
  kbps_est: number | null;
  format_label: string;
  allowed: boolean;
  reason: string | null;
}

export interface SourcesStatus {
  soundcloud: "token_ok" | "no_token" | "api_down";
  ffmpeg: boolean;
  uv: boolean;
  bandcamp_identity: boolean;
  tidal: "token_ok" | "no_token" | "api_down";
}

/** Job da fila de downloads da Tidal (slsk/tidal_fila.rs `TidalJob`). */
export interface TidalJob {
  id: string;
  url: string;
  playlist: string;
  status: "fila" | "baixando" | "ok" | "parcial" | "falhou" | "recusada";
  added: string;
  resumo: string;
  inicio: string | null;
  fim: string | null;
  /** Job de seleção (prévia da busca): título do lote e quantas faixas. */
  titulo?: string | null;
  origem?: string | null;
  n_faixas?: number | null;
}

/** Busca da Tidal (slsk/tidal_fila.rs; os nomes vêm da fila da VM). */
export interface TidalTrack {
  id: number;
  titulo: string;
  artistas: string[];
  album: string;
  album_id: number | null;
  ano: number | null;
  duracao_s: number;
  hires: boolean;
  capa: string | null;
  url: string;
}

export interface TidalAlbum {
  id: number;
  titulo: string;
  artista: string;
  ano: number | null;
  n_faixas: number;
  duracao_s: number;
  hires: boolean;
  tipo: "album" | "ep" | "single" | string;
  capa: string | null;
  url: string;
}

export interface TidalArtist {
  id: number;
  nome: string;
  foto: string | null;
  url: string;
}

export interface TidalPlaylist {
  id: string;
  titulo: string;
  n_faixas: number;
  duracao_s: number;
  autor: string | null;
  capa: string | null;
  url: string;
}

export interface TidalSearch {
  q: string;
  top: { tipo: "faixa" | "album" | "artista" | "playlist"; id: string } | null;
  faixas: TidalTrack[];
  albuns: TidalAlbum[];
  artistas: TidalArtist[];
  playlists: TidalPlaylist[];
}

export interface TidalArtistPage extends TidalArtist {
  populares: TidalTrack[];
  albuns: TidalAlbum[];
  eps_singles: TidalAlbum[];
  radio: { mix_id: string; n_faixas: number } | null;
}

export interface TidalPreview {
  tipo: "mix" | "radio" | "playlist" | "album" | "faixa";
  titulo: string;
  /** Forma canônica `tipo:id`; vai como origem do pedido de seleção. */
  ref: string;
  faixas: TidalTrack[];
  duracao_s: number;
}

export interface TidalFilaSnapshot {
  jobs: TidalJob[];
  pastas: string[];
}

export const slskStatus = () => invoke<SlskStatus>("slsk_status");

/** Fire-and-forget: `Ok(search_id)` ou `Err("cooldown:N"|"cold:N"|"busy"|"offline")`
    — usar parseSlskSearchError() no catch pra decidir o banner. */
export const slskSearch = (query: string, force = false) =>
  invoke<string>("slsk_search", { query, force });

export const slskResults = (searchId: string) =>
  invoke<SearchSnapshot>("slsk_results", { searchId });

export const slskCancelSearch = (searchId: string) =>
  invoke<void>("slsk_cancel_search", { searchId });

/** Camada 1 de dedup (confiável, spec §5.1): Qdrant local com a string que
    o usuário digitou — não é rede, não passa pelo coordinator. */
export const slskDedupProbe = (query: string) =>
  invoke<Track[]>("slsk_dedup_probe", { query });

export const slskDownload = (
  searchId: string,
  groupKey: string,
  sourceId: string,
  destPlaylist: string,
) =>
  invoke<string>("slsk_download", {
    searchId,
    groupKey,
    sourceId,
    destPlaylist,
  });

export const slskJobs = () => invoke<DownloadJob[]>("slsk_jobs");

export const slskTryOtherSource = (jobId: string) =>
  invoke<string>("slsk_try_other_source", { jobId });

export const slskCancel = (jobId: string) => invoke<void>("slsk_cancel", { jobId });

export const slskClearFinished = () => invoke<number>("slsk_clear_finished");

export const crateScSearch = (query: string) => invoke<ScResult[]>("crate_sc_search", { query });

export const crateScResolve = (url: string) => invoke<ScResult>("crate_sc_resolve", { url });

/**
 * Sondagem do original. Rejeita com a string exata `"no_token"` quando o
 * token do SoundCloud falta ou é recusado pela API (a UI mostra o link para
 * o status das fontes); demais erros chegam como texto livre em PT-BR.
 */
export const crateScProbe = (trackId: number, durationMs: number) =>
  invoke<ScProbe>("crate_sc_probe", { trackId, durationMs });

/** Capa do card como data URL JPEG (<= 500 px), baixada pelo Rust. */
export const crateScArtwork = (url: string) => invoke<string>("crate_sc_artwork", { url });

export const crateDownload = (
  source: Source,
  meta: ConfirmedMeta,
  destPlaylist: string,
  artworkUrl: string | null,
) => invoke<string>("crate_download", { source, meta, destPlaylist, artworkUrl });

export const crateSourcesStatus = () => invoke<SourcesStatus>("crate_sources_status");

/** Snapshot da fila da Tidal (até 30 jobs, mais antigo primeiro). */
export const crateTidalJobs = () => invoke<TidalFilaSnapshot>("crate_tidal_jobs");

/** Enfileira um download da Tidal; `Ok(id)` ou rejeita com texto em PT-BR
    pronto pra tela (link não reconhecido, pasta vazia, já na fila, fila
    indisponível). */
export const crateTidalEnqueue = (url: string, playlist: string) =>
  invoke<string>("crate_tidal_enqueue", { url, playlist });

/** Enfileira só as faixas marcadas na prévia (máx. 200). `origin` = o
    `ref` canônico da prévia (`mix:<id>`, `album:<id>`...). */
export const crateTidalEnqueueSelection = (trackIds: number[], title: string, origin: string, playlist: string) =>
  invoke<string>("crate_tidal_enqueue", { url: "", playlist, trackIds, title, origin });

/** Reenvia uma seleção da fila que ficou parcial ou falhou (mesmas faixas, mesmo pedido). */
export const crateTidalResend = (jobId: string) => invoke<string>("crate_tidal_resend", { jobId });

/** Busca por texto na Tidal, pela fila da VM. Rejeita com texto em PT-BR
    (texto curto, sessão da Tidal expirada, Tidal sem resposta, fila
    indisponível). */
export const crateTidalSearch = (q: string) => invoke<TidalSearch>("crate_tidal_search", { q });

export const crateTidalArtist = (id: number) => invoke<TidalArtistPage>("crate_tidal_artist", { id });

/** Prévia de mix/rádio/playlist/álbum/faixa: link da Tidal ou `tipo:id`
    (`radio-faixa:<id>` = rádio a partir de uma faixa). */
export const crateTidalPreview = (reference: string) =>
  invoke<TidalPreview>("crate_tidal_preview", { reference });

/** Capa de `resources.tidal.com` como data URL JPEG (<= 192 px), baixada
    pelo Rust: a CSP não ganha o host da Tidal. */
export const crateTidalCover = (url: string) => invoke<string>("crate_tidal_cover", { url });

/** Board inteiro por evento (spec §3.5) — throttle 500ms no backend, só
    quando dirty. Nunca diffs incrementais. */
export const onSlskJobs = (cb: (jobs: DownloadJob[]) => void) =>
  listen<DownloadJob[]>("slsk-jobs", (e) => cb(e.payload));

/** Parseia o `Err(string)` de slskSearch pro banner (spec §6.2/§6.3).
    `unknown` cobre "busy"/"offline"/qualquer mensagem não reconhecida —
    o caller decide o texto genérico nesse caso. */
export type SlskSearchErrorKind = "cooldown" | "cold" | "offline" | "busy" | "unknown";

export interface SlskSearchError {
  kind: SlskSearchErrorKind;
  seconds?: number;
}

export function parseSlskSearchError(err: unknown): SlskSearchError {
  const raw =
    typeof err === "string"
      ? err
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err ?? "");
  const m = /^(cooldown|cold):(\d+)$/.exec(raw);
  if (m) return { kind: m[1] as "cooldown" | "cold", seconds: parseInt(m[2], 10) };
  if (raw === "offline") return { kind: "offline" };
  if (raw === "busy") return { kind: "busy" };
  return { kind: "unknown" };
}
