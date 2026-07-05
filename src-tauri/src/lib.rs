mod persistence;
mod qdrant_process;

use audio_engine::{
    Command as EngineCommand, Engine, EngineHandle, PlaybackState, StateUpdate, TrackInfo,
};
use library_indexer::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbedClient, Genre, Indexer, IndexerConfig,
    IndexerHandle, LyricLine, PlaylistSearchResult, SearchResults,
    Track, TrackFilter, TrackOrder,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

// ---------------------------------------------------------------------------
// State wrappers
// ---------------------------------------------------------------------------

struct Library {
    handle: IndexerHandle,
    cache_dir: PathBuf,
    music_root: PathBuf,
    data_dir: PathBuf,
}
struct Player(Mutex<Option<EngineHandle>>);
// Qdrant state removed — IndexerHandle now owns the QdrantClient.
/// Keeps the Qdrant child process alive for the duration of the app.
/// Drop impl kills the process on app exit.
#[allow(dead_code)]
struct QdrantSidecar(Mutex<Option<qdrant_process::QdrantProcess>>);

/// Payload emitted to frontend via "audio-fft" event.
/// `stream_time_ms` is the track position (ms) this FFT frame belongs to.
///
/// Os campos `*_band_mag` / `rms_energy` carregam envelope beat-sync
/// computados no Rust (one-pole IIR no `fft_worker_loop`) e são consumidos
/// pelo SpectrumCanvas. Range 0..1, sempre. A reatividade do bg pondera
/// as três bandas via Tweaks (bgBassGain / bgMidGain / bgTrebleGain).
///
/// Snake-case é preservado para retro-compatibilidade com o frontend atual
/// que já consome `stream_time_ms` (sem `rename_all` no struct).
#[derive(Clone, Serialize)]
struct FftPayload {
    stream_time_ms: u64,
    magnitudes: Vec<u8>,
    low_band_mag: f32,
    mid_band_mag: f32,
    high_band_mag: f32,
    rms_energy: f32,
    /// Sample rate negociada pelo PipeWire (Hz). 0 enquanto nao
    /// negociado. Frontend usa pra calcular bin->banda do RTA
    /// 1/3 oitava ISO no overlay do EqCanvas.
    sample_rate: u32,
}

