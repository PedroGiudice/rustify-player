mod qdrant_process;

use audio_engine::{
    Command as EngineCommand, Engine, EngineHandle, PlaybackState, StateUpdate, TrackInfo,
};
use library_indexer::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbedClient, Genre, Indexer, IndexerConfig,
    IndexerHandle, LyricLine, PlaylistSearchResult, SearchResults,
    Track, TrackFilter, TrackOrder,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

// ---------------------------------------------------------------------------
// State wrappers
// ---------------------------------------------------------------------------

struct Library {
    handle: IndexerHandle,
    cache_dir: PathBuf,
    music_root: PathBuf,
}
struct Player(Mutex<Option<EngineHandle>>);
// Qdrant state removed — IndexerHandle now owns the QdrantClient.
/// Keeps the Qdrant child process alive for the duration of the app.
/// Drop impl kills the process on app exit.
#[allow(dead_code)]
struct QdrantSidecar(Mutex<Option<qdrant_process::QdrantProcess>>);

/// Payload emitted to frontend via "audio-fft" event.
/// `stream_time_ms` is the track position (ms) this FFT frame belongs to.
#[derive(Clone, Serialize)]
struct FftPayload {
    stream_time_ms: u64,
    magnitudes: Vec<u8>,
}

#[derive(Clone, Serialize, serde::Deserialize)]
struct SpectrumRange {
    label: String,
    from_hz: f32,
    to_hz: f32,
    gain: f32,
}

#[derive(Clone, Serialize, serde::Deserialize)]
struct SpectrumConfig {
    ranges: Vec<SpectrumRange>,
    sample_rate: u32,
    bands: u32,
}

impl Default for SpectrumConfig {
    fn default() -> Self {
        Self {
            ranges: vec![
                SpectrumRange { label: "Sub-bass".into(), from_hz: 20.0, to_hz: 60.0, gain: 1.0 },
                SpectrumRange { label: "Bass".into(), from_hz: 60.0, to_hz: 250.0, gain: 1.0 },
                SpectrumRange { label: "Low-mid".into(), from_hz: 250.0, to_hz: 500.0, gain: 1.0 },
                SpectrumRange { label: "Mid".into(), from_hz: 500.0, to_hz: 2000.0, gain: 1.0 },
                SpectrumRange { label: "Upper-mid".into(), from_hz: 2000.0, to_hz: 4000.0, gain: 1.0 },
                SpectrumRange { label: "Presence".into(), from_hz: 4000.0, to_hz: 8000.0, gain: 1.0 },
                SpectrumRange { label: "Brilliance".into(), from_hz: 8000.0, to_hz: 20000.0, gain: 1.0 },
            ],
            sample_rate: 44100,
            bands: 512,
        }
    }
}

impl SpectrumConfig {}

struct SharedSpectrumConfig(Arc<Mutex<SpectrumConfig>>);
struct SpectrumActive(Arc<AtomicBool>);

/// Snapshot of engine state, updated by the event-listener thread.
/// Read by the `get_state` command so the frontend can hydrate views
/// without waiting for the next event push.
///
/// `current_track` exposes the engine's decoder-level `TrackInfo` (path,
/// sample rate, channels, bit depth). `current_library_track` enriches
/// the snapshot with library metadata resolved by looking up
/// `current_track.path` in the indexer (title, artist, cover, lrc path,
/// ...). Both are cleared when playback stops.
#[derive(Default, Clone, Serialize)]
struct PlayerSnapshot {
    current_track: Option<TrackInfo>,
    current_library_track: Option<Track>,
    is_playing: bool,
    volume: f32,
    current_origin: Option<String>,
    current_track_id: Option<u64>,
    started_at: Option<i64>,
    last_position_ms: Option<i64>,
}

/// If a track is currently being played and we have enough state to log it
/// (track_id, origin, started_at, duration), emit a `play_event` and clear the
/// pending fields. Used both for natural completion (`track_ended`) and skips
/// (`track_skipped`). Caller decides which one fits the lifecycle event.
///
/// Returns true if an event was actually written.
fn flush_play_event(
    snap: &mut PlayerSnapshot,
    indexer: &library_indexer::IndexerHandle,
    event_type: &str,
) -> bool {
    let (track_id, origin, started_at, duration) = match (
        snap.current_track_id,
        snap.current_origin.clone(),
        snap.started_at,
        snap.current_track
            .as_ref()
            .and_then(|t| t.duration)
            .map(|d| d.as_millis() as u64),
    ) {
        (Some(tid), Some(o), Some(s), Some(d)) => (tid, o, s, d),
        _ => return false,
    };

    let end_pos = snap.last_position_ms.unwrap_or(0).max(0) as u64;

    if let Err(e) = indexer.client().insert_play_event(
        event_type,
        track_id,
        &origin,
        started_at,
        unix_now(),
        end_pos,
        duration,
    ) {
        tracing::warn!(?e, track_id, event_type, "failed to record play event");
        return false;
    }

    snap.current_origin = None;
    snap.current_track_id = None;
    snap.started_at = None;
    snap.last_position_ms = None;
    true
}
struct Snapshot(Arc<Mutex<PlayerSnapshot>>);

/// Port on which the local media HTTP server is listening.
/// Fixed at 19876 so the Tauri CSP can allowlist it statically.
struct MediaServerPort(u16);

// ---------------------------------------------------------------------------
// Error bridging — Tauri commands return Result<T, String>
// ---------------------------------------------------------------------------

fn parse_id(s: &str) -> Result<u64, String> {
    s.parse::<u64>().map_err(|e| format!("invalid track id: {e}"))
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// Library commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_list_genres(lib: State<Library>) -> Result<Vec<Genre>, String> {
    lib.handle.list_genres().map_err(err)
}

