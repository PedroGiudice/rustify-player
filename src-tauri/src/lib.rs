mod qdrant_process;

use audio_engine::{
    Command as EngineCommand, Engine, EngineHandle, PlaybackState, StateUpdate, TrackInfo,
};
use library_indexer::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbedClient, Genre, Indexer, IndexerConfig,
    IndexerHandle, LyricLine, MoodPlaylist, PlaylistSearchResult, QdrantClient, SearchResults,
    Track, TrackFilter, TrackOrder,
};
use serde::Serialize;
use std::path::PathBuf;
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
struct Qdrant(Option<QdrantClient>);
/// Keeps the Qdrant child process alive for the duration of the app.
/// Drop impl kills the process on app exit.
#[allow(dead_code)]
struct QdrantSidecar(Mutex<Option<qdrant_process::QdrantProcess>>);

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
    current_track_id: Option<i64>,
    started_at: Option<String>,
    last_position_ms: Option<i64>,
}
struct Snapshot(Arc<Mutex<PlayerSnapshot>>);

/// Port on which the local media HTTP server is listening.
/// Fixed at 19876 so the Tauri CSP can allowlist it statically.
struct MediaServerPort(u16);

// ---------------------------------------------------------------------------
// Error bridging — Tauri commands return Result<T, String>
// ---------------------------------------------------------------------------

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn unix_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
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
    genre_id: Option<i64>,
    artist_id: Option<i64>,
    album_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let filter = TrackFilter {
        genre_id,
        artist_id,
        album_id,
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
    artist_id: Option<i64>,
    genre_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<Album>, String> {
    let filter = AlbumFilter {
        artist_id,
        genre_id,
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
    genre_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<Artist>, String> {
    let filter = ArtistFilter {
        genre_id,
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
    qdrant: State<Qdrant>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let client = qdrant.0.as_ref().ok_or("Qdrant not configured")?;
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
    qdrant: State<Qdrant>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let client = qdrant.0.as_ref().ok_or("Qdrant not configured")?;
    let filters = library_indexer::MoodFilters::parse(&query);
    if filters.is_empty() {
        return Ok(Vec::new());
    }
    let ids = client.mood_search(&filters, limit.unwrap_or(20)).map_err(err)?;

    let mut tracks = Vec::new();
    for track_id in ids {
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
fn lib_get_track(lib: State<Library>, id: i64) -> Result<Option<Track>, String> {
    let track = lib.handle.track(id).map_err(err)?;
    Ok(track.map(|mut t| {
        if let Some(rel) = &t.album_cover_path {
            t.album_cover_path = Some(lib.cache_dir.join(rel));
        }
        t
    }))
}

#[tauri::command]
fn lib_get_album(lib: State<Library>, id: i64) -> Result<Option<Album>, String> {
    let album = lib.handle.album(id).map_err(err)?;
    Ok(album.map(|mut a| {
        if let Some(rel) = &a.cover_path {
            a.cover_path = Some(lib.cache_dir.join(rel));
        }
        a
    }))
}

#[tauri::command]
fn lib_get_artist(lib: State<Library>, id: i64) -> Result<Option<Artist>, String> {
    lib.handle.artist(id).map_err(err)
}

#[tauri::command]
fn lib_similar(
    lib: State<Library>,
    track_id: i64,
    limit: Option<usize>,
) -> Result<Vec<SimilarTrack>, String> {
    lib.handle
        .similar(track_id, limit.unwrap_or(10))
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
    genre_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let filter = TrackFilter {
        genre_id,
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
    qdrant: State<Qdrant>,
    track_id: i64,
    exclude_ids: Vec<i64>,
    limit: Option<usize>,
) -> Result<Vec<Track>, String> {
    let lim = limit.unwrap_or(5);

    // Layer 1: Qdrant Recommendations API (live, uses behavioral signals)
    if let Some(client) = qdrant.0.as_ref() {
        if client.is_healthy() {
            match lib.handle.behavioral_signals(qdrant.0.as_ref()) {
                Ok((mut positives, negatives)) => {
                    // Seed track is always in positives (if valid)
                    if track_id > 0 && !positives.contains(&track_id) {
                        positives.insert(0, track_id);
                    }
                    match client.recommend(&positives, &negatives, lim + exclude_ids.len()) {
                        Ok(recs) => {
                            let filtered: Vec<(i64, f64)> = recs
                                .into_iter()
                                .filter(|(id, _)| !exclude_ids.contains(id))
                                .take(lim)
                                .collect();
                            if !filtered.is_empty() {
                                let mut tracks = Vec::new();
                                for (rec_id, _score) in &filtered {
                                    if let Ok(Some(mut t)) = lib.handle.track(*rec_id) {
                                        if let Some(rel) = &t.album_cover_path {
                                            t.album_cover_path = Some(lib.cache_dir.join(rel));
                                        }
                                        tracks.push(t);
                                    }
                                }
                                if !tracks.is_empty() {
                                    tracing::debug!(
                                        track_id,
                                        count = tracks.len(),
                                        "autoplay: Qdrant recommendations"
                                    );
                                    return Ok(tracks);
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(track_id, error = %e, "autoplay: Qdrant recommend failed");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(track_id, error = %e, "autoplay: behavioral_signals failed");
                }
            }
        }
    }

    // Layer 2: Pre-computed recommendations from track_recommendations table
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
            tracing::debug!(track_id, count = tracks.len(), "autoplay: pre-computed recommendations");
            return Ok(tracks);
        }
    }

    // Layer 3: Brute-force similar via MERT embeddings
    let similar = lib.handle.similar(track_id, lim + exclude_ids.len()).map_err(err)?;
    let mut tracks: Vec<Track> = similar
        .into_iter()
        .filter(|(t, _)| !exclude_ids.contains(&t.id))
        .take(lim)
        .map(|(mut t, _)| {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
            t
        })
        .collect();

    // Layer 4: Shuffle as last resort
    if tracks.is_empty() {
        tracing::debug!(track_id, "autoplay: shuffle fallback");
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        tracks = lib.handle
            .shuffle(TrackFilter::default(), seed, lim)
            .map_err(err)?;
        for t in &mut tracks {
            if let Some(rel) = &t.album_cover_path {
                t.album_cover_path = Some(lib.cache_dir.join(rel));
            }
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
fn lib_get_lyrics(lib: State<Library>, track_id: i64) -> Result<Vec<LyricLine>, String> {
    lib.handle.get_lyrics(track_id).map_err(err)
}

// ---------------------------------------------------------------------------
// Playback history
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_record_play(lib: State<Library>, track_id: i64) -> Result<(), String> {
    lib.handle.record_play(track_id).map_err(err)
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
fn lib_toggle_like(lib: State<Library>, track_id: i64) -> Result<bool, String> {
    lib.handle.toggle_like(track_id).map_err(err)
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
fn lib_is_liked(lib: State<Library>, track_id: i64) -> Result<bool, String> {
    lib.handle.is_liked(track_id).map_err(err)
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

#[tauri::command]
fn lib_list_moods(lib: State<Library>) -> Result<Vec<MoodPlaylist>, String> {
    let mut moods = lib.handle.list_moods().map_err(err)?;
    for m in &mut moods {
        if let Some(rel) = &m.cover_path {
            m.cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(moods)
}

#[tauri::command]
fn lib_list_mood_tracks(lib: State<Library>, mood_id: i64) -> Result<Vec<Track>, String> {
    let mut tracks = lib.handle.list_mood_tracks(mood_id).map_err(err)?;
    for t in &mut tracks {
        if let Some(rel) = &t.album_cover_path {
            t.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }
    Ok(tracks)
}

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
fn get_track_color(qdrant: State<Qdrant>, track_id: i64) -> Result<String, String> {
    let client = qdrant.0.as_ref().ok_or("Qdrant not configured")?;
    let payload = client.get_payload(track_id).map_err(err)?;
    Ok(payload["dominant_color"].as_str().unwrap_or("").to_string())
}

#[tauri::command]
fn qdrant_sync(lib: State<Library>, qdrant: State<Qdrant>) -> Result<usize, String> {
    let client = qdrant.0.as_ref().ok_or("Qdrant not configured")?;
    lib.handle.sync_to_qdrant(client).map_err(err)
}

#[tauri::command]
fn qdrant_sync_lyrics(
    lib: State<Library>,
    qdrant: State<Qdrant>,
    tei_url: Option<String>,
) -> Result<usize, String> {
    let client = qdrant.0.as_ref().ok_or("Qdrant not configured")?;
    let url = tei_url.unwrap_or_else(|| "http://100.123.73.128:8080".to_string());
    let lyrics_client = library_indexer::LyricsEmbedClient::new(url);
    if !lyrics_client.is_healthy() {
        return Err("TEI BGE-M3 not available".to_string());
    }
    lib.handle.sync_lyrics_to_qdrant(client, &lyrics_client).map_err(err)
}

#[tauri::command]
fn log_event(qdrant: State<Qdrant>, payload: serde_json::Value) -> Result<(), String> {
    let event_type = payload
        .get("event_type")
        .and_then(|v| v.as_str())
        .ok_or("missing event_type")?;
    if event_type.is_empty() {
        return Err("empty event_type".into());
    }
    payload.get("timestamp").ok_or("missing timestamp")?;

    let client = qdrant.0.as_ref().ok_or("Qdrant not available")?;
    client.insert_raw_event(&payload).map_err(err)
}

// ---------------------------------------------------------------------------
// Player commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn player_play(
    player: State<Player>,
    snapshot: State<Snapshot>,
    path: String,
    origin: Option<String>,
    track_id: Option<i64>,
) -> Result<(), String> {
    if let Ok(mut s) = snapshot.0.lock() {
        s.current_origin = origin.or_else(|| Some("manual".to_string()));
        s.current_track_id = track_id;
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
    track_id: Option<i64>,
) -> Result<(), String> {
    if let Ok(mut s) = snapshot.0.lock() {
        s.current_origin = Some(origin);
        s.current_track_id = track_id;
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
fn player_stop(player: State<Player>) -> Result<(), String> {
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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,audio_engine=debug,rustify_player=debug,library_indexer=debug".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("0.0.0.0")
                .build(),
        )
        .setup(|_app| {
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

            let db_path = data_dir.join("library.db");
            let music_root = dirs_home().join("Music");

            let embed_url = std::env::var("RUSTIFY_EMBED_URL").ok().or_else(|| {
                // Default to Tailscale endpoint on the dev VM
                Some("https://extractlab.cormorant-alpha.ts.net:8448".to_string())
            });

            let config = IndexerConfig {
                db_path,
                music_root: music_root.clone(),
                cache_dir: cache_dir.clone(),
                embed_client: embed_url.as_deref().map(EmbedClient::new),
            };

            let indexer = Indexer::open(config).expect("failed to open library indexer");
            if indexer.needs_embedded_lyrics_scan() {
                tracing::info!(
                    "embedded-lyrics backfill pending; initial scan will re-ingest existing tracks"
                );
            }
            // Clone for the event-listener thread: it looks up library
            // metadata by path whenever a new track starts so the snapshot
            // carries title/artist/cover/lrc without the frontend having to
            // issue a separate lookup.
            let indexer_for_events = indexer.clone();
            let cache_dir_for_events = cache_dir.clone();
            // Clone for the Qdrant background sync thread.
            let indexer_for_sync = indexer.clone();
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

            // Qdrant sidecar — spawn if binary available, otherwise try
            // connecting to an already-running instance.
            let qdrant_proc = qdrant_process::QdrantProcess::spawn(&data_dir);
            _app.manage(QdrantSidecar(Mutex::new(qdrant_proc)));

            let qdrant_client = QdrantClient::new("http://localhost:6333");
            let qdrant_healthy = qdrant_client.is_healthy();
            if qdrant_healthy {
                tracing::info!("Qdrant available — enabling vector recommendations");
                if let Err(e) = qdrant_client.ensure_collection() {
                    tracing::warn!(?e, "failed to ensure Qdrant collection");
                }
                if let Err(e) = qdrant_client.ensure_play_events_collection() {
                    tracing::warn!(?e, "failed to ensure play_events collection");
                }
            } else {
                tracing::info!("Qdrant not available — using brute-force similarity fallback");
            }

            let rx = engine.subscribe();
            let app_handle = _app.handle().clone();
            let snap_writer = snapshot.clone();
            let mc_reader = media_controls.clone();
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
                                    &indexer_for_events,
                                    &cache_dir_for_events,
                                    &media_cmd_rx,
                                    &engine_tx_media,
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

            // Background sync: upsert embeddings to Qdrant without
            // blocking app startup.
            if qdrant_healthy {
                let indexer_clone = indexer_for_sync.clone();
                let client_clone = qdrant_client.clone();
                std::thread::Builder::new()
                    .name("qdrant-sync".to_string())
                    .spawn(move || {
                        match indexer_clone.sync_to_qdrant(&client_clone) {
                            Ok(n) => tracing::info!(n, "Qdrant MERT sync complete"),
                            Err(e) => tracing::warn!(?e, "Qdrant MERT sync failed"),
                        }
                    })
                    .ok();
            }
            _app.manage(Qdrant(Some(qdrant_client)));

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
                                if let (
                                    Some(track_id),
                                    Some(origin),
                                    Some(started_at),
                                    Some(duration),
                                ) = (
                                    s.current_track_id,
                                    s.current_origin.clone(),
                                    s.started_at.clone(),
                                    s.current_track
                                        .as_ref()
                                        .and_then(|t| t.duration)
                                        .map(|d| d.as_millis() as i64),
                                ) {
                                    let ended_at = unix_now();
                                    let end_pos = s.last_position_ms;
                                    if let Err(e) = indexer.insert_play_event(
                                        track_id,
                                        &origin,
                                        &started_at,
                                        Some(ended_at.as_str()),
                                        end_pos,
                                        duration,
                                    ) {
                                        tracing::warn!(
                                            ?e,
                                            track_id,
                                            "failed to record play event"
                                        );
                                    }
                                }
                                s.current_origin = None;
                                s.current_track_id = None;
                                s.started_at = None;
                                s.last_position_ms = None;
                            }
                            _ => {}
                        }
                    }
                    let _ = app_handle.emit("player-state", &event);

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
            lib_get_album,
            lib_get_artist,
            lib_similar,
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
            lib_list_moods,
            lib_list_mood_tracks,
            list_backgrounds,
            get_track_color,
            qdrant_sync,
            qdrant_sync_lyrics,
            log_event,
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
            get_state,
            get_system_resources,
            check_for_update,
            install_update,
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