/// Refcount de assinantes do spectrum-emitter. Cada consumidor de `audio-fft`
/// (SpectrumCanvas do shell, overlay do EqCanvas, Visualizer) chama
/// `spectrum_subscribe` ao montar e `spectrum_unsubscribe` ao desmontar; o
/// emitter roda enquanto o contador for > 0. Antes era um `AtomicBool` global
/// (ultimo a chamar vencia), o que fazia o unsubscribe de um consumidor
/// desligar o feed dos demais.
struct SpectrumActive(Arc<AtomicUsize>);

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
    let embedder = library_indexer::LyricsEmbedClient::new("http://100.123.73.128:3939");
    let vector = embedder.embed_text(&query).map_err(err)?;
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
        // SEED_WEIGHT used to be 20, which pushed the seed to ~40% of the
        // recommendation centroid and pinned results to the seed's acoustic
        // neighborhood (recommending tracks that shared the seed's beat
        // regardless of user taste). 4 keeps the seed anchored to the current
        // vibe (~12% of centroid) while letting behavioral history actually
        // shape recommendations.
        const SEED_WEIGHT: usize = 4;
        // Over-fetch so we can randomize the final picks across the top
        // candidates instead of always returning the same `lim` items. This
        // combats the "same 5 tracks keep being recommended" symptom.
        const RECOMMEND_FETCH: usize = 15;
        match lib.handle.behavioral_signals() {
            Ok((history, negatives)) => {
                let mut positives: Vec<u64> =
                    std::iter::repeat(track_id).take(SEED_WEIGHT).collect();
                positives.extend(history.into_iter().filter(|id| *id != track_id));
                let fetch = lim.max(RECOMMEND_FETCH);
                match client.recommend(&positives, &negatives, &exclude_ids, fetch) {
                    Ok(recs) if !recs.is_empty() => {
                        // Long-tail boost: Fisher-Yates shuffle the top-N
                        // candidates then take `lim`. The Recommendations API
                        // already ranked them by similarity to the (seed +
                        // taste) centroid, so any of the top-N is a "good
                        // enough" match — varying which N we return prevents
                        // the same head of the distribution from being served
                        // every call. xorshift PRNG inline to avoid pulling
                        // the rand crate just for one shuffle.
                        let mut shuffled = recs;
                        let seed = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_nanos() as u64)
                            .unwrap_or(0x9E3779B97F4A7C15)
                            .wrapping_add(track_id);
                        let mut state = seed | 1;
                        for i in (1..shuffled.len()).rev() {
                            state ^= state << 13;
                            state ^= state >> 7;
                            state ^= state << 17;
                            let j = (state as usize) % (i + 1);
                            shuffled.swap(i, j);
                        }
                        shuffled.truncate(lim);

                        let mut tracks = Vec::new();
                        for (rec_id, _score) in &shuffled {
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
    let mut folders = lib.handle.list_folders(&root).map_err(err)?;
    // cover_path / cover_paths sao relativos ao cache_dir — converter pra absolute
    // pra `convertFileSrc` no frontend conseguir resolver.
    for folder in &mut folders {
        if let Some(rel) = &folder.cover_path {
            folder.cover_path = Some(lib.cache_dir.join(rel));
        }
        for cover in &mut folder.cover_paths {
            *cover = lib.cache_dir.join(&*cover);
        }
    }
    Ok(folders)
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
fn spectrum_subscribe(active: State<SpectrumActive>) {
    // Refcount: +1 assinante. Ver `SpectrumActive`.
    active.0.fetch_add(1, Ordering::Relaxed);
}

#[tauri::command]
fn spectrum_unsubscribe(active: State<SpectrumActive>) {
    // Refcount: -1 assinante, saturado em 0 (unsubscribe desbalanceado nunca
    // faz o contador dar underflow para usize::MAX e manter o emitter preso).
    let _ = active
        .0
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            Some(n.saturating_sub(1))
        });
}


fn themes_dir() -> PathBuf {
    dirs_home().join(".local/share/rustify-player/themes")
}

/// Converte uma key YAML (e.g. "fg-1", "surfaces-lowest") na CSS custom
/// property correspondente. Retorna None se a key nao for reconhecida.
///
/// Estrategia em duas camadas:
///   1. Aliases legados (Editorial Hi-Fi Dark) — mantemos por retrocompat
///      com YAMLs criados antes do Extractor Lab redesign.
///   2. Tokens Extractor Lab (atuais) — pass-through direto. Aceita qualquer
///      key que case com um prefixo conhecido do design system ativo:
///      fg-*, bg-*, line-*, tone-*, blue-*, green-*, amber-*, rose-*,
///      purple-*, radius-*, shadow-*, dur-*, ease-*, font-*, ring-focus,
///      sidebar-w, playerbar-h, titlebar-h.
fn yaml_key_to_css_prop(key: &str) -> Option<String> {
    // Camada 1 — aliases legados.
    let legacy = match key {
        "surfaces-lowest" => Some("--surface-lowest"),
        "surfaces-base" => Some("--surface"),
        "surfaces-container-low" => Some("--surface-container-low"),
        "surfaces-container" => Some("--surface-container"),
        "surfaces-container-high" => Some("--surface-container-high"),
        "surfaces-container-highest" => Some("--surface-container-highest"),
        "dividers-subtle" => Some("--divider"),
        "dividers-prominent" => Some("--divider-hi"),
        "accent-primary" => Some("--primary"),
        "accent-primary-container" => Some("--primary-container"),
        "accent-primary-fixed-dim" => Some("--primary-fixed-dim"),
        "accent-on-primary" => Some("--on-primary"),
        "accent-on-primary-container" => Some("--on-primary-container"),
        "text-primary" => Some("--on-surface"),
        "text-secondary" => Some("--on-surface-variant"),
        "text-muted" => Some("--on-surface-mute"),
        "text-outline" => Some("--outline-variant"),
        "signal-ok" => Some("--sig-ok"),
        "signal-warn" => Some("--sig-warn"),
        "signal-error" => Some("--sig-err"),
        "typography-body" => Some("--font-body"),
        "typography-display" => Some("--font-display"),
        "typography-mono" => Some("--font-mono"),
        "typography-mono-legacy" => Some("--font-mono"),
        "typography-technical" => Some("--font-technical"),
        "effects-glow" => Some("--glow"),
        "effects-halo" => Some("--halo-alpha"),
        "effects-surface-blur" => Some("--surface-blur"),
        "effects-surface-opacity" => Some("--surface-opacity"),
        // ── Themes boost (2026-07): superfícies novas ──
        "glass-tint" => Some("--glass-tint"),
        "glass-alpha" => Some("--glass-alpha"),
        "glass-blur" => Some("--glass-blur"),
        "background-ink" => Some("--bg-ink"),
        "motion-fast" => Some("--dur-fast"),
        "motion-base" => Some("--dur-base"),
        "motion-med" => Some("--dur-med"),
        "motion-ease" => Some("--ease-out"),
        _ => None,
    };
    if let Some(prop) = legacy {
        return Some(prop.to_string());
    }

    // Seções estruturadas plurais mapeiam pros tokens singulares da camada 2:
    // `tones.mint.bg` (achatado "tones-mint-bg") → `--tone-mint-bg`,
    // `shadows.card` → `--shadow-card`. `radius.*` já coincide com o token.
    if let Some(rest) = key.strip_prefix("tones-") {
        return Some(format!("--tone-{rest}"));
    }
    if let Some(rest) = key.strip_prefix("shadows-") {
        return Some(format!("--shadow-{rest}"));
    }

    // Camada 2 — Extractor Lab tokens (atuais).
    // Pass-through: a key vira `--{key}` se casar com um prefixo conhecido.
    const ALLOWED_PREFIXES: &[&str] = &[
        // Foreground / background scales
        "fg-", "bg-", "line-",
        // Tones (album cover pastels)
        "tone-",
        // Semantic colors (ring/bg/fg triplets)
        "blue-", "green-", "amber-", "rose-", "purple-",
        // Layout primitives
        "radius-", "shadow-",
        // Motion
        "dur-", "ease-",
        // Type
        "font-",
    ];
    const ALLOWED_EXACT: &[&str] = &[
        "ring-focus", "sidebar-w", "playerbar-h", "titlebar-h",
    ];

    if ALLOWED_EXACT.contains(&key) || ALLOWED_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Some(format!("--{key}"));
    }
    None
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
            if let Some(prop) = yaml_key_to_css_prop(prefix) {
                out.insert(prop, s.clone());
            }
        }
        serde_yaml::Value::Number(n) => {
            if let Some(prop) = yaml_key_to_css_prop(prefix) {
                out.insert(prop, n.to_string());
            }
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

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f64::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if (max - r).abs() < f64::EPSILON {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
    } else if (max - g).abs() < f64::EPSILON {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    (h, s, l)
}

fn hsl_to_hex(h: f64, s: f64, l: f64) -> String {
    let hue = |p: f64, q: f64, mut t: f64| {
        if t < 0.0 { t += 1.0; }
        if t > 1.0 { t -= 1.0; }
        if t < 1.0 / 6.0 { return p + (q - p) * 6.0 * t; }
        if t < 1.0 / 2.0 { return q; }
        if t < 2.0 / 3.0 { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
        p
    };
    let (r, g, b) = if s <= f64::EPSILON {
        (l, l, l)
    } else {
        let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
        let p = 2.0 * l - q;
        (hue(p, q, h + 1.0 / 3.0), hue(p, q, h), hue(p, q, h - 1.0 / 3.0))
    };
    let c = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b))
}

/// Garante que o ink de bg tenha presença mínima contra o canvas do tema.
///
/// Todos os temas atuais declaram `background.ink` = canvas (o ink nasce
/// invisível por construção); este passo corrige na SAÍDA do load_theme:
/// preserva o hue e caminha a luminância na direção que afasta do canvas
/// até `min_ratio`. Retorna None quando o ink já contrasta (ou não parseia
/// — vars não-hex passam intocadas).
fn ensure_bg_ink_contrast(ink_hex: &str, canvas_hex: &str, min_ratio: f64) -> Option<String> {
    let (ir, ig, ib) = hex_to_rgb(ink_hex)?;
    let (cr, cg, cb) = hex_to_rgb(canvas_hex)?;
    let canvas_y = relative_luminance(cr, cg, cb);
    if contrast_ratio(relative_luminance(ir, ig, ib), canvas_y) >= min_ratio {
        return None;
    }
    let (h, s, mut l) = rgb_to_hsl(ir, ig, ib);
    let dark_canvas = canvas_y < 0.18; // ~L 0.5 em luminância relativa
    let mut hex = hsl_to_hex(h, s, l);
    for _ in 0..40 {
        let (r, g, b) = hex_to_rgb(&hex)?;
        if contrast_ratio(relative_luminance(r, g, b), canvas_y) >= min_ratio {
            return Some(hex);
        }
        l = if dark_canvas { (l + 0.02).min(0.85) } else { (l - 0.02).max(0.08) };
        hex = hsl_to_hex(h, s, l);
    }
    Some(hex)
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

/// Bridge YAMLs legados (Editorial Hi-Fi Dark) pro design system atual
/// (Extractor Lab). Quando o tema seta uma var legacy, tambem espelhamos
/// pro token equivalente do design atual — assim YAMLs pre-redesign
/// voltam a pintar componentes que so leem tokens novos.
fn bridge_legacy_to_extractor_lab(vars: &mut std::collections::HashMap<String, String>) {
    // (legacy_var, [tokens_atuais]) — so escreve o token atual se ainda nao foi
    // definido pelo proprio YAML. Ordem importa: os itens mais basicos primeiro,
    // para que derivacoes posteriores (ex: fg-2 a partir de fg-1) possam ler
    // o valor ja inserido na mesma passagem.
    //
    // Estrategia de mapeamento para a escala fg-*:
    //   fg-1  = text.primary   (mais escuro / mais contrastante)
    //   fg-2  = text.primary   (sem segundo tom no YAML — reutiliza)
    //   fg-3  = text.secondary (intermediario mais legivel)
    //   fg-4  = text.secondary
    //   fg-5  = text.muted     (intermediario apagado)
    //   fg-6  = text.muted
    //   fg-7  = text.muted     (decorativo apenas)
    //   fg-8  = divider-hi     (quase invisivel — borda)
    const BRIDGE: &[(&str, &[&str])] = &[
        // ── Surfaces ─────────────────────────────────────────────
        ("--surface-lowest",            &["--bg-canvas"]),
        ("--surface",                   &["--bg-paper"]),
        ("--surface-container-low",     &["--bg-sunken"]),
        ("--surface-container",         &["--bg-soft"]),
        ("--surface-container-high",    &["--bg-tint"]),
        ("--surface-container-highest", &["--bg-faint"]),
        // ── Lines / dividers ─────────────────────────────────────
        ("--divider",    &["--line-2", "--line-3"]),
        ("--divider-hi", &["--line-1"]),
        // ── Escala de foreground (fg-1..fg-8) ────────────────────
        ("--on-surface",         &["--fg-1", "--fg-2"]),
        ("--on-surface-variant", &["--fg-3", "--fg-4"]),
        ("--on-surface-mute",    &["--fg-5", "--fg-6", "--fg-7"]),
        ("--divider-hi",         &["--fg-8"]),
        // ── Accent principal → tokens azuis ──────────────────────
        // (os temas YAML usam `accent.primary` como cor de destaque
        // unica; espelhamos para todo o triplet blue-*)
        ("--primary",           &["--blue-fg", "--blue-ring"]),
        ("--surface-container", &["--blue-bg"]),
        // ── Signal colors → triplets semanticos ──────────────────
        // verde (ok)
        ("--sig-ok",            &["--green-fg", "--green-ring"]),
        ("--surface-container-low", &["--green-bg"]),
        // ambar (warn)
        ("--sig-warn",          &["--amber-fg", "--amber-ring"]),
        ("--surface-container-low", &["--amber-bg"]),
        // rosa/vermelho (erro)
        ("--sig-err",           &["--rose-fg", "--rose-ring"]),
        ("--surface-container-low", &["--rose-bg"]),
        // violeta — nao tem equivalente YAML; usa accent + surface dim
        ("--primary",           &["--purple-fg", "--purple-ring"]),
        ("--surface-container-low", &["--purple-bg"]),
    ];
    for (legacy, targets) in BRIDGE {
        if let Some(val) = vars.get(*legacy).cloned() {
            for target in *targets {
                vars.entry(target.to_string()).or_insert_with(|| val.clone());
            }
        }
    }
}

#[tauri::command]
fn load_theme(filename: String) -> Result<ThemeLoadResult, String> {
    let path = themes_dir().join(&filename);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read theme: {e}"))?;
    let val: serde_yaml::Value = serde_yaml::from_str(&content).map_err(|e| format!("Invalid YAML: {e}"))?;
    let mut vars = std::collections::HashMap::new();
    yaml_to_css_vars(&val, "", &mut vars);
    bridge_legacy_to_extractor_lab(&mut vars);

    // Enforcement: nenhum tema entrega ink de bg invisível. O piso 3:1
    // (não-texto WCAG) vale pro fallback do tema; o adaptive ink da capa
    // mira 4:1 por conta própria (deriveInk v3 no frontend).
    if let (Some(ink), Some(canvas)) = (
        vars.get("--bg-ink").cloned(),
        vars.get("--bg-canvas").cloned(),
    ) {
        if let Some(lifted) = ensure_bg_ink_contrast(&ink, &canvas, 3.0) {
            vars.insert("--bg-ink".to_string(), lifted);
        }
    }

    let mut checks = Vec::new();
    // Pares semanticamente relevantes para verificacao WCAG.
    // Somente pares cujos dois tokens existem no mapa sao incluidos.
    // Apos o bridge, todos os pares abaixo devem estar populados para
    // YAMLs que seguem o vocabulario legado (surfaces/text/accent/signal).
    let pairs = [
        // Texto principal
        ("texto/canvas",      "--fg-1",    "--bg-canvas"),
        ("texto/paper",       "--fg-1",    "--bg-paper"),
        ("secundario/canvas", "--fg-3",    "--bg-canvas"),
        ("secundario/paper",  "--fg-3",    "--bg-paper"),
        ("apagado/paper",     "--fg-5",    "--bg-paper"),
        ("apagado/canvas",    "--fg-5",    "--bg-canvas"),
        // Accent azul
        ("accent/canvas",     "--blue-fg", "--bg-canvas"),
        ("accent/paper",      "--blue-fg", "--bg-paper"),
        ("texto/accent-bg",   "--fg-1",    "--blue-bg"),
        // Sinais semanticos (ok / warn / erro)
        ("ok/canvas",         "--green-fg","--bg-canvas"),
        ("warn/canvas",       "--amber-fg","--bg-canvas"),
        ("erro/canvas",       "--rose-fg", "--bg-canvas"),
        // Texto sobre o accent (botões primary). Buraco histórico: Uvinha
        // shipava on-primary 1.46:1 sobre primary sem o checker acusar.
        ("on-primary/primary",    "--on-primary", "--primary"),
        ("on-primary/container",  "--on-primary-container", "--primary-container"),
    ];
    // Tones declarados pelo tema: o texto principal precisa ler sobre cada
    // card pastel. Só checa os que o YAML define — tema sem tones não ganha
    // pares extras (mesma semântica dos pares fixos com token ausente).
    let mut tone_pairs: Vec<(String, &'static str, String)> = vars
        .keys()
        .filter_map(|k| {
            let name = k.strip_prefix("--tone-")?.strip_suffix("-bg")?;
            Some((format!("tone-{name}"), "--fg-1", k.clone()))
        })
        .collect();
    tone_pairs.sort();

    let all_pairs = pairs
        .iter()
        .map(|(l, f, b)| (l.to_string(), *f, b.to_string()))
        .chain(tone_pairs);

    for (label, fg_key, bg_key) in all_pairs {
        if let (Some(fg), Some(bg)) = (vars.get(fg_key), vars.get(bg_key.as_str())) {
            if let (Some(fg_rgb), Some(bg_rgb)) = (hex_to_rgb(fg), hex_to_rgb(bg)) {
                let l1 = relative_luminance(fg_rgb.0, fg_rgb.1, fg_rgb.2);
                let l2 = relative_luminance(bg_rgb.0, bg_rgb.1, bg_rgb.2);
                let ratio = contrast_ratio(l1, l2);
                checks.push(ContrastCheck {
                    pair: label,
                    ratio: (ratio * 100.0).round() / 100.0,
                    pass_aa: ratio >= 4.5,
                    pass_aaa: ratio >= 7.0,
                });
            }
        }
    }

    Ok(ThemeLoadResult { vars, contrast: checks })
}

/// Estado global do watcher de tema ativo. Garante que trocar de tema N vezes
/// nao acumule N threads + inotify watchers imortais: cada `watch_theme`
/// derruba o handle anterior (drop do `notify::Watcher` + join da thread de
/// debounce) antes de instalar o novo. Sem isso, o watcher stale do tema A
/// continuava emitindo `theme-changed("A")` e revertia o app pro tema A quando
/// o YAML de A mudava no disco, mesmo com B ativo.
struct ThemeWatchState(Mutex<Option<ThemeWatchHandle>>);

/// Handle de um watcher de tema ativo. Segurar este valor mantem o watcher e a
/// thread de debounce vivos; `stop()` os derruba de forma ordenada.
struct ThemeWatchHandle {
    /// `Option` para permitir dropar o watcher explicitamente antes do join.
    /// Dropar o watcher para de observar o arquivo E fecha o canal do callback,
    /// desbloqueando o `recv()` da thread de debounce (que entao encerra).
    watcher: Option<notify::RecommendedWatcher>,
    /// Sinaliza a thread a sair sem emitir, mesmo que um evento chegue no meio
    /// do teardown.
    shutdown: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ThemeWatchHandle {
    /// Derruba o watcher e aguarda a thread de debounce encerrar: sinaliza
    /// shutdown, dropa o watcher (fecha o canal) e faz join.
    fn stop(mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        // Dropar o watcher ANTES do join fecha o canal do callback e
        // desbloqueia o `recv()` bloqueante da thread.
        self.watcher = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Loop de debounce da thread de watcher: aguarda eventos de modificacao,
/// agrupa rajadas dentro de `debounce` e chama `on_change` uma vez por rajada.
/// Encerra quando o canal fecha (watcher dropado) ou `shutdown` esta setado.
/// Extraido como funcao livre para ser testavel sem `notify`.
fn theme_debounce_loop(
    rx: std::sync::mpsc::Receiver<()>,
    shutdown: &AtomicBool,
    debounce: std::time::Duration,
    mut on_change: impl FnMut(),
) {
    loop {
        match rx.recv() {
            Ok(()) => {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                // Drena a rajada de eventos dentro da janela de debounce.
                while rx.recv_timeout(debounce).is_ok() {}
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                on_change();
            }
            Err(_) => break, // canal fechado: watcher foi dropado
        }
    }
}

#[tauri::command]
fn watch_theme(
    app: tauri::AppHandle,
    filename: String,
    state: State<ThemeWatchState>,
) -> Result<(), String> {
    let path = themes_dir().join(&filename);
    if !path.exists() {
        return Err(format!("Theme not found: {filename}"));
    }

    // Derruba o watcher anterior (se houver) ANTES de criar o novo. `take` +
    // `stop` fora do lock: nao seguramos o Mutex durante o join da thread.
    let previous = state.0.lock().unwrap().take();
    if let Some(prev) = previous {
        prev.stop();
    }

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher: notify::RecommendedWatcher = notify::Watcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, notify::EventKind::Modify(_)) {
                    let _ = tx.send(());
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("Failed to create theme watcher: {e}"))?;

    notify::Watcher::watch(&mut watcher, &path, notify::RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch theme {}: {e}", path.display()))?;

    tracing::info!("Watching theme: {}", path.display());

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_thread = shutdown.clone();
    let app_handle = app.clone();
    let emit_name = filename.clone();
    let thread = std::thread::Builder::new()
        .name("theme-watcher".into())
        .spawn(move || {
            theme_debounce_loop(
                rx,
                &shutdown_thread,
                std::time::Duration::from_millis(500),
                || {
                    let _ = app_handle.emit("theme-changed", emit_name.clone());
                },
            );
        })
        .map_err(|e| format!("Failed to spawn theme watcher: {e}"))?;

    *state.0.lock().unwrap() = Some(ThemeWatchHandle {
        watcher: Some(watcher),
        shutdown,
        thread: Some(thread),
    });
    Ok(())
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
    // Chave versionada: v1 = média-1x1 (lamacenta), v2 = quantização em
    // buckets (dividia o voto do vermelho no wrap do hue e diluía na média),
    // v3 = eleição de família de hue + núcleo saturado. Valores de versões
    // antigas são ignorados; cada faixa recalcula lazy no primeiro play.
    if let Some(color) = enr["dominant_color_v3"].as_str().filter(|s| !s.is_empty()) {
        return Ok(color.to_string());
    }

    // Fallback: compute from cached cover, persist in enrichments
    let payload = client.get_payload(tid).map_err(err)?;
    if let Some(rel) = payload["cover_path"].as_str() {
        let cover_file = lib.cache_dir.join(rel);
        if cover_file.exists() {
            let source = library_indexer::CoverSource::FolderFile(cover_file);
            if let Some(hex) = library_indexer::dominant_color(&source) {
                client.set_enrichment(tid, serde_json::json!({"dominant_color_v3": hex})).ok();
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

/// Default program loudness in LUFS for the normalization stage. The user
/// can now override this at runtime via the Tweaks panel; this constant is
/// only the initial value seeded into `NormState`.
const NORM_TARGET_LUFS: f32 = -14.0;

/// Sane bounds for the user-selectable normalization target, in LUFS.
/// The UI slider is narrower (-20..-6) but the command clamps defensively
/// in case a caller pushes an out-of-range value.
const NORM_TARGET_MIN: f32 = -30.0;
const NORM_TARGET_MAX: f32 = 0.0;

/// User-controlled state for loudness normalization.
///
/// - `enabled`: master on/off toggle (default ON).
/// - `target_bits`: the target LUFS encoded as `f32::to_bits` inside an
///   `AtomicU32` (the std has no atomic f32). Shared via `Arc` with the
///   event-listener thread so per-track gain is computed against the live
///   target without a lock.
struct NormState {
    enabled: AtomicBool,
    target_bits: Arc<AtomicU32>,
}

impl NormState {
    /// Build with a pre-existing shared target cell. The same `Arc` is
    /// cloned into the event-listener thread so both sides observe the
    /// current target.
    fn with_target(target_bits: Arc<AtomicU32>) -> Self {
        Self {
            enabled: AtomicBool::new(true),
            target_bits,
        }
    }

    fn target_lufs(&self) -> f32 {
        f32::from_bits(self.target_bits.load(Ordering::Relaxed))
    }
}

/// Read the target LUFS out of a shared `Arc<AtomicU32>` cell.
fn norm_target_from_cell(cell: &AtomicU32) -> f32 {
    f32::from_bits(cell.load(Ordering::Relaxed))
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

/// Set the normalization target loudness (LUFS) at runtime.
///
/// Applies immediately to the track playing right now: if the current
/// library track has a measured `lufs_integrated`, the per-track gain is
/// recomputed against the new target and pushed to the engine so the user
/// hears the slider move. This is a deliberate, conscious adjustment — the
/// "never change gain mid-track" rule in the loudness backfill worker is
/// about surprise jumps from background analysis, not this slider.
///
/// If nothing is playing or the current track has no LUFS measurement, the
/// new target is just stored; the next track to start picks it up.
#[tauri::command]
fn norm_set_target(
    player: State<Player>,
    snapshot: State<Snapshot>,
    norm: State<NormState>,
    lufs: f32,
) -> Result<(), String> {
    let target = if lufs.is_finite() {
        lufs.clamp(NORM_TARGET_MIN, NORM_TARGET_MAX)
    } else {
        NORM_TARGET_LUFS
    };
    norm.target_bits.store(target.to_bits(), Ordering::Relaxed);

    // Resolve the LUFS of whatever is playing right now, if any.
    let current_lufs = snapshot
        .0
        .lock()
        .ok()
        .and_then(|s| s.current_library_track.as_ref().and_then(|t| t.lufs_integrated));

    if let Some(lufs_integrated) = current_lufs {
        let gain_db = audio_engine::loudness::lufs_to_gain_db(lufs_integrated, target);
        let guard = player.0.lock().map_err(err)?;
        let handle = guard.as_ref().ok_or("engine not started")?;
        handle
            .send(EngineCommand::DspSetNormGainDb(gain_db))
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn norm_get_target(norm: State<NormState>) -> f32 {
    norm.target_lufs()
}

#[tauri::command]
fn player_enqueue_next(player: State<Player>, path: String) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::EnqueueNext(PathBuf::from(path)))
        .map_err(err)
}

/// Load a track without starting playback. Used by session resume to
/// restore the previous track + position in a paused state so the user
/// chooses when to continue, instead of auto-playing on launch.
#[tauri::command]
fn player_load_paused(
    player: State<Player>,
    snapshot: State<Snapshot>,
    path: String,
    position_ms: Option<u64>,
    track_id: Option<String>,
) -> Result<(), String> {
    let tid = track_id.as_deref().and_then(|s| s.parse::<u64>().ok());
    if let Ok(mut s) = snapshot.0.lock() {
        s.current_origin = Some("resume".to_string());
        s.current_track_id = tid;
        s.started_at = None;
        s.last_position_ms = position_ms.map(|ms| ms as i64);
    }
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::Load(PathBuf::from(&path)))
        .map_err(err)?;
    if let Some(ms) = position_ms {
        if ms > 0 {
            handle
                .send(EngineCommand::Seek(std::time::Duration::from_millis(ms)))
                .map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn persist_load_state(lib: State<Library>) -> Option<persistence::PersistedState> {
    persistence::load(&lib.data_dir)
}

#[tauri::command]
fn persist_save_state(
    lib: State<Library>,
    state: persistence::PersistedState,
) -> Result<(), String> {
    persistence::save(&lib.data_dir, &state)
}

#[tauri::command]
fn lib_get_tracks_by_ids(
    lib: State<Library>,
    ids: Vec<String>,
) -> Result<Vec<Track>, String> {
    let mut out = Vec::with_capacity(ids.len());
    for raw in &ids {
        let Ok(id) = raw.parse::<u64>() else { continue };
        if let Ok(Some(mut t)) = lib.handle.track(id) {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
            out.push(t);
        }
    }
    Ok(out)
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
    let spectrum_active = Arc::new(AtomicUsize::new(0));

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
            // Devtools so abre quando o usuario pede (Ctrl+Shift+I), nao no startup.
            // Pra debug agressivo, descomente o bloco abaixo:
            // #[cfg(debug_assertions)]
            // if let Some(w) = _app.webview_windows().values().next() {
            //     w.open_devtools();
            // }

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

            // cogmem BGE-M3 para os vetores `lyrics`. Mesmo endpoint usado pelo
            // lib_semantic_search; override via RUSTIFY_LYRICS_EMBED_URL.
            let lyrics_url = std::env::var("RUSTIFY_LYRICS_EMBED_URL")
                .unwrap_or_else(|_| "http://100.123.73.128:3939".to_string());

            let config = IndexerConfig {
                qdrant_url: qdrant_url.clone(),
                music_root: music_root.clone(),
                cache_dir: cache_dir.clone(),
                embed_client: embed_url.as_deref().map(EmbedClient::new),
                lyrics_client: Some(library_indexer::LyricsEmbedClient::new(lyrics_url)),
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
            let library = Library {
                handle: indexer,
                cache_dir,
                music_root,
                data_dir: data_dir.clone(),
            };
            // Cria a station "Your Mix" caso o usuario nao tenha nenhuma ainda.
            maybe_seed_default_station(&library);
            _app.manage(library);

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

            let spectrum_buf = engine.spectrum_buffer();
            let envelope_buf = engine.envelope_buffer();
            let sample_rate_buf = engine.sample_rate_buf();
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

                        if spectrum_flag.load(Ordering::Relaxed) == 0 {
                            if tick_count % 300 == 0 {
                                tracing::debug!("spectrum-emitter: no subscribers");
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

                        // Snapshot do envelope beat-sync. Fallback para zeros
                        // se o lock estiver poisoned (improvável).
                        let envelope = envelope_buf
                            .lock()
                            .map(|g| *g)
                            .unwrap_or_default();

                        if tick_count % 300 == 0 {
                            tracing::info!(
                                "spectrum-emitter: emitting frame len={} low={:.3} mid={:.3} high={:.3} rms={:.3}",
                                fft.len(),
                                envelope.low_band_mag,
                                envelope.mid_band_mag,
                                envelope.high_band_mag,
                                envelope.rms_energy,
                            );
                        }
                        let payload = FftPayload {
                            stream_time_ms: 0,
                            magnitudes: fft,
                            low_band_mag: envelope.low_band_mag,
                            mid_band_mag: envelope.mid_band_mag,
                            high_band_mag: envelope.high_band_mag,
                            rms_energy: envelope.rms_energy,
                            sample_rate: sample_rate_buf.load(Ordering::Relaxed),
                        };
                        let _ = spectrum_handle.emit("audio-fft", &payload);
                    }
                })
                .ok();

            // Loudness backfill channel — declared before the event-listener
            // spawns so the listener can hand off track ids to the worker.
            let (lufs_backfill_tx, lufs_backfill_rx) =
                crossbeam_channel::unbounded::<u64>();

            // Shared loudness-normalization target (LUFS encoded as f32 bits).
            // Created here so the same Arc is observed by both the
            // event-listener thread (per-track gain) and the managed
            // `NormState` (the `norm_set_target` command writes through it).
            let norm_target_cell = Arc::new(AtomicU32::new(NORM_TARGET_LUFS.to_bits()));

            let rx = engine.subscribe();
            let app_handle = _app.handle().clone();
            let snap_writer = snapshot.clone();
            let mc_reader = media_controls.clone();
            let event_lufs_tx = lufs_backfill_tx.clone();
            let event_engine_tx = engine_tx_media.clone();
            let event_indexer = indexer_for_events.clone();
            let event_cache_dir = cache_dir_for_events.clone();
            let event_norm_target = norm_target_cell.clone();
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
                                    &event_norm_target,
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
            _app.manage(NormState::with_target(norm_target_cell));
            _app.manage(ThemeWatchState(Mutex::new(None)));

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
                norm_target: &Arc<AtomicU32>,
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
                                                norm_target_from_cell(norm_target),
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
            spectrum_subscribe,
            spectrum_unsubscribe,
            list_themes,
            load_theme,
            watch_theme,
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
            player_load_paused,
            persist_load_state,
            persist_save_state,
            lib_get_tracks_by_ids,
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
            norm_set_target,
            norm_get_target,
            get_state,
            get_system_resources,
            check_for_update,
            install_update,
            restart_app,
            list_system_fonts,
            get_media_port,
            lib_list_stations,
            lib_get_station,
            lib_create_station,
            lib_delete_station,
            lib_play_station,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home"))
}

// ──────────────────────────────────────────────────────────────────────────────
// Stations — radio stations persistentes em JSON
// ──────────────────────────────────────────────────────────────────────────────

/// Tipo da station: seed usa find_similar sobre as seed tracks;
/// mood usa lib_mood_search com a query textual.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StationKind {
    Seed,
    Mood,
}

/// Estatisticas de uso da station (atualizadas pelo lib_play_station).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StationStats {
    pub played: u32,
    pub last_played_at: Option<i64>, // Unix timestamp (segundos)
    pub match_avg: Option<f32>,      // media de score das recomendacoes
}

/// Metadados completos de uma station (persiste em disco como JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub tone: String,
    pub desc: String,
    pub kind: StationKind,
    /// IDs das tracks seed (usados quando kind = Seed).
    #[serde(default)]
    pub seed_track_ids: Vec<u64>,
    /// Query textual de mood (usada quando kind = Mood).
    #[serde(default)]
    pub query: Option<String>,
    pub stats: StationStats,
}

/// Retorna o diretorio de stations, criando-o se necessario.
fn stations_dir(data_dir: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let dir = data_dir.join("stations");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Le todos os JSONs do diretorio de stations.
fn read_all_stations(data_dir: &std::path::Path) -> Vec<Station> {
    let dir = match stations_dir(data_dir) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut stations = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(txt) = std::fs::read_to_string(&path) {
                if let Ok(s) = serde_json::from_str::<Station>(&txt) {
                    stations.push(s);
                }
            }
        }
    }
    // Ordena por played descrescente, depois por last_played_at descrescente.
    stations.sort_by(|a, b| {
        b.stats
            .played
            .cmp(&a.stats.played)
            .then_with(|| b.stats.last_played_at.cmp(&a.stats.last_played_at))
    });
    stations
}

/// Grava uma station em disco.
fn write_station(data_dir: &std::path::Path, station: &Station) -> Result<(), String> {
    let dir = stations_dir(data_dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", station.id));
    let json = serde_json::to_string_pretty(station).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Retorna timestamp Unix em segundos.
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Gera tracks para uma station conforme seu kind.
fn generate_station_tracks(station: &Station, lib: &Library, limit: usize) -> Vec<Track> {
    match station.kind {
        StationKind::Seed => {
            // Para cada seed track, busca similares e mescla os resultados.
            let client = lib.handle.client();
            let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
            let mut tracks = Vec::new();
            let per_seed = (limit / station.seed_track_ids.len().max(1)).max(5);
            for &sid in &station.seed_track_ids {
                if let Ok(recs) = client.recommend(&[sid], &[], &[], per_seed) {
                    for (track_id, _score) in recs {
                        if seen.insert(track_id) {
                            if let Ok(Some(mut t)) = lib.handle.track(track_id) {
                                if let Some(rel) = &t.album_cover_path {
                                    t.album_cover_path = Some(lib.cache_dir.join(rel));
                                }
                                tracks.push(t);
                            }
                        }
                    }
                }
            }
            tracks.truncate(limit);
            tracks
        }
        StationKind::Mood => {
            let query = station.query.clone().unwrap_or_default();
            if query.is_empty() {
                return Vec::new();
            }
            let client = lib.handle.client();
            let filters = library_indexer::MoodFilters::parse(&query);
            if filters.is_empty() {
                return Vec::new();
            }
            let ids = match client.mood_search_enrichments(&filters, limit) {
                Ok(v) => v,
                Err(_) => return Vec::new(),
            };
            let mut tracks = Vec::new();
            for track_id in ids {
                if let Ok(Some(mut t)) = lib.handle.track(track_id) {
                    if let Some(rel) = &t.album_cover_path {
                        t.album_cover_path = Some(lib.cache_dir.join(rel));
                    }
                    tracks.push(t);
                }
            }
            tracks
        }
    }
}

// ── Commands de stations ─────────────────────────────────────────────────────

#[tauri::command]
fn lib_list_stations(lib: State<Library>) -> Vec<Station> {
    read_all_stations(&lib.data_dir)
}

#[tauri::command]
fn lib_get_station(
    lib: State<Library>,
    id: String,
    limit: Option<usize>,
) -> Result<Option<serde_json::Value>, String> {
    let stations = read_all_stations(&lib.data_dir);
    let Some(station) = stations.into_iter().find(|s| s.id == id) else {
        return Ok(None);
    };
    let lim = limit.unwrap_or(40);
    let tracks = generate_station_tracks(&station, &lib, lim);
    let mut val = serde_json::to_value(&station).map_err(|e| e.to_string())?;
    val["tracks"] = serde_json::to_value(&tracks).map_err(|e| e.to_string())?;
    Ok(Some(val))
}

#[tauri::command]
fn lib_create_station(
    lib: State<Library>,
    name: String,
    kind: String,
    seed_track_ids: Option<Vec<u64>>,
    query: Option<String>,
    icon: Option<String>,
    tone: Option<String>,
    desc: Option<String>,
) -> Result<Station, String> {
    let station_kind = match kind.as_str() {
        "mood" => StationKind::Mood,
        _ => StationKind::Seed,
    };
    // ID: slug do nome + timestamp para unicidade.
    let slug: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let ts = now_unix();
    let id = format!("{slug}-{ts}");

    let station = Station {
        id,
        name,
        icon: icon.unwrap_or_else(|| "lucide:radio".to_string()),
        tone: tone.unwrap_or_else(|| "tone-lavender".to_string()),
        desc: desc.unwrap_or_default(),
        kind: station_kind,
        seed_track_ids: seed_track_ids.unwrap_or_default(),
        query,
        stats: StationStats::default(),
    };
    write_station(&lib.data_dir, &station)?;
    Ok(station)
}

#[tauri::command]
fn lib_delete_station(lib: State<Library>, id: String) -> Result<bool, String> {
    let dir = stations_dir(&lib.data_dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn lib_play_station(
    lib: State<Library>,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let mut stations = read_all_stations(&lib.data_dir);
    let Some(station) = stations.iter_mut().find(|s| s.id == id) else {
        return Err(format!("station '{id}' nao encontrada"));
    };
    station.stats.played += 1;
    station.stats.last_played_at = Some(now_unix());
    let updated = station.clone();
    write_station(&lib.data_dir, &updated)?;

    let tracks = generate_station_tracks(&updated, &lib, limit.unwrap_or(40));
    Ok(tracks)
}

/// Cria a station "Your Mix" (seed baseada em behavioral_signals) se o
/// diretorio de stations estiver vazio. Chamado no setup do app.
fn maybe_seed_default_station(lib: &Library) {
    let dir = match stations_dir(&lib.data_dir) {
        Ok(d) => d,
        Err(_) => return,
    };
    // So cria se o diretorio estiver vazio.
    let is_empty = std::fs::read_dir(&dir)
        .map(|mut d| d.next().is_none())
        .unwrap_or(true);
    if !is_empty {
        return;
    }

    // Pega as tracks mais tocadas do behavioral_signals como seeds.
    let seed_ids: Vec<u64> = match lib.handle.behavioral_signals() {
        Ok((history, _)) => history.into_iter().take(5).collect(),
        Err(_) => return,
    };
    if seed_ids.is_empty() {
        return;
    }

    let station = Station {
        id: "your-mix".to_string(),
        name: "Your Mix".to_string(),
        icon: "lucide:sparkles".to_string(),
        tone: "tone-lavender".to_string(),
        desc: "gerada a partir das suas tracks favoritas".to_string(),
        kind: StationKind::Seed,
        seed_track_ids: seed_ids,
        query: None,
        stats: StationStats::default(),
    };
    let _ = write_station(&lib.data_dir, &station);
    tracing::info!("station 'Your Mix' criada com seeds de behavioral_signals");
}

// ──────────────────────────────────────────────────────────────────────────────
// Testes unitarios — bridge e calculadora de contraste
// ──────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // YAML minimo representando um tema legado (vocabulario surfaces/text/accent/signal).
    // Usa r##"..."## para nao conflitar com aspas dentro de strings hex ("#aabbcc").
    const TEMA_MINIMAL: &str = r##"
name: Teste
author: CI

surfaces:
  lowest: '#111111'
  base: '#1a1a1a'
  container-low: '#222222'
  container: '#2a2a2a'
  container-high: '#333333'
  container-highest: '#3a3a3a'

dividers:
  subtle: 'rgba(255,255,255,0.08)'
  prominent: 'rgba(255,255,255,0.16)'

accent:
  primary: '#c6633d'
  primary-container: '#d87a52'
  primary-fixed-dim: '#d87a52'
  on-primary: '#111111'
  on-primary-container: '#111111'

text:
  primary: '#edeae3'
  secondary: '#a29e94'
  muted: '#85827b'
  outline: 'rgba(237,234,227,0.16)'

signal:
  ok: '#7ea977'
  warn: '#cfa560'
  error: '#c46b58'

typography:
  body: 'Inter, sans-serif'
  display: 'Fraunces, serif'
  technical: 'Inter, sans-serif'

effects:
  glow: 0.15
  surface-blur: '20px'
  surface-opacity: 0.85
"##;

    fn parse_tema(yaml: &str) -> HashMap<String, String> {
        let val: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        let mut vars = HashMap::new();
        yaml_to_css_vars(&val, "", &mut vars);
        bridge_legacy_to_extractor_lab(&mut vars);
        vars
    }

    // ── Bug 1: tokens basicos do design system devem estar presentes ──────────

    #[test]
    fn bridge_popula_bg_canvas_e_bg_paper() {
        let vars = parse_tema(TEMA_MINIMAL);
        assert!(vars.contains_key("--bg-canvas"), "--bg-canvas ausente apos bridge");
        assert_eq!(vars["--bg-canvas"], "#111111", "--bg-canvas deve vir de surfaces.lowest");
        assert!(vars.contains_key("--bg-paper"), "--bg-paper ausente apos bridge");
    }

    #[test]
    fn bridge_popula_escala_fg_completa() {
        let vars = parse_tema(TEMA_MINIMAL);
        for i in 1..=8 {
            let token = format!("--fg-{i}");
            assert!(vars.contains_key(token.as_str()), "{token} ausente apos bridge");
        }
        // fg-1 e fg-2 vem de text.primary
        assert_eq!(vars["--fg-1"], vars["--fg-2"], "fg-1 e fg-2 devem ser identicos");
        // fg-3 e fg-4 vem de text.secondary
        assert_eq!(vars["--fg-3"], vars["--fg-4"], "fg-3 e fg-4 devem ser identicos");
        // fg-5 e fg-6 vem de text.muted
        assert_eq!(vars["--fg-5"], vars["--fg-6"], "fg-5 e fg-6 devem ser identicos");
    }

    // ── Themes boost: schema novo (tones/glass/motion/shadows/background) ─────

    const TEMA_BOOST: &str = r##"
name: Boost
author: CI

tones:
  mint: { bg: '#1e2a24', border: '#26352d' }
  sky:
    bg: '#1d2530'
    border: '#25303e'

glass:
  tint: '23, 23, 23'
  alpha: 0.85
  blur: '20px'

shadows:
  card: '0 1px 2px rgba(0,0,0,0.18)'

radius:
  md: '10px'

motion:
  fast: '120ms'
  base: '180ms'
  med: '260ms'
  ease: 'cubic-bezier(.2,.8,.2,1)'

background:
  ink: '#171717'

effects:
  halo: 0.12

typography:
  mono: 'JetBrains Mono, monospace'
"##;

    #[test]
    fn schema_boost_mapeia_secoes_novas() {
        let vars = parse_tema(TEMA_BOOST);
        assert_eq!(vars["--tone-mint-bg"], "#1e2a24");
        assert_eq!(vars["--tone-mint-border"], "#26352d");
        assert_eq!(vars["--tone-sky-bg"], "#1d2530");
        assert_eq!(vars["--glass-tint"], "23, 23, 23");
        assert_eq!(vars["--glass-alpha"], "0.85");
        assert_eq!(vars["--glass-blur"], "20px");
        assert_eq!(vars["--shadow-card"], "0 1px 2px rgba(0,0,0,0.18)");
        assert_eq!(vars["--radius-md"], "10px");
        assert_eq!(vars["--dur-fast"], "120ms");
        assert_eq!(vars["--dur-base"], "180ms");
        assert_eq!(vars["--dur-med"], "260ms");
        assert_eq!(vars["--ease-out"], "cubic-bezier(.2,.8,.2,1)");
        assert_eq!(vars["--bg-ink"], "#171717");
        assert_eq!(vars["--halo-alpha"], "0.12");
    }

    #[test]
    fn typography_mono_e_mono_legacy_mapeiam_font_mono() {
        let vars = parse_tema(TEMA_BOOST);
        assert_eq!(vars["--font-mono"], "JetBrains Mono, monospace");
        let legado = parse_tema("typography:\n  mono-legacy: 'X Mono'\n");
        assert_eq!(legado["--font-mono"], "X Mono");
    }

    #[test]
    fn bridge_popula_line_2() {
        let vars = parse_tema(TEMA_MINIMAL);
        assert!(vars.contains_key("--line-2"), "--line-2 ausente apos bridge");
    }

    #[test]
    fn bridge_popula_signals_semanticos() {
        let vars = parse_tema(TEMA_MINIMAL);
        assert!(vars.contains_key("--green-fg"),  "--green-fg ausente");
        assert!(vars.contains_key("--green-ring"), "--green-ring ausente");
        assert!(vars.contains_key("--amber-fg"),  "--amber-fg ausente");
        assert!(vars.contains_key("--amber-ring"), "--amber-ring ausente");
        assert!(vars.contains_key("--rose-fg"),   "--rose-fg ausente");
        assert!(vars.contains_key("--rose-ring"),  "--rose-ring ausente");
    }

    #[test]
    fn bridge_green_fg_vem_de_signal_ok() {
        let vars = parse_tema(TEMA_MINIMAL);
        assert_eq!(vars.get("--green-fg"), vars.get("--sig-ok"),
            "--green-fg deve espelhar --sig-ok");
    }

    // ── Bug 2: calculadora de contraste ──────────────────────────────────────

    #[test]
    fn contraste_ratio_branco_preto_e_21() {
        // Branco sobre preto: ratio teorico 21:1
        let l_branco = relative_luminance(1.0, 1.0, 1.0);
        let l_preto  = relative_luminance(0.0, 0.0, 0.0);
        let ratio = contrast_ratio(l_branco, l_preto);
        assert!((ratio - 21.0).abs() < 0.01, "ratio branco/preto deve ser ~21, foi {ratio}");
    }

    #[test]
    fn hex_to_rgb_parseia_corretamente() {
        let (r, g, b) = hex_to_rgb("#ffffff").unwrap();
        assert!((r - 1.0).abs() < 1e-6);
        assert!((g - 1.0).abs() < 1e-6);
        assert!((b - 1.0).abs() < 1e-6);

        let (r2, g2, b2) = hex_to_rgb("#000000").unwrap();
        assert!(r2.abs() < 1e-6);
        assert!(g2.abs() < 1e-6);
        assert!(b2.abs() < 1e-6);
    }

    // ── Enforcement: ink de bg nunca invisível contra o canvas ──────────────

    fn ratio_of(a: &str, b: &str) -> f64 {
        let (r1, g1, b1) = hex_to_rgb(a).unwrap();
        let (r2, g2, b2) = hex_to_rgb(b).unwrap();
        contrast_ratio(relative_luminance(r1, g1, b1), relative_luminance(r2, g2, b2))
    }

    #[test]
    fn ink_igual_ao_canvas_e_levantado_para_3_1() {
        // Caso real: todos os temas declaram background.ink = canvas.
        let lifted = ensure_bg_ink_contrast("#111110", "#111110", 3.0)
            .expect("ink invisível deve ser corrigido");
        assert!(ratio_of(&lifted, "#111110") >= 3.0, "veio {lifted}");
    }

    #[test]
    fn ink_escuro_em_canvas_claro_desce_ou_mantem() {
        // Canvas claro: a correção anda pra BAIXO (ink mais escuro).
        let lifted = ensure_bg_ink_contrast("#eeeeee", "#fafafa", 3.0)
            .expect("ink claro sobre canvas claro deve ser corrigido");
        assert!(ratio_of(&lifted, "#fafafa") >= 3.0, "veio {lifted}");
    }

    #[test]
    fn ink_com_contraste_suficiente_passa_intocado() {
        assert!(ensure_bg_ink_contrast("#c64a10", "#111110", 3.0).is_none());
    }

    #[test]
    fn ink_corrigido_preserva_o_hue() {
        // Ink vinho escuro sobre canvas escuro: sobe luminância, mantém família.
        let lifted = ensure_bg_ink_contrast("#2a1015", "#111110", 3.0).unwrap();
        let (r, g, b) = hex_to_rgb(&lifted).unwrap();
        assert!(r > g && r > b, "família avermelhada devia sobreviver, veio {lifted}");
    }

    #[test]
    fn load_theme_nao_quebra_com_ink_nao_hex() {
        // Var não-hex passa intocada (None), sem panic.
        assert!(ensure_bg_ink_contrast("rgba(0,0,0,0.5)", "#111110", 3.0).is_none());
    }

    #[test]
    fn contraste_pares_semanticos_sao_calculados_apos_bridge() {
        // Verifica que todos os tokens dos pares de contraste estao presentes
        // apos o bridge — garantindo que os checks nao sao silenciosamente
        // ignorados por falta de valor.
        let vars = parse_tema(TEMA_MINIMAL);
        let pares = [
            ("--fg-1",    "--bg-canvas"),
            ("--fg-1",    "--bg-paper"),
            ("--fg-3",    "--bg-canvas"),
            ("--fg-3",    "--bg-paper"),
            ("--fg-5",    "--bg-paper"),
            ("--fg-5",    "--bg-canvas"),
            ("--blue-fg", "--bg-canvas"),
            ("--blue-fg", "--bg-paper"),
            ("--fg-1",    "--blue-bg"),
            ("--green-fg","--bg-canvas"),
            ("--amber-fg","--bg-canvas"),
            ("--rose-fg", "--bg-canvas"),
        ];
        for (fg, bg) in pares {
            assert!(vars.contains_key(fg), "token {fg} ausente — par de contraste sera ignorado");
            assert!(vars.contains_key(bg), "token {bg} ausente — par de contraste sera ignorado");
        }
    }

    // ── Testes de stations ────────────────────────────────────────────────────

    #[test]
    fn stations_dir_vazio_retorna_lista_vazia() {
        let tmp = tempfile::tempdir().unwrap();
        let stations = read_all_stations(tmp.path());
        assert!(stations.is_empty(), "dir vazio deve retornar lista vazia");
    }

    #[test]
    fn stations_dir_com_dois_jsons_retorna_dois_registros() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("stations");
        std::fs::create_dir_all(&dir).unwrap();

        let s1 = Station {
            id: "alpha".to_string(),
            name: "Alpha".to_string(),
            icon: "lucide:radio".to_string(),
            tone: "tone-lavender".to_string(),
            desc: "teste alpha".to_string(),
            kind: StationKind::Seed,
            seed_track_ids: vec![1, 2, 3],
            query: None,
            stats: StationStats { played: 10, ..Default::default() },
        };
        let s2 = Station {
            id: "beta".to_string(),
            name: "Beta".to_string(),
            icon: "lucide:radio".to_string(),
            tone: "tone-mint".to_string(),
            desc: "teste beta".to_string(),
            kind: StationKind::Mood,
            seed_track_ids: Vec::new(),
            query: Some("ambient cold".to_string()),
            stats: StationStats { played: 5, ..Default::default() },
        };

        let json1 = serde_json::to_string_pretty(&s1).unwrap();
        let json2 = serde_json::to_string_pretty(&s2).unwrap();
        std::fs::write(dir.join("alpha.json"), &json1).unwrap();
        std::fs::write(dir.join("beta.json"), &json2).unwrap();

        let stations = read_all_stations(tmp.path());
        assert_eq!(stations.len(), 2, "devem retornar 2 stations");
    }

    #[test]
    fn stations_retornam_ordenadas_por_played_desc() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("stations");
        std::fs::create_dir_all(&dir).unwrap();

        for (id, played) in [("low", 2u32), ("high", 99u32), ("mid", 50u32)] {
            let s = Station {
                id: id.to_string(),
                name: id.to_string(),
                icon: "lucide:radio".to_string(),
                tone: "tone-lavender".to_string(),
                desc: "".to_string(),
                kind: StationKind::Seed,
                seed_track_ids: vec![],
                query: None,
                stats: StationStats { played, ..Default::default() },
            };
            let json = serde_json::to_string_pretty(&s).unwrap();
            std::fs::write(dir.join(format!("{id}.json")), &json).unwrap();
        }

        let stations = read_all_stations(tmp.path());
        assert_eq!(stations[0].id, "high");
        assert_eq!(stations[1].id, "mid");
        assert_eq!(stations[2].id, "low");
    }

    // ── Bug: teardown do watcher de tema (swap do handle) ─────────────────────
    // Cobre a mecanica que `ThemeWatchHandle::stop` usa ao trocar de tema:
    // sinalizar shutdown + fechar o canal encerra a thread de debounce. Sem
    // isso, trocar N vezes de tema deixava N threads/watchers vivos.

    #[test]
    fn theme_debounce_loop_encerra_ao_fechar_canal() {
        // Thread ociosa em `recv()`; o teardown (shutdown + drop do tx) precisa
        // encerra-la sem emitir. Determinístico, sem depender de timing.
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let shutdown = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_thread = calls.clone();
        let shutdown_thread = shutdown.clone();
        let handle = std::thread::spawn(move || {
            theme_debounce_loop(
                rx,
                &shutdown_thread,
                std::time::Duration::from_millis(500),
                || {
                    calls_thread.fetch_add(1, Ordering::Relaxed);
                },
            );
        });

        shutdown.store(true, Ordering::Relaxed);
        drop(tx);
        handle.join().unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 0, "teardown nao deve emitir");
    }

    #[test]
    fn theme_debounce_loop_emite_uma_vez_por_rajada() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let shutdown = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_thread = calls.clone();
        let shutdown_thread = shutdown.clone();
        let handle = std::thread::spawn(move || {
            theme_debounce_loop(
                rx,
                &shutdown_thread,
                std::time::Duration::from_millis(15),
                || {
                    calls_thread.fetch_add(1, Ordering::Relaxed);
                },
            );
        });

        // Rajada de 3 eventos deve colapsar em UMA emissao apos a janela.
        tx.send(()).unwrap();
        tx.send(()).unwrap();
        tx.send(()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(120));
        assert_eq!(calls.load(Ordering::Relaxed), 1, "rajada deve emitir 1x");

        // Teardown limpo: nao deve haver emissao adicional.
        shutdown.store(true, Ordering::Relaxed);
        drop(tx);
        handle.join().unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 1, "teardown nao deve reemitir");
    }
}