#[tauri::command]
fn lib_list_tracks(
    lib: State<Library>,
    genre: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let filter = TrackFilter {
        genre,
        artist,
        album,
        limit,
        ..Default::default()
    };
    let mut tracks = lib.handle.list_tracks(filter).map_err(err)?;
    for track in &mut tracks {
        if let Some(rel) = &track.album_cover_path {
            track.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn lib_list_albums(
    lib: State<Library>,
    artist: Option<String>,
    genre: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Album>, String> {
    let filter = AlbumFilter {
        artist,
        genre,
        limit,
    };
    let mut albums = lib.handle.list_albums(filter).map_err(err)?;

    // Resolve absolute cover paths
    for album in &mut albums {
        if let Some(rel) = &album.cover_path {
            album.cover_path = Some(lib.cache_dir.join(rel));
        }
    }

    Ok(albums)
}

#[tauri::command]
fn lib_list_artists(
    lib: State<Library>,
    genre: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Artist>, String> {
    let filter = ArtistFilter {
        genre,
        limit,
    };
    lib.handle.list_artists(filter).map_err(err)
}

#[tauri::command]
fn lib_search(
    lib: State<Library>,
    query: String,
    limit: Option<usize>,
) -> Result<SearchResults, String> {
    let mut results = lib
        .handle
        .search(&query, limit.unwrap_or(20))
        .map_err(err)?;

    // Resolve absolute cover paths in albums search results
    for album in &mut results.albums {
        if let Some(rel) = &album.cover_path {
            album.cover_path = Some(lib.cache_dir.join(rel));
        }
    }

    // Resolve absolute cover paths in tracks search results
    for track in &mut results.tracks {
        if let Some(rel) = &track.album_cover_path {
            track.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }

    Ok(results)
}

#[tauri::command]
fn lib_semantic_search(
    lib: State<Library>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let client = lib.handle.client();
    let tei = library_indexer::LyricsEmbedClient::new("http://100.123.73.128:8080");
    let vector = tei.embed_text(&query).map_err(err)?;
    let results = client.semantic_search(&vector, limit.unwrap_or(10)).map_err(err)?;

    let mut tracks = Vec::new();
    for (track_id, _score) in results {
        if let Ok(Some(mut t)) = lib.handle.track(track_id) {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
            tracks.push(t);
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn lib_mood_search(
    lib: State<Library>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let client = lib.handle.client();
    let filters = library_indexer::MoodFilters::parse(&query);
    if filters.is_empty() {
        return Ok(Vec::new());
    }
    let ids = client.mood_search_enrichments(&filters, limit.unwrap_or(50)).map_err(err)?;

    let mut tracks = Vec::new();
    for track_id in ids {
        if let Ok(Some(mut t)) = lib.handle.track(track_id) {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
            if let Some(ref genre_filter) = filters.genre {
                if let Some(ref track_genre) = t.genre_name {
                    if track_genre != genre_filter {
                        continue;
                    }
                } else {
                    continue;
                }
            }
            tracks.push(t);
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn lib_get_track(lib: State<Library>, id: u64) -> Result<Option<Track>, String> {
    let track = lib.handle.track(id).map_err(err)?;
    Ok(track.map(|mut t| {
        if let Some(rel) = &t.album_cover_path {
            t.album_cover_path = Some(lib.cache_dir.join(rel));
        }
        t
    }))
}

#[tauri::command]
fn lib_find_similar(
    lib: State<Library>,
    track_id: String,
    limit: Option<usize>,
) -> Result<Vec<SimilarTrack>, String> {
    let tid = parse_id(&track_id)?;
    lib.handle
        .similar(tid, limit.unwrap_or(10))
        .map(|v| {
            v.into_iter()
                .map(|(t, s)| SimilarTrack { track: t, score: s })
                .collect()
        })
        .map_err(err)
}

#[derive(Serialize)]
struct SimilarTrack {
    track: Track,
    score: f32,
}

#[tauri::command]
fn lib_shuffle(
    lib: State<Library>,
    genre: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let filter = TrackFilter {
        genre,
        order: TrackOrder::Random,
        limit,
        ..Default::default()
    };
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    lib.handle
        .shuffle(filter, seed, limit.unwrap_or(50))
        .map_err(err)
}

#[tauri::command]
fn lib_autoplay_next(
    lib: State<Library>,
    track_id: String,
    exclude_ids: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let track_id = parse_id(&track_id)?;
    let exclude_ids: Vec<u64> = exclude_ids.iter().filter_map(|s| s.parse().ok()).collect();
    let lim = limit.unwrap_or(5);
    let client = lib.handle.client();

    // Layer 1: Qdrant Recommendations API with behavioral signals.
    //
    // Positives are built as `[seed × SEED_WEIGHT, ...history]`. Qdrant's
    // Recommendations API averages all positives equally; without weighting,
    // a seed competes with up to ~30 historical favorites and gets diluted
    // (~3% of the centroid). Repeating the seed dominates the recommendation
    // vector toward the current vibe while keeping history as flavoring.
    //
    // exclude_ids is passed as a hard filter (must_not has_id), NOT as Qdrant
    // negatives. Negatives reshape the search vector; we only want to skip
    // recently-played items in the result list.
    if client.is_healthy() {
        const SEED_WEIGHT: usize = 20;
        match lib.handle.behavioral_signals() {
            Ok((history, negatives)) => {
                let mut positives: Vec<u64> =
                    std::iter::repeat(track_id).take(SEED_WEIGHT).collect();
                positives.extend(history.into_iter().filter(|id| *id != track_id));
                match client.recommend(&positives, &negatives, &exclude_ids, lim) {
                    Ok(recs) if !recs.is_empty() => {
                        let mut tracks = Vec::new();
                        for (rec_id, _score) in &recs {
                            if let Ok(Some(mut t)) = lib.handle.track(*rec_id) {
                                if let Some(rel) = &t.album_cover_path {
                                    t.album_cover_path = Some(lib.cache_dir.join(rel));
                                }
                                tracks.push(t);
                            }
                        }
                        if !tracks.is_empty() {
                            return Ok(tracks);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::warn!(track_id, error = %e, "autoplay: recommend failed");
                    }
                }
            }
            Err(e) => {
                tracing::warn!(track_id, error = %e, "autoplay: behavioral_signals failed");
            }
        }
    }

    // Layer 2: Similar via Qdrant recommend
    let recs = lib.handle.autoplay_next(track_id, &exclude_ids, lim).map_err(err)?;
    if !recs.is_empty() {
        let mut tracks = Vec::new();
        for (rec_id, _score) in recs {
            if let Ok(Some(mut t)) = lib.handle.track(rec_id) {
                if let Some(rel) = &t.album_cover_path {
                    t.album_cover_path = Some(lib.cache_dir.join(rel));
                }
                tracks.push(t);
            }
        }
        if !tracks.is_empty() {
            return Ok(tracks);
        }
    }

    // Layer 3: Shuffle fallback
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut tracks = lib.handle
        .shuffle(TrackFilter::default(), seed, lim)
        .map_err(err)?;
    for t in &mut tracks {
        if let Some(rel) = &t.album_cover_path {
            t.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }

    Ok(tracks)
}

#[tauri::command]
fn lib_snapshot(lib: State<Library>) -> library_indexer::IndexerSnapshot {
    lib.handle.snapshot()
}

// ---------------------------------------------------------------------------
// Folder-based playlists
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_list_folders(lib: State<Library>) -> Result<Vec<library_indexer::FolderPlaylist>, String> {
    let root = lib.music_root.to_string_lossy();
    lib.handle.list_folders(&root).map_err(err)
}

#[tauri::command]
fn lib_list_folder_tracks(lib: State<Library>, folder: String) -> Result<Vec<Track>, String> {
    let root = lib.music_root.to_string_lossy();
    let mut tracks = lib.handle.list_folder_tracks(&root, &folder).map_err(err)?;
    for track in &mut tracks {
        if let Some(rel) = &track.album_cover_path {
            track.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(tracks)
}

// ---------------------------------------------------------------------------
// Playlist search
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_search_playlists(
    lib: State<Library>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<PlaylistSearchResult>, String> {
    let mut results = lib
        .handle
        .search_playlists(
            lib.music_root.to_str().unwrap_or(""),
            &query,
            limit.unwrap_or(50),
        )
        .map_err(err)?;

    for result in &mut results {
        for t in &mut result.tracks {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
        }
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// Library management
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_rescan(lib: State<Library>) -> Result<(), String> {
    lib.handle
        .send(library_indexer::IndexerCommand::Rescan)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_get_lyrics(lib: State<Library>, track_id: String) -> Result<Vec<LyricLine>, String> {
    lib.handle.get_lyrics(parse_id(&track_id)?).map_err(err)
}

// ---------------------------------------------------------------------------
// Playback history
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_record_play(lib: State<Library>, track_id: String) -> Result<(), String> {
    lib.handle.record_play(parse_id(&track_id)?).map_err(err)
}

#[tauri::command]
fn lib_list_history(lib: State<Library>, limit: Option<usize>) -> Result<Vec<Track>, String> {
    let mut tracks = lib.handle.list_history(limit.unwrap_or(50)).map_err(err)?;
    for track in &mut tracks {
        if let Some(rel) = &track.album_cover_path {
            track.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(tracks)
}

// ---------------------------------------------------------------------------
// Likes / Favorites
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_toggle_like(lib: State<Library>, track_id: String) -> Result<bool, String> {
    lib.handle.toggle_like(parse_id(&track_id)?).map_err(err)
}

#[tauri::command]
fn lib_list_liked(lib: State<Library>, limit: Option<usize>) -> Result<Vec<Track>, String> {
    let mut tracks = lib.handle.list_liked(limit.unwrap_or(200)).map_err(err)?;
    for t in &mut tracks {
        if let Some(rel) = &t.album_cover_path {
            t.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn lib_is_liked(lib: State<Library>, track_id: String) -> Result<bool, String> {
    lib.handle.is_liked(parse_id(&track_id)?).map_err(err)
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_recommendations(
    lib: State<Library>,
) -> Result<library_indexer::Recommendations, String> {
    let mut recs = lib.handle.recommendations().map_err(err)?;
    // Resolve cover paths to absolute
    for track in recs
        .most_played
        .iter_mut()
        .chain(recs.based_on_top.iter_mut())
        .chain(recs.discover.iter_mut())
    {
        if let Some(rel) = &track.album_cover_path {
            track.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(recs)
}

// ---------------------------------------------------------------------------
// Mood playlists
// ---------------------------------------------------------------------------

// Mood playlists: removed in Qdrant-only model (moods are search queries now).

// ---------------------------------------------------------------------------
// Qdrant sync
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_backgrounds() -> Result<Vec<String>, String> {
    let bg_dir = dirs_home()
        .join(".local/share/rustify-player/media/bg");
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&bg_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".webp") || name.ends_with(".png") || name.ends_with(".jpg") {
                names.push(name);
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn get_spectrum_config(config: State<SharedSpectrumConfig>) -> SpectrumConfig {
    config.0.lock().unwrap().clone()
}

#[tauri::command]
fn set_spectrum_config(config: State<SharedSpectrumConfig>, ranges: Vec<SpectrumRange>) {
    let mut cfg = config.0.lock().unwrap();
    cfg.ranges = ranges;
}

#[tauri::command]
fn spectrum_subscribe(active: State<SpectrumActive>) {
    active.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn spectrum_unsubscribe(active: State<SpectrumActive>) {
    active.0.store(false, Ordering::Relaxed);
}

// ─── Spectrum Visual Presets ─────────────────────────────────────────────────

fn spectrum_presets_dir() -> PathBuf {
    dirs_home().join(".local/share/rustify-player/spectrum")
}

#[derive(Clone, Serialize, serde::Deserialize)]
struct SpectrumVisualConfig {
    name: String,
    lines: u32,
    points_per_line: u32,
    attack: f32,
    release: f32,
    release_bass: f32,
    log_exponent: f32,
    bass_bin_threshold: u32,
    base_strength: f32,
    energy_multiplier: f32,
    bass_multiplier: f32,
    low_mid_multiplier: f32,
    compression_bass: f32,
    compression_default: f32,
    hue_spread: f32,
    saturation: f32,
    base_alpha: f32,
    depth_alpha: f32,
    energy_alpha: f32,
    base_lightness: f32,
    depth_lightness: f32,
    energy_lightness: f32,
    regions: Vec<[f32; 2]>,
    // V2 params — serde defaults for backward compat with existing YAMLs
    #[serde(default = "default_style")]
    style: String,
    #[serde(default = "default_brightness_rigidity")]
    brightness_rigidity: f32,
    #[serde(default = "default_bass_reactivity_boost")]
    bass_reactivity_boost: f32,
    #[serde(default = "default_bass_attack_scale")]
    bass_attack_scale: f32,
    #[serde(default = "default_invert_depth")]
    invert_depth: bool,
    #[serde(default = "default_bg_dimming")]
    bg_dimming: f32,
    #[serde(default = "default_bg_pulse_strength")]
    bg_pulse_strength: f32,
    #[serde(default = "default_gravity_decay")]
    gravity_decay: f32,
    #[serde(default = "default_agc_decay")]
    agc_decay: f32,
    #[serde(default = "default_agc_floor")]
    agc_floor: f32,
    // Fluid params
    #[serde(default = "default_fluid_density_dissipation")]
    fluid_density_dissipation: f32,
    #[serde(default = "default_fluid_velocity_dissipation")]
    fluid_velocity_dissipation: f32,
    #[serde(default = "default_fluid_curl")]
    fluid_curl: f32,
    #[serde(default = "default_fluid_splat_radius")]
    fluid_splat_radius: f32,
    #[serde(default = "default_fluid_splat_force")]
    fluid_splat_force: f32,
    #[serde(default = "default_fluid_color_intensity")]
    fluid_color_intensity: f32,
    #[serde(default = "default_fluid_sensitivity")]
    fluid_sensitivity: f32,
    #[serde(default = "default_fluid_pressure_iterations")]
    fluid_pressure_iterations: u32,
    // Peak-trigger / colour calibration (frontend-only, hot-reloadable)
    #[serde(default = "default_fluid_peak_threshold")]
    fluid_peak_threshold: f32,
    #[serde(default = "default_fluid_delta_threshold")]
    fluid_delta_threshold: f32,
    #[serde(default = "default_fluid_jitter_amount")]
    fluid_jitter_amount: f32,
    #[serde(default = "default_fluid_hue_jitter")]
    fluid_hue_jitter: f32,
    #[serde(default = "default_fluid_sat_base")]
    fluid_sat_base: f32,
    #[serde(default = "default_fluid_sat_jitter")]
    fluid_sat_jitter: f32,
    // SDF Raymarching params
    #[serde(default = "default_sdf_step_count")]
    sdf_step_count: u32,
    #[serde(default = "default_sdf_max_dist")]
    sdf_max_dist: f32,
    #[serde(default = "default_sdf_warp_intensity")]
    sdf_warp_intensity: f32,
    #[serde(default = "default_sdf_warp_frequency")]
    sdf_warp_frequency: f32,
    #[serde(default = "default_sdf_smooth_k")]
    sdf_smooth_k: f32,
    #[serde(default = "default_sdf_emissive_boost")]
    sdf_emissive_boost: f32,
    #[serde(default = "default_sdf_resolution_scale")]
    sdf_resolution_scale: f32,
    #[serde(default = "default_sdf_render_mode")]
    sdf_render_mode: u32,
    // Animated shape (directory with manifest.json + normal_*.png) driver params.
    // Position advances per render frame as: baseline + energy_gain*E + peak_kick*kick_gain.
    #[serde(default = "default_shape_anim_baseline_speed")]
    shape_anim_baseline_speed: f32,
    #[serde(default = "default_shape_anim_energy_gain")]
    shape_anim_energy_gain: f32,
    #[serde(default = "default_shape_anim_peak_kick_gain")]
    shape_anim_peak_kick_gain: f32,
    #[serde(default = "default_shape_anim_peak_threshold")]
    shape_anim_peak_threshold: f32,
    #[serde(default = "default_shape_anim_peak_decay")]
    shape_anim_peak_decay: f32,
    #[serde(default = "default_shape_anim_mode")]
    shape_anim_mode: String,
}

fn default_style() -> String { "exoskeleton".into() }
fn default_brightness_rigidity() -> f32 { 0.7 }
fn default_bass_reactivity_boost() -> f32 { 1.4 }
fn default_bass_attack_scale() -> f32 { 0.43 }
fn default_invert_depth() -> bool { true }
fn default_bg_dimming() -> f32 { 0.45 }
fn default_bg_pulse_strength() -> f32 { 0.25 }
fn default_gravity_decay() -> f32 { 1.5 }
fn default_agc_decay() -> f32 { 0.985 }
fn default_agc_floor() -> f32 { 3.0 }
fn default_fluid_density_dissipation() -> f32 { 4.0 }    // Fade ~180ms — splat reads as fluid, fades cleanly between events
fn default_fluid_velocity_dissipation() -> f32 { 2.5 }   // Velocity persists ~280ms — solver grows real swirls (this is what makes it look like fluid)
fn default_fluid_curl() -> f32 { 38.0 }                  // Higher vorticity — splats actually swirl and curl, not just fade in place
fn default_fluid_splat_radius() -> f32 { 0.20 }          // Larger blobs — more presence on canvas, fluid swirl reads clearly
fn default_fluid_splat_force() -> f32 { 600.0 }          // Base reference; frontend multiplies by 0.015 × peakStrength (event-driven)
fn default_fluid_color_intensity() -> f32 { 0.35 }       // Restored to visible range; peak-triggered emission is sparse, so each splat must carry weight
fn default_fluid_sensitivity() -> f32 { 1.0 }
fn default_fluid_pressure_iterations() -> u32 { 25 }
// Peak-trigger / colour calibration (frontend reads these into per-event splat logic)
fn default_fluid_peak_threshold() -> f32 { 1.25 }   // ratio path: energy/runningAvg above this fires
fn default_fluid_delta_threshold() -> f32 { 0.06 }  // delta path: energy jump per FFT frame above this fires
fn default_fluid_jitter_amount() -> f32 { 0.10 }    // ±half this in canvas units, applied to Lissajous splat position
fn default_fluid_hue_jitter() -> f32 { 0.14 }       // full range of hue jitter per splat (0..1 = full circle)
fn default_fluid_sat_base() -> f32 { 0.75 }         // saturation floor; peakStrength adds 0..0.25 on top
fn default_fluid_sat_jitter() -> f32 { 0.10 }       // random saturation jitter per splat (uniform 0..this)
// SDF Raymarching defaults — tuned for "lite 3D" by default: lower step
// count and tighter half-res keep fragment work modest on integrated GPUs.
// Switch to render_mode=0 for the 2D glow path if 3D is still too heavy.
fn default_sdf_step_count() -> u32 { 32 }           // 48→32: ~30% cheaper, silhouette near-identical
fn default_sdf_max_dist() -> f32 { 12.0 }
fn default_sdf_warp_intensity() -> f32 { 0.6 }      // 0..1, audio scales 0..2x
fn default_sdf_warp_frequency() -> f32 { 1.8 }      // spatial frequency of domain warp
fn default_sdf_smooth_k() -> f32 { 0.85 }           // smin blending — higher = more organic merging
fn default_sdf_emissive_boost() -> f32 { 1.3 }      // multiplier applied to fresnel rim + core glow
fn default_sdf_resolution_scale() -> f32 { 0.4 }    // render to 0.4x viewport, upscale linearly — biggest perf knob
fn default_sdf_render_mode() -> u32 { 1 }           // 0 = 2D glow (cheapest, neon look), 1 = 3D raymarched (default, volumetric)
fn default_shape_anim_baseline_speed() -> f32 { 0.02 }   // subtle constant rotation in silence (~40s/full turn @60fps for 48f)
fn default_shape_anim_energy_gain() -> f32 { 0.4 }        // multiplier on smoothed full-band energy (sustained loudness pull)
fn default_shape_anim_peak_kick_gain() -> f32 { 0.8 }     // multiplier on ASR peak velocity — high so kicks are clearly visible
fn default_shape_anim_peak_threshold() -> f32 { 0.01 }    // delta in raw sub-bass needed to trigger a peak kick (lower = more sensitive)
fn default_shape_anim_peak_decay() -> f32 { 0.90 }        // peak kick velocity multiplier/frame (0.90 = ~115ms half-life @60fps, snappier)
fn default_shape_anim_mode() -> String { "intensity".into() }  // pendulum | intensity | band_split (requires Gemini-classified manifest for the latter two)

impl Default for SpectrumVisualConfig {
    fn default() -> Self {
        Self {
            name: "Default".into(),
            lines: 150,
            points_per_line: 120,
            attack: 0.35,
            release: 0.06,
            release_bass: 0.043,
            log_exponent: 1.5,
            bass_bin_threshold: 40,
            base_strength: 12.0,
            energy_multiplier: 220.0,
            bass_multiplier: 1.6,
            low_mid_multiplier: 1.3,
            compression_bass: 0.55,
            compression_default: 0.75,
            hue_spread: 20.0,
            saturation: 0.85,
            base_alpha: 0.12,
            depth_alpha: 0.2,
            energy_alpha: 0.15,
            base_lightness: 38.0,
            depth_lightness: 18.0,
            energy_lightness: 12.0,
            regions: vec![
                [0.0, 6.0], [6.0, 16.0], [16.0, 32.0],
                [32.0, 56.0], [56.0, 84.0], [84.0, 120.0],
                [120.0, 168.0], [168.0, 216.0], [216.0, 256.0],
            ],
            style: default_style(),
            brightness_rigidity: default_brightness_rigidity(),
            bass_reactivity_boost: default_bass_reactivity_boost(),
            bass_attack_scale: default_bass_attack_scale(),
            invert_depth: default_invert_depth(),
            bg_dimming: default_bg_dimming(),
            bg_pulse_strength: default_bg_pulse_strength(),
            gravity_decay: default_gravity_decay(),
            agc_decay: default_agc_decay(),
            agc_floor: default_agc_floor(),
            fluid_density_dissipation: default_fluid_density_dissipation(),
            fluid_velocity_dissipation: default_fluid_velocity_dissipation(),
            fluid_curl: default_fluid_curl(),
            fluid_splat_radius: default_fluid_splat_radius(),
            fluid_splat_force: default_fluid_splat_force(),
            fluid_color_intensity: default_fluid_color_intensity(),
            fluid_sensitivity: default_fluid_sensitivity(),
            fluid_pressure_iterations: default_fluid_pressure_iterations(),
            fluid_peak_threshold: default_fluid_peak_threshold(),
            fluid_delta_threshold: default_fluid_delta_threshold(),
            fluid_jitter_amount: default_fluid_jitter_amount(),
            fluid_hue_jitter: default_fluid_hue_jitter(),
            fluid_sat_base: default_fluid_sat_base(),
            fluid_sat_jitter: default_fluid_sat_jitter(),
            sdf_step_count: default_sdf_step_count(),
            sdf_max_dist: default_sdf_max_dist(),
            sdf_warp_intensity: default_sdf_warp_intensity(),
            sdf_warp_frequency: default_sdf_warp_frequency(),
            sdf_smooth_k: default_sdf_smooth_k(),
            sdf_emissive_boost: default_sdf_emissive_boost(),
            sdf_resolution_scale: default_sdf_resolution_scale(),
            sdf_render_mode: default_sdf_render_mode(),
            shape_anim_baseline_speed: default_shape_anim_baseline_speed(),
            shape_anim_energy_gain: default_shape_anim_energy_gain(),
            shape_anim_peak_kick_gain: default_shape_anim_peak_kick_gain(),
            shape_anim_peak_threshold: default_shape_anim_peak_threshold(),
            shape_anim_peak_decay: default_shape_anim_peak_decay(),
            shape_anim_mode: default_shape_anim_mode(),
        }
    }
}

#[derive(Clone, Serialize)]
struct SpectrumPresetInfo {
    filename: String,
    name: String,
}

#[tauri::command]
fn list_spectrum_presets() -> Vec<SpectrumPresetInfo> {
    let dir = spectrum_presets_dir();
    std::fs::create_dir_all(&dir).ok();
    let mut presets = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if !fname.ends_with(".yaml") && !fname.ends_with(".yml") { continue; }
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                if let Ok(cfg) = serde_yaml::from_str::<SpectrumVisualConfig>(&content) {
                    presets.push(SpectrumPresetInfo { filename: fname, name: cfg.name });
                }
            }
        }
    }
    presets.sort_by(|a, b| a.name.cmp(&b.name));
    presets
}

#[tauri::command]
fn load_spectrum_preset(filename: String) -> Result<SpectrumVisualConfig, String> {
    let path = spectrum_presets_dir().join(&filename);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read preset: {e}"))?;
    serde_yaml::from_str(&content)
        .map_err(|e| format!("Invalid YAML: {e}"))
}

#[tauri::command]
fn save_spectrum_preset(filename: String, config: SpectrumVisualConfig) -> Result<(), String> {
    let dir = spectrum_presets_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {e}"))?;
    let path = dir.join(&filename);
    let yaml = serde_yaml::to_string(&config)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    std::fs::write(&path, yaml)
        .map_err(|e| format!("Failed to write: {e}"))
}

#[tauri::command]
fn watch_spectrum_preset(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let path = spectrum_presets_dir().join(&filename);
    if !path.exists() {
        return Err(format!("Preset not found: {filename}"));
    }
    let app_handle = app.clone();
    std::thread::Builder::new()
        .name("spectrum-watcher".into())
        .spawn(move || {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let mut watcher: notify::RecommendedWatcher = match notify::Watcher::new(
                move |res: Result<notify::Event, notify::Error>| {
                    if let Ok(event) = res {
                        if matches!(event.kind, notify::EventKind::Modify(_)) {
                            let _ = tx.send(());
                        }
                    }
                },
                notify::Config::default(),
            ) {
                Ok(w) => w,
                Err(e) => { tracing::error!("Failed to create watcher: {e}"); return; }
            };
            if let Err(e) = notify::Watcher::watch(
                &mut watcher, &path, notify::RecursiveMode::NonRecursive
            ) {
                tracing::error!("Failed to watch {}: {e}", path.display());
                return;
            }
            tracing::info!("Watching spectrum preset: {}", path.display());
            // Debounce: wait 500ms after last event before emitting
            loop {
                match rx.recv() {
                    Ok(()) => {
                        // Drain any rapid-fire events within 500ms
                        while rx.recv_timeout(std::time::Duration::from_millis(500)).is_ok() {}
                        let _ = app_handle.emit("spectrum-config-changed", ());
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("Failed to spawn watcher: {e}"))?;
    Ok(())
}

fn themes_dir() -> PathBuf {
    dirs_home().join(".local/share/rustify-player/themes")
}

fn yaml_to_css_vars(val: &serde_yaml::Value, prefix: &str, out: &mut std::collections::HashMap<String, String>) {
    match val {
        serde_yaml::Value::Mapping(map) => {
            for (k, v) in map {
                let key = k.as_str().unwrap_or("");
                if key == "name" || key == "author" { continue; }
                let new_prefix = if prefix.is_empty() { key.to_string() } else { format!("{prefix}-{key}") };
                yaml_to_css_vars(v, &new_prefix, out);
            }
        }
        serde_yaml::Value::String(s) => {
            let css_prop = match prefix {
                "surfaces-lowest" => "--surface-lowest",
                "surfaces-base" => "--surface",
                "surfaces-container-low" => "--surface-container-low",
                "surfaces-container" => "--surface-container",
                "surfaces-container-high" => "--surface-container-high",
                "surfaces-container-highest" => "--surface-container-highest",
                "dividers-subtle" => "--divider",
                "dividers-prominent" => "--divider-hi",
                "accent-primary" => "--primary",
                "accent-primary-container" => "--primary-container",
                "accent-primary-fixed-dim" => "--primary-fixed-dim",
                "accent-on-primary" => "--on-primary",
                "accent-on-primary-container" => "--on-primary-container",
                "text-primary" => "--on-surface",
                "text-secondary" => "--on-surface-variant",
                "text-muted" => "--on-surface-mute",
                "text-outline" => "--outline-variant",
                "signal-ok" => "--sig-ok",
                "signal-warn" => "--sig-warn",
                "signal-error" => "--sig-err",
                "typography-body" => "--font-body",
                "typography-display" => "--font-display",
                "typography-mono" => "--font-mono",
                "typography-technical" => "--font-technical",
                "effects-glow" => "--glow",
                "effects-surface-blur" => "--surface-blur",
                "effects-surface-opacity" => "--surface-opacity",
                _ => return,
            };
            out.insert(css_prop.to_string(), s.clone());
        }
        serde_yaml::Value::Number(n) => {
            let css_prop = match prefix {
                "effects-glow" => "--glow",
                "effects-surface-blur" => "--surface-blur",
                "effects-surface-opacity" => "--surface-opacity",
                _ => return,
            };
            out.insert(css_prop.to_string(), n.to_string());
        }
        _ => {}
    }
}

#[derive(Serialize, Clone)]
struct ThemeInfo {
    filename: String,
    name: String,
    author: String,
}

#[tauri::command]
fn list_themes() -> Vec<ThemeInfo> {
    let dir = themes_dir();
    std::fs::create_dir_all(&dir).ok();
    let mut themes = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if !fname.ends_with(".yaml") && !fname.ends_with(".yml") { continue; }
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                if let Ok(val) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
                    themes.push(ThemeInfo {
                        filename: fname,
                        name: val["name"].as_str().unwrap_or("Untitled").to_string(),
                        author: val["author"].as_str().unwrap_or("").to_string(),
                    });
                }
            }
        }
    }
    themes.sort_by(|a, b| a.name.cmp(&b.name));
    themes
}

fn hex_to_rgb(hex: &str) -> Option<(f64, f64, f64)> {
    let hex = hex.trim_start_matches('#');
    if hex.len() < 6 { return None; }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()? as f64 / 255.0;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()? as f64 / 255.0;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()? as f64 / 255.0;
    Some((r, g, b))
}

fn relative_luminance(r: f64, g: f64, b: f64) -> f64 {
    let linearize = |c: f64| if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

fn contrast_ratio(l1: f64, l2: f64) -> f64 {
    let (lighter, darker) = if l1 > l2 { (l1, l2) } else { (l2, l1) };
    (lighter + 0.05) / (darker + 0.05)
}

#[derive(Serialize)]
struct ContrastCheck {
    pair: String,
    ratio: f64,
    pass_aa: bool,
    pass_aaa: bool,
}

#[derive(Serialize)]
struct ThemeLoadResult {
    vars: std::collections::HashMap<String, String>,
    contrast: Vec<ContrastCheck>,
}

#[tauri::command]
fn load_theme(filename: String) -> Result<ThemeLoadResult, String> {
    let path = themes_dir().join(&filename);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read theme: {e}"))?;
    let val: serde_yaml::Value = serde_yaml::from_str(&content).map_err(|e| format!("Invalid YAML: {e}"))?;
    let mut vars = std::collections::HashMap::new();
    yaml_to_css_vars(&val, "", &mut vars);

    let mut checks = Vec::new();
    let pairs = [
        ("text on surface", "--on-surface", "--surface-lowest"),
        ("secondary on surface", "--on-surface-variant", "--surface-lowest"),
        ("muted on surface", "--on-surface-mute", "--surface-lowest"),
        ("text on container", "--on-surface", "--surface-container"),
        ("accent on surface", "--primary", "--surface-lowest"),
        ("text on accent", "--on-primary", "--primary"),
    ];
    for (label, fg_key, bg_key) in pairs {
        if let (Some(fg), Some(bg)) = (vars.get(fg_key), vars.get(bg_key)) {
            if let (Some(fg_rgb), Some(bg_rgb)) = (hex_to_rgb(fg), hex_to_rgb(bg)) {
                let l1 = relative_luminance(fg_rgb.0, fg_rgb.1, fg_rgb.2);
                let l2 = relative_luminance(bg_rgb.0, bg_rgb.1, bg_rgb.2);
                let ratio = contrast_ratio(l1, l2);
                checks.push(ContrastCheck {
                    pair: label.to_string(),
                    ratio: (ratio * 100.0).round() / 100.0,
                    pass_aa: ratio >= 4.5,
                    pass_aaa: ratio >= 7.0,
                });
            }
        }
    }

    Ok(ThemeLoadResult { vars, contrast: checks })
}

#[tauri::command]
fn list_shapes() -> Result<Vec<String>, String> {
    let shapes_dir = dirs_home().join(".local/share/rustify-player/media/shapes");
    std::fs::create_dir_all(&shapes_dir).ok();
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&shapes_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".png") || name.ends_with(".svg") || name.ends_with(".webp") || name.ends_with(".jpg") || name.ends_with(".jpeg") {
                names.push(name);
            } else if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                // Directory shapes hold pre-generated normal-map sequences
                // (manifest.json + normal_*.png) for animated visuals.
                let manifest = entry.path().join("manifest.json");
                if manifest.is_file() {
                    names.push(name);
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn get_track_color(lib: State<Library>, track_id: String) -> Result<String, String> {
    let tid = parse_id(&track_id)?;
    let client = lib.handle.client();

    let enr = client.get_enrichment(tid).map_err(err)?;
    if let Some(color) = enr["dominant_color"].as_str().filter(|s| !s.is_empty()) {
        return Ok(color.to_string());
    }

    // Fallback: compute from cached cover, persist in enrichments
    let payload = client.get_payload(tid).map_err(err)?;
    if let Some(rel) = payload["cover_path"].as_str() {
        let cover_file = lib.cache_dir.join(rel);
        if cover_file.exists() {
            let source = library_indexer::CoverSource::FolderFile(cover_file);
            if let Some(hex) = library_indexer::dominant_color(&source) {
                client.set_enrichment(tid, serde_json::json!({"dominant_color": hex})).ok();
                return Ok(hex);
            }
        }
    }

    Ok(String::new())
}

// qdrant_sync removed — pipeline writes directly to Qdrant during scan.

#[tauri::command]
fn log_event(lib: State<Library>, payload: serde_json::Value) -> Result<(), String> {
    let event_type = payload
        .get("event_type")
        .and_then(|v| v.as_str())
        .ok_or("missing event_type")?;
    if event_type.is_empty() {
        return Err("empty event_type".into());
    }
    payload.get("timestamp").ok_or("missing timestamp")?;

    let client = lib.handle.client();
    client.insert_raw_event(&payload).map_err(err)
}

// ---------------------------------------------------------------------------
// Player commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn player_play(
    player: State<Player>,
    snapshot: State<Snapshot>,
    library: State<Library>,
    path: String,
    origin: Option<String>,
    track_id: Option<String>,
) -> Result<(), String> {
    let tid = track_id.as_deref().and_then(|s| s.parse::<u64>().ok());
    if let Ok(mut s) = snapshot.0.lock() {
        // If a track was already playing, this call is a skip — log it before
        // overwriting the snapshot. flush_play_event clears the pending fields
        // on success, so the assignments below always operate on a fresh slot.
        flush_play_event(&mut s, &library.handle, "track_skipped");
        s.current_origin = origin.or_else(|| Some("manual".to_string()));
        s.current_track_id = tid;
        s.started_at = None;
        s.last_position_ms = None;
    }
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::Load(PathBuf::from(&path)))
        .map_err(err)?;
    handle.send(EngineCommand::Play).map_err(err)
}

#[tauri::command]
fn player_set_origin(
    snapshot: State<Snapshot>,
    origin: String,
    track_id: Option<String>,
) -> Result<(), String> {
    let tid = track_id.as_deref().and_then(|s| s.parse::<u64>().ok());
    if let Ok(mut s) = snapshot.0.lock() {
        s.current_origin = Some(origin);
        s.current_track_id = tid;
        if s.started_at.is_none() {
            s.started_at = Some(unix_now());
        }
    }
    Ok(())
}

#[tauri::command]
fn player_pause(player: State<Player>) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle.send(EngineCommand::Pause).map_err(err)
}

#[tauri::command]
fn player_resume(player: State<Player>) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle.send(EngineCommand::Play).map_err(err)
}

#[tauri::command]
fn player_stop(
    player: State<Player>,
    snapshot: State<Snapshot>,
    library: State<Library>,
) -> Result<(), String> {
    if let Ok(mut s) = snapshot.0.lock() {
        flush_play_event(&mut s, &library.handle, "track_skipped");
    }
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle.send(EngineCommand::Stop).map_err(err)
}

#[tauri::command]
fn player_seek(player: State<Player>, seconds: f64) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::Seek(std::time::Duration::from_secs_f64(
            seconds,
        )))
        .map_err(err)
}

#[tauri::command]
fn player_set_volume(player: State<Player>, volume: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle.send(EngineCommand::SetVolume(volume)).map_err(err)
}

// ---------------------------------------------------------------------------
// DSP commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn dsp_set_eq_band(
    player: State<Player>,
    band: u8,
    freq: f32,
    gain_db: f32,
    q: f32,
) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqBand { band, freq, gain_db, q })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_eq_filter_type(
    player: State<Player>,
    band: u8,
    filter_type: i32,
) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqFilterType { band, filter_type })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_eq_filter_mode(
    player: State<Player>,
    band: u8,
    mode: i32,
) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqFilterMode { band, mode })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_eq_slope(
    player: State<Player>,
    band: u8,
    slope: i32,
) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqSlope { band, slope })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_eq_solo(
    player: State<Player>,
    band: u8,
    solo: bool,
) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqSolo { band, solo })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_eq_mute(
    player: State<Player>,
    band: u8,
    mute: bool,
) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqMute { band, mute })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_eq_mode(player: State<Player>, mode: i32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle.send(EngineCommand::DspSetEqMode(mode)).map_err(err)
}

#[tauri::command]
fn dsp_set_eq_gain(player: State<Player>, input: f32, output: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqGain { input, output })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_eq_enabled(player: State<Player>, enabled: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetEqEnabled(enabled))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_enabled(player: State<Player>, enabled: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterEnabled(enabled))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_threshold(player: State<Player>, threshold_db: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterThreshold(threshold_db))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_knee(player: State<Player>, knee: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterKnee(knee))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_lookahead(player: State<Player>, lookahead: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterLookahead(lookahead))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_mode(player: State<Player>, mode: i32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterMode(mode))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_gain(player: State<Player>, input: f32, output: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterGain { input, output })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_boost(player: State<Player>, boost: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterBoost(boost))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_attack(player: State<Player>, attack: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterAttack(attack))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_release(player: State<Player>, release: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterRelease(release))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_stereo_link(player: State<Player>, link: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterStereoLink(link))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_sc_preamp(player: State<Player>, preamp: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterScPreamp(preamp))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_oversampling(player: State<Player>, ovs: i32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterOversampling(ovs))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_dither(player: State<Player>, dither: i32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterDither(dither))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_alr(player: State<Player>, alr: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterAlr(alr))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_alr_attack(player: State<Player>, attack: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterAlrAttack(attack))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_limiter_alr_release(player: State<Player>, release: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetLimiterAlrRelease(release))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_amount(player: State<Player>, amount: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassAmount(amount))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_drive(player: State<Player>, drive: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassDrive(drive))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_blend(player: State<Player>, blend: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassBlend(blend))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_freq(player: State<Player>, freq: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassFreq(freq))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_floor(player: State<Player>, floor: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassFloor(floor))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_bypass(player: State<Player>, bypass: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassBypass(bypass))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_levels(player: State<Player>, input: f32, output: f32) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassLevels { input, output })
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_floor_active(player: State<Player>, active: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassFloorActive(active))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bass_listen(player: State<Player>, listen: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBassListen(listen))
        .map_err(err)
}

#[tauri::command]
fn dsp_set_bypass(player: State<Player>, bypass: bool) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetBypass(bypass))
        .map_err(err)
}

// ---------------------------------------------------------------------------
// Loudness normalization
// ---------------------------------------------------------------------------

/// Target program loudness in LUFS for the normalization stage.
/// Hardcoded for the MVP — exposing this in UI is V2 work.
const NORM_TARGET_LUFS: f32 = -14.0;

/// User toggle for loudness normalization. Default ON.
struct NormState {
    enabled: AtomicBool,
}

impl Default for NormState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(true),
        }
    }
}

#[tauri::command]
fn norm_set_enabled(
    player: State<Player>,
    norm: State<NormState>,
    enabled: bool,
) -> Result<(), String> {
    norm.enabled.store(enabled, Ordering::Relaxed);
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::DspSetNormEnabled(enabled))
        .map_err(err)
}

#[tauri::command]
fn norm_get_state(norm: State<NormState>) -> bool {
    norm.enabled.load(Ordering::Relaxed)
}

#[tauri::command]
fn player_enqueue_next(player: State<Player>, path: String) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::EnqueueNext(PathBuf::from(path)))
        .map_err(err)
}

#[tauri::command]
fn get_state(snapshot: State<Snapshot>) -> Result<serde_json::Value, String> {
    let snap = snapshot.0.lock().map_err(err)?;
    serde_json::to_value(&*snap).map_err(err)
}

// ---------------------------------------------------------------------------
// System resources — reads /proc directly, zero external dependencies.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SystemResources {
    /// Per-core CPU usage (0.0–1.0). Length = number of logical cores.
    cpu_cores: Vec<f64>,
    /// Overall CPU usage (0.0–1.0), average of all cores.
    cpu_overall: f64,
    /// Total physical RAM in bytes.
    ram_total: u64,
    /// Used RAM in bytes (total - available).
    ram_used: u64,
    /// RAM usage fraction (0.0–1.0).
    ram_percent: f64,
    /// Rustify player process RSS in bytes (0 if not found).
    process_rss: u64,
    /// Rustify player process CPU% since last sample (0.0–1.0).
    process_cpu: f64,
}

/// Previous CPU jiffy snapshot for delta computation.
static CPU_PREV: Mutex<Option<Vec<(u64, u64)>>> = Mutex::new(None);
static PROC_PREV: Mutex<Option<(u64, u64)>> = Mutex::new(None); // (utime+stime, total_jiffies)

fn read_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn fs_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn fs_write_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, &contents).map_err(|e| format!("{path}: {e}"))
}

type CpuSnapshot = (Vec<(u64, u64)>, (u64, u64));

fn parse_cpu_cores() -> Result<CpuSnapshot, String> {
    let stat = read_file("/proc/stat")?;
    let mut cores = Vec::new();
    let mut overall = (0u64, 0u64);
    for line in stat.lines() {
        if line.starts_with("cpu") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 {
                continue;
            }
            let vals: Vec<u64> = parts[1..]
                .iter()
                .filter_map(|s| s.parse().ok())
                .collect();
            let total: u64 = vals.iter().sum();
            // idle is field 4 (index 3)
            let idle = vals.get(3).copied().unwrap_or(0)
                + vals.get(4).copied().unwrap_or(0); // iowait
            let busy = total.saturating_sub(idle);
            if parts[0] == "cpu" {
                overall = (busy, total);
            } else {
                cores.push((busy, total));
            }
        }
    }
    Ok((cores, overall))
}

fn parse_meminfo() -> Result<(u64, u64), String> {
    let info = read_file("/proc/meminfo")?;
    let mut total = 0u64;
    let mut available = 0u64;
    for line in info.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total = rest.split_whitespace().next()
                .and_then(|s| s.parse::<u64>().ok()).unwrap_or(0) * 1024;
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            available = rest.split_whitespace().next()
                .and_then(|s| s.parse::<u64>().ok()).unwrap_or(0) * 1024;
        }
    }
    Ok((total, total.saturating_sub(available)))
}

fn parse_process_stat() -> Result<(u64, u64), String> {
    let pid = std::process::id();
    let stat = read_file(&format!("/proc/{pid}/stat"))?;
    // Fields 14 (utime) and 15 (stime) are 0-indexed after splitting by space.
    let parts: Vec<&str> = stat.split_whitespace().collect();
    let utime: u64 = parts.get(13).and_then(|s| s.parse().ok()).unwrap_or(0);
    let stime: u64 = parts.get(14).and_then(|s| s.parse().ok()).unwrap_or(0);
    // RSS is field 24 (pages)
    let rss_pages: u64 = parts.get(23).and_then(|s| s.parse().ok()).unwrap_or(0);
    let page_size = 4096u64; // almost always 4K on Linux
    Ok((utime + stime, rss_pages * page_size))
}

#[tauri::command]
fn get_system_resources() -> Result<SystemResources, String> {
    let (cores_now, overall_now) = parse_cpu_cores()?;
    let (ram_total, ram_used) = parse_meminfo()?;
    let (proc_ticks, proc_rss) = parse_process_stat()?;

    // CPU deltas
    let mut prev_guard = CPU_PREV.lock().map_err(err)?;
    let cpu_cores: Vec<f64> = if let Some(prev) = prev_guard.as_ref() {
        cores_now
            .iter()
            .zip(prev.iter())
            .map(|((busy, total), (pb, pt))| {
                let dt = total.saturating_sub(*pt);
                if dt == 0 { 0.0 } else { (busy.saturating_sub(*pb)) as f64 / dt as f64 }
            })
            .collect()
    } else {
        vec![0.0; cores_now.len()]
    };
    *prev_guard = Some(cores_now);
    drop(prev_guard);

    let cpu_overall = if cpu_cores.is_empty() {
        0.0
    } else {
        cpu_cores.iter().sum::<f64>() / cpu_cores.len() as f64
    };

    // Process CPU delta
    let mut proc_guard = PROC_PREV.lock().map_err(err)?;
    let process_cpu = if let Some((prev_ticks, prev_total)) = proc_guard.as_ref() {
        let dt = overall_now.1.saturating_sub(*prev_total);
        if dt == 0 { 0.0 } else {
            let dp = proc_ticks.saturating_sub(*prev_ticks);
            dp as f64 / dt as f64
        }
    } else {
        0.0
    };
    *proc_guard = Some((proc_ticks, overall_now.1));
    drop(proc_guard);

    let ram_percent = if ram_total == 0 { 0.0 } else { ram_used as f64 / ram_total as f64 };

    Ok(SystemResources {
        cpu_cores,
        cpu_overall,
        ram_total,
        ram_used,
        ram_percent,
        process_rss: proc_rss,
        process_cpu,
    })
}

// ---------------------------------------------------------------------------
// Self-update commands (delegate to /usr/bin/rustify-update, shipped in the
// .deb). Keeps signing-key / polkit concerns out of the Tauri process itself.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct UpdateStatus {
    current_version: String,
    latest_version: String,
    update_available: bool,
    published_at: Option<String>,
    download_url: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UpdateCheckResult {
    Ok(UpdateStatus),
    Error { code: String, message: String },
}

fn run_updater(args: &[&str]) -> Result<std::process::Output, String> {
    // Prefer the installed binary path; fall back to PATH for dev runs.
    let exe = if std::path::Path::new("/usr/bin/rustify-update").exists() {
        "/usr/bin/rustify-update"
    } else {
        "rustify-update"
    };
    std::process::Command::new(exe)
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn rustify-update: {e}"))
}

#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("fc-list")
        .args([":", "family"])
        .output()
        .map_err(|e| format!("fc-list failed: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut families: Vec<String> = text
        .lines()
        .flat_map(|line| line.split(','))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    families.sort_unstable();
    families.dedup();
    Ok(families)
}

#[tauri::command]
fn check_for_update() -> Result<UpdateCheckResult, String> {
    let output = run_updater(&["--check-json"])?;
    if !output.status.success() {
        return Err(format!(
            "rustify-update exited with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("invalid JSON from rustify-update: {e}"))?;

    if let Some(code) = json.get("error").and_then(|v| v.as_str()) {
        let message = json
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok(UpdateCheckResult::Error {
            code: code.to_string(),
            message,
        });
    }

    let status = UpdateStatus {
        current_version: json
            .get("current_version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        latest_version: json
            .get("latest_version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        update_available: json
            .get("update_available")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        published_at: json
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(String::from),
        download_url: json
            .get("download_url")
            .and_then(|v| v.as_str())
            .map(String::from),
    };
    Ok(UpdateCheckResult::Ok(status))
}

#[tauri::command]
async fn install_update() -> Result<(), String> {
    // Use spawn_blocking so the Tauri async runtime isn't blocked by pkexec
    // waiting on user input in the desktop-environment password prompt.
    tauri::async_runtime::spawn_blocking(|| {
        let output = run_updater(&["--install"])?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "rustify-update install failed ({}): {}",
                output.status, stderr
            ));
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

// ---------------------------------------------------------------------------
// Local media HTTP server (range-request capable)
// ---------------------------------------------------------------------------

/// Spawns a blocking HTTP server on 127.0.0.1:0 that serves files from
/// `media_dir`. Supports `Range` requests so `<video>` elements work on
/// WebKitGTK. Returns the bound port.
///
/// Security: only files directly inside `media_dir` are served. Any path
/// that would escape the directory (e.g. `../`) is rejected with 403.
fn start_media_server(media_dir: std::path::PathBuf) -> std::io::Result<u16> {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:19876")?;
    let port = listener.local_addr()?.port();
    tracing::info!(port, "media HTTP server listening");

    std::thread::Builder::new()
        .name("media-server".to_string())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let dir = media_dir.clone();
                std::thread::Builder::new()
                    .name("media-conn".to_string())
                    .spawn(move || {
                        if let Err(e) = handle_media_request(&mut stream, &dir) {
                            tracing::debug!(?e, "media-server connection error");
                        }
                    })
                    .ok();
            }
        })?;

    Ok(port)
}

fn handle_media_request(
    stream: &mut std::net::TcpStream,
    media_dir: &std::path::Path,
) -> std::io::Result<()> {
    use std::io::{Read as IoRead, Write};

    // Read request headers (stop at blank line).
    let mut buf = [0u8; 8192];
    let mut total = 0usize;
    loop {
        let n = stream.read(&mut buf[total..])?;
        if n == 0 {
            break;
        }
        total += n;
        if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if total >= buf.len() {
            break;
        }
    }

    let request = std::str::from_utf8(&buf[..total]).unwrap_or("");
    let first_line = request.lines().next().unwrap_or("");

    // Only GET is needed for media playback.
    if !first_line.starts_with("GET ") {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return Ok(());
    }

    // Extract path from "GET /filename HTTP/1.1"
    let path_raw = first_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/");

    // URL-decode percent-encoded sequences (basic, handles %20 etc.)
    let path_decoded = percent_decode(path_raw);

    // Strip leading slash, reject anything with ".."
    let rel = path_decoded.trim_start_matches('/');
    if rel.contains("..") || rel.contains('\0') {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n");
        return Ok(());
    }

    let file_path = media_dir.join(rel);

    // Confirm the resolved path is still inside media_dir.
    let canonical = match file_path.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n");
            return Ok(());
        }
    };
    let canonical_dir = match media_dir.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let _ = stream.write_all(b"HTTP/1.1 500 Internal Server Error\r\n\r\n");
            return Ok(());
        }
    };
    if !canonical.starts_with(&canonical_dir) {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n");
        return Ok(());
    }

    let mut file = match std::fs::File::open(&canonical) {
        Ok(f) => f,
        Err(_) => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n");
            return Ok(());
        }
    };

    let file_size = file.metadata()?.len();

    // Parse Range header if present.
    let range_header = request
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .map(|v| v.trim().to_string());

    let (start, end, is_range) = if let Some(ref range) = range_header {
        // Expected format: "bytes=START-END" or "bytes=START-"
        if let Some(bytes) = range.strip_prefix("bytes=") {
            let parts: Vec<&str> = bytes.splitn(2, '-').collect();
            let s: u64 = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
            let e: u64 = parts
                .get(1)
                .and_then(|v| if v.is_empty() { None } else { v.parse().ok() })
                .unwrap_or(file_size.saturating_sub(1));
            (s, e.min(file_size.saturating_sub(1)), true)
        } else {
            (0, file_size.saturating_sub(1), false)
        }
    } else {
        (0, file_size.saturating_sub(1), false)
    };

    let content_length = end.saturating_sub(start) + 1;

    let mime = mime_for_path(&canonical);

    let header = if is_range {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {mime}\r\nContent-Length: {content_length}\r\nContent-Range: bytes {start}-{end}/{file_size}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {content_length}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
        )
    };

    stream.write_all(header.as_bytes())?;

    // Seek to the requested offset.
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(start))?;

    // Stream in 64 KiB chunks.
    let mut remaining = content_length;
    let mut chunk = vec![0u8; 65536];
    while remaining > 0 {
        let to_read = (remaining as usize).min(chunk.len());
        let n = file.read(&mut chunk[..to_read])?;
        if n == 0 {
            break;
        }
        stream.write_all(&chunk[..n])?;
        remaining -= n as u64;
    }

    Ok(())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/aac",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn get_media_port(port: State<MediaServerPort>) -> u16 {
    port.0
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let spectrum_active = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("audio_engine", log::LevelFilter::Debug)
                .level_for("rustify_player", log::LevelFilter::Debug)
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }))
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("0.0.0.0")
                .build(),
        )
        .setup(move |_app| {
            if let Some(w) = _app.webview_windows().values().next() {
                w.open_devtools();
            }

            let home = dirs_home();
            let data_dir = home.join(".local/share/rustify-player");
            let cache_dir = home.join(".cache/rustify-player");
            std::fs::create_dir_all(&data_dir).ok();
            std::fs::create_dir_all(&cache_dir).ok();

            // Media directory: served over localhost HTTP so WebKitGTK can
            // play <video> elements (asset:// protocol doesn't support ranges).
            let media_dir = data_dir.join("media");
            std::fs::create_dir_all(&media_dir).ok();
            let media_port = match start_media_server(media_dir) {
                Ok(p) => {
                    tracing::info!(port = p, "media HTTP server started");
                    p
                }
                Err(e) => {
                    tracing::error!(?e, "failed to start media HTTP server");
                    0
                }
            };
            _app.manage(MediaServerPort(media_port));

            let qdrant_url = std::env::var("RUSTIFY_QDRANT_URL")
                .unwrap_or_else(|_| "http://localhost:6333".to_string());
            let music_root = dirs_home().join("Music");

            let embed_url = std::env::var("RUSTIFY_EMBED_URL").ok().or_else(|| {
                Some("https://extractlab.cormorant-alpha.ts.net:8448".to_string())
            });

            let config = IndexerConfig {
                qdrant_url: qdrant_url.clone(),
                music_root: music_root.clone(),
                cache_dir: cache_dir.clone(),
                embed_client: embed_url.as_deref().map(EmbedClient::new),
            };

            // Spawn Qdrant sidecar BEFORE the health probe — otherwise the
            // probe races against a process that hasn't started yet.
            let qdrant_proc = qdrant_process::QdrantProcess::spawn(&data_dir);
            _app.manage(QdrantSidecar(Mutex::new(qdrant_proc)));

            // Wait for Qdrant to become reachable (cold start + bind takes a
            // few hundred ms; on slow disks up to several seconds).
            {
                let probe = library_indexer::QdrantClient::new(&qdrant_url);
                let started = std::time::Instant::now();
                let timeout = std::time::Duration::from_secs(30);
                while !probe.is_healthy() {
                    if started.elapsed() > timeout {
                        panic!(
                            "Qdrant sidecar at {qdrant_url} did not become healthy within 30s"
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, "Qdrant healthy");
            }

            let indexer = Indexer::open(config).expect("failed to open library indexer");
            let indexer_for_events = indexer.clone();
            let cache_dir_for_events = cache_dir.clone();
            _app.manage(Library {
                handle: indexer,
                cache_dir,
                music_root,
            });

            let engine = Engine::start().expect("failed to start audio engine");

            let snapshot = Arc::new(Mutex::new(PlayerSnapshot {
                volume: 1.0,
                ..Default::default()
            }));

            // --- MPRIS2 media controls via souvlaki ---
            // Media key events (play/pause/next from keyboard or DE controls)
            // are translated into engine commands via a crossbeam channel.
            let engine_tx_media = engine.command_sender();
            let (media_cmd_tx, media_cmd_rx) =
                crossbeam_channel::unbounded::<souvlaki::MediaControlEvent>();

            // Spawn a dedicated thread for souvlaki. On Linux (zbus backend),
            // MediaControls must be created and used from the same thread.
            let media_controls: Arc<Mutex<Option<souvlaki::MediaControls>>> =
                Arc::new(Mutex::new(None));
            let mc_writer = media_controls.clone();

            std::thread::Builder::new()
                .name("media-controls".to_string())
                .spawn(move || {
                    let config = souvlaki::PlatformConfig {
                        dbus_name: "rustify_player",
                        display_name: "Rustify Player",
                        hwnd: None,
                    };
                    match souvlaki::MediaControls::new(config) {
                        Ok(mut mc) => {
                            let tx = media_cmd_tx.clone();
                            if let Err(e) = mc.attach(move |ev| {
                                let _ = tx.send(ev);
                            }) {
                                tracing::warn!(?e, "failed to attach media controls callback");
                            }
                            tracing::info!("MPRIS2 media controls registered");
                            if let Ok(mut slot) = mc_writer.lock() {
                                *slot = Some(mc);
                            }
                            // Keep thread alive so the dbus connection stays open.
                            // The media_cmd_rx being consumed in the engine listener
                            // thread handles shutdown implicitly.
                            loop {
                                std::thread::park();
                            }
                        }
                        Err(e) => {
                            tracing::warn!(?e, "failed to create media controls; media keys disabled");
                        }
                    }
                })
                .ok();

            // Qdrant sidecar already spawned + health-checked above (before
            // Indexer::open). Collections were ensured by Indexer::open.

            let spectrum_cfg = Arc::new(Mutex::new(SpectrumConfig::default()));
            _app.manage(SharedSpectrumConfig(spectrum_cfg.clone()));

            let spectrum_buf = engine.spectrum_buffer();
            let spectrum_handle = _app.handle().clone();
            let spectrum_flag = spectrum_active.clone();
            _app.manage(SpectrumActive(spectrum_active));

            std::thread::Builder::new()
                .name("spectrum-emitter".to_string())
                .spawn(move || {
                    let mut last_gen: u64 = 0;
                    let mut tick_count: u64 = 0;

                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(16));
                        tick_count += 1;

                        if !spectrum_flag.load(Ordering::Relaxed) {
                            if tick_count % 300 == 0 {
                                tracing::debug!("spectrum-emitter: subscribe inactive");
                            }
                            continue;
                        }

                        let fft = if let Ok(buf) = spectrum_buf.lock() {
                            if buf.1.is_empty() {
                                if tick_count % 300 == 0 {
                                    tracing::info!("spectrum-emitter: buffer empty (PW capture not producing)");
                                }
                                continue;
                            }
                            // PW capture writes (0, data) — detect change via content hash
                            let gen = buf.1.len() as u64
                                ^ (buf.1[0] as u64) << 8
                                ^ (*buf.1.last().unwrap_or(&0) as u64) << 16;
                            if gen == last_gen {
                                continue;
                            }
                            last_gen = gen;
                            buf.1.clone()
                        } else {
                            continue;
                        };

                        if tick_count % 300 == 0 {
                            tracing::info!("spectrum-emitter: emitting frame len={}", fft.len());
                        }
                        let payload = FftPayload {
                            stream_time_ms: 0,
                            magnitudes: fft,
                        };
                        let _ = spectrum_handle.emit("audio-fft", &payload);
                    }
                })
                .ok();

            // Loudness backfill channel — declared before the event-listener
            // spawns so the listener can hand off track ids to the worker.
            let (lufs_backfill_tx, lufs_backfill_rx) =
                crossbeam_channel::unbounded::<u64>();

            let rx = engine.subscribe();
            let app_handle = _app.handle().clone();
            let snap_writer = snapshot.clone();
            let mc_reader = media_controls.clone();
            let event_lufs_tx = lufs_backfill_tx.clone();
            let event_engine_tx = engine_tx_media.clone();
            let event_indexer = indexer_for_events.clone();
            let event_cache_dir = cache_dir_for_events.clone();
            std::thread::Builder::new()
                .name("event-listener".to_string())
                .spawn(move || {
                    tracing::info!("event-listener thread started");
                    loop {
                        let result = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                event_loop(
                                    &rx,
                                    &app_handle,
                                    &snap_writer,
                                    &mc_reader,
                                    &event_indexer,
                                    &event_cache_dir,
                                    &media_cmd_rx,
                                    &event_engine_tx,
                                    &event_lufs_tx,
                                )
                            }),
                        );
                        match result {
                            Ok(()) => {
                                // recv returned Err = channel closed.
                                tracing::warn!("event-listener: channel closed, exiting");
                                break;
                            }
                            Err(panic) => {
                                let msg = panic
                                    .downcast_ref::<String>()
                                    .map(|s| s.as_str())
                                    .or_else(|| panic.downcast_ref::<&str>().copied())
                                    .unwrap_or("unknown");
                                tracing::error!(
                                    "event-listener panicked: {msg} — restarting loop"
                                );
                                // Small pause to avoid hot-looping on repeated panics.
                                std::thread::sleep(std::time::Duration::from_millis(50));
                            }
                        }
                    }
                })
                .ok();

            _app.manage(Snapshot(snapshot));
            _app.manage(Player(Mutex::new(Some(engine))));
            _app.manage(NormState::default());

            // Background sync removed — pipeline writes directly to Qdrant.

            // ---------------------------------------------------------------
            // Loudness backfill worker
            //
            // Tracks indexed before the normalization feature landed have no
            // `lufs_integrated` payload field. When the user plays one we
            // queue its track id here; this worker decodes the file with
            // ebur128, persists the value in Qdrant, and emits an event
            // so the next playback starts normalized.
            //
            // Single dedicated thread to keep CPU bounded — feeding many
            // analyses in parallel would compete with playback decoding.
            // ---------------------------------------------------------------
            let lufs_indexer = indexer_for_events.clone();
            let lufs_engine_tx = engine_tx_media.clone();
            let lufs_app_handle = _app.handle().clone();
            // The original `lufs_backfill_tx` is dropped at end of setup; the
            // event-listener thread keeps its own clone, so the worker stays
            // alive until that thread shuts down.
            std::thread::Builder::new()
                .name("loudness-backfill".to_string())
                .spawn(move || {
                    use library_indexer::loudness::analyze_file;
                    while let Ok(track_id) = lufs_backfill_rx.recv() {
                        let track = match lufs_indexer.track(track_id) {
                            Ok(Some(t)) => t,
                            Ok(None) => continue,
                            Err(e) => {
                                tracing::warn!(
                                    track_id, ?e,
                                    "loudness-backfill: failed to load track"
                                );
                                continue;
                            }
                        };
                        // If another invocation populated the field meanwhile,
                        // skip work.
                        if track.lufs_integrated.is_some() {
                            continue;
                        }
                        let path = track.path.clone();
                        let analysis = match analyze_file(&path) {
                            Ok(a) => a,
                            Err(e) => {
                                tracing::warn!(
                                    track_id, path = %path.display(), %e,
                                    "loudness-backfill: analysis failed"
                                );
                                continue;
                            }
                        };
                        if let Err(e) =
                            lufs_indexer.set_track_lufs(track_id, analysis.integrated_lufs)
                        {
                            tracing::warn!(
                                track_id, ?e,
                                "loudness-backfill: persisting LUFS failed"
                            );
                            continue;
                        }
                        tracing::info!(
                            track_id,
                            lufs = analysis.integrated_lufs,
                            "loudness-backfill: track analyzed"
                        );
                        // Notify the frontend so any cached track lists can
                        // refresh if they care.
                        let _ = lufs_app_handle.emit(
                            "loudness-backfilled",
                            serde_json::json!({
                                "track_id": track_id.to_string(),
                                "lufs_integrated": analysis.integrated_lufs,
                            }),
                        );
                        // The track is currently playing under unity gain;
                        // applying mid-track would jump the volume. We
                        // intentionally do NOT push gain to the engine here
                        // — it will take effect on the next playback.
                        let _ = &lufs_engine_tx; // keep handle alive
                    }
                })
                .ok();

            #[allow(clippy::too_many_arguments)]
            fn event_loop(
                rx: &crossbeam_channel::Receiver<StateUpdate>,
                app_handle: &tauri::AppHandle,
                snap_writer: &Arc<Mutex<PlayerSnapshot>>,
                mc_reader: &Arc<Mutex<Option<souvlaki::MediaControls>>>,
                indexer: &library_indexer::IndexerHandle,
                cache_dir: &std::path::Path,
                media_cmd_rx: &crossbeam_channel::Receiver<souvlaki::MediaControlEvent>,
                engine_tx: &crossbeam_channel::Sender<EngineCommand>,
                lufs_backfill_tx: &crossbeam_channel::Sender<u64>,
            ) {
                while let Ok(event) = rx.recv() {
                    if let Ok(mut s) = snap_writer.lock() {
                        match &event {
                            StateUpdate::TrackStarted(info) => {
                                s.current_track = Some(info.clone());
                                let lib_track =
                                    match indexer.get_track_by_path(&info.path) {
                                        Ok(Some(mut t)) => {
                                            if let Some(rel) = &t.album_cover_path {
                                                t.album_cover_path =
                                                    Some(cache_dir.join(rel));
                                            }
                                            Some(t)
                                        }
                                        Ok(None) => None,
                                        Err(e) => {
                                            tracing::warn!(
                                                ?e,
                                                path = %info.path.display(),
                                                "failed to resolve library track"
                                            );
                                            None
                                        }
                                    };

                                // Loudness normalization: compute the gain
                                // offset for this track and push it to the
                                // engine. Tracks without a LUFS measurement
                                // play at unity and are queued for backfill.
                                let (gain_db, needs_backfill) = match &lib_track {
                                    Some(t) => match t.lufs_integrated {
                                        Some(lufs) => (
                                            audio_engine::loudness::lufs_to_gain_db(
                                                lufs,
                                                NORM_TARGET_LUFS,
                                            ),
                                            None,
                                        ),
                                        None => (0.0_f32, Some(t.id)),
                                    },
                                    None => (0.0_f32, None),
                                };
                                let _ = engine_tx
                                    .send(EngineCommand::DspSetNormGainDb(gain_db));
                                if let Some(id) = needs_backfill {
                                    if let Err(e) = lufs_backfill_tx.try_send(id) {
                                        tracing::debug!(
                                            track_id = id, ?e,
                                            "loudness-backfill: queue full or closed"
                                        );
                                    }
                                }

                                s.current_library_track = lib_track;
                                s.started_at = Some(unix_now());
                                if let Ok(mut mc) = mc_reader.lock() {
                                    if let Some(mc) = mc.as_mut() {
                                        let title = info
                                            .path
                                            .file_stem()
                                            .and_then(|os| os.to_str())
                                            .unwrap_or("Unknown");
                                        let _ = mc.set_metadata(souvlaki::MediaMetadata {
                                            title: Some(title),
                                            duration: info.duration,
                                            ..Default::default()
                                        });
                                    }
                                }
                            }
                            StateUpdate::StateChanged(ps) => {
                                s.is_playing =
                                    matches!(ps, PlaybackState::Playing { .. });
                                if matches!(
                                    ps,
                                    PlaybackState::Idle | PlaybackState::Stopped
                                ) {
                                    s.current_track = None;
                                    s.current_library_track = None;
                                }
                                if let Ok(mut mc) = mc_reader.lock() {
                                    if let Some(mc) = mc.as_mut() {
                                        let pb = match ps {
                                            PlaybackState::Playing { .. } => {
                                                souvlaki::MediaPlayback::Playing {
                                                    progress: None,
                                                }
                                            }
                                            PlaybackState::Paused { .. } => {
                                                souvlaki::MediaPlayback::Paused {
                                                    progress: None,
                                                }
                                            }
                                            _ => souvlaki::MediaPlayback::Stopped,
                                        };
                                        let _ = mc.set_playback(pb);
                                    }
                                }
                            }
                            StateUpdate::VolumeChanged(v) => {
                                s.volume = *v;
                            }
                            StateUpdate::Position(pos) => {
                                let ms = (pos.samples_played as f64
                                    / pos.sample_rate as f64
                                    * 1000.0) as i64;
                                s.last_position_ms = Some(ms);
                            }
                            StateUpdate::TrackEnded(_) => {
                                flush_play_event(&mut s, &indexer, "track_ended");
                            }
                            StateUpdate::SpectrumData(_) => {}
                            _ => {}
                        }
                    }
                    if !matches!(&event, StateUpdate::SpectrumData(_)) {
                        let _ = app_handle.emit("player-state", &event);
                    }

                    while let Ok(mev) = media_cmd_rx.try_recv() {
                        let cmd = match mev {
                            souvlaki::MediaControlEvent::Play => {
                                Some(EngineCommand::Play)
                            }
                            souvlaki::MediaControlEvent::Pause => {
                                Some(EngineCommand::Pause)
                            }
                            souvlaki::MediaControlEvent::Toggle => {
                                let playing = snap_writer
                                    .lock()
                                    .map(|s| s.is_playing)
                                    .unwrap_or(false);
                                if playing {
                                    Some(EngineCommand::Pause)
                                } else {
                                    Some(EngineCommand::Play)
                                }
                            }
                            souvlaki::MediaControlEvent::Stop => {
                                Some(EngineCommand::Stop)
                            }
                            souvlaki::MediaControlEvent::Next => {
                                let _ = app_handle.emit("mpris-command", "next");
                                None
                            }
                            souvlaki::MediaControlEvent::Previous => {
                                let _ =
                                    app_handle.emit("mpris-command", "previous");
                                None
                            }
                            _ => None,
                        };
                        if let Some(cmd) = cmd {
                            let _ = engine_tx.send(cmd);
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lib_list_genres,
            lib_list_tracks,
            lib_list_albums,
            lib_list_artists,
            lib_search,
            lib_semantic_search,
            lib_mood_search,
            lib_get_track,
            lib_find_similar,
            lib_shuffle,
            lib_autoplay_next,
            lib_snapshot,
            lib_rescan,
            lib_get_lyrics,
            lib_list_folders,
            lib_list_folder_tracks,
            lib_search_playlists,
            lib_record_play,
            lib_list_history,
            lib_toggle_like,
            lib_list_liked,
            lib_is_liked,
            lib_recommendations,
            list_backgrounds,
            list_shapes,
            get_spectrum_config,
            set_spectrum_config,
            spectrum_subscribe,
            spectrum_unsubscribe,
            list_themes,
            load_theme,
            list_spectrum_presets,
            load_spectrum_preset,
            save_spectrum_preset,
            watch_spectrum_preset,
            get_track_color,
            log_event,
            fs_read_text,
            fs_write_text,
            player_play,
            player_set_origin,
            player_pause,
            player_resume,
            player_stop,
            player_seek,
            player_set_volume,
            player_enqueue_next,
            dsp_set_eq_band,
            dsp_set_eq_filter_type,
            dsp_set_eq_filter_mode,
            dsp_set_eq_slope,
            dsp_set_eq_solo,
            dsp_set_eq_mute,
            dsp_set_eq_mode,
            dsp_set_eq_enabled,
            dsp_set_eq_gain,
            dsp_set_limiter_enabled,
            dsp_set_limiter_threshold,
            dsp_set_limiter_knee,
            dsp_set_limiter_lookahead,
            dsp_set_limiter_mode,
            dsp_set_limiter_gain,
            dsp_set_limiter_boost,
            dsp_set_limiter_attack,
            dsp_set_limiter_release,
            dsp_set_limiter_stereo_link,
            dsp_set_limiter_sc_preamp,
            dsp_set_limiter_oversampling,
            dsp_set_limiter_dither,
            dsp_set_limiter_alr,
            dsp_set_limiter_alr_attack,
            dsp_set_limiter_alr_release,
            dsp_set_bass_amount,
            dsp_set_bass_drive,
            dsp_set_bass_blend,
            dsp_set_bass_freq,
            dsp_set_bass_floor,
            dsp_set_bass_bypass,
            dsp_set_bass_levels,
            dsp_set_bass_floor_active,
            dsp_set_bass_listen,
            dsp_set_bypass,
            norm_set_enabled,
            norm_get_state,
            get_state,
            get_system_resources,
            check_for_update,
            install_update,
            restart_app,
            list_system_fonts,
            get_media_port,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home"))
}
