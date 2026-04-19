use audio_engine::{Command as EngineCommand, Engine, EngineHandle};
use library_indexer::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbedClient, Genre, Indexer, IndexerConfig,
    IndexerHandle, SearchResults, Track, TrackFilter, TrackOrder,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
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

// ---------------------------------------------------------------------------
// Error bridging — Tauri commands return Result<T, String>
// ---------------------------------------------------------------------------

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
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
        ..Default::default()
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
        ..Default::default()
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
// Library management
// ---------------------------------------------------------------------------

#[tauri::command]
fn lib_rescan(lib: State<Library>) -> Result<(), String> {
    lib.handle
        .send(library_indexer::IndexerCommand::Rescan)
        .map_err(err)
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
// Player commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn player_play(player: State<Player>, path: String) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::Load(PathBuf::from(&path)))
        .map_err(err)?;
    handle.send(EngineCommand::Play).map_err(err)
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

#[tauri::command]
fn player_enqueue_next(player: State<Player>, path: String) -> Result<(), String> {
    let guard = player.0.lock().map_err(err)?;
    let handle = guard.as_ref().ok_or("engine not started")?;
    handle
        .send(EngineCommand::EnqueueNext(PathBuf::from(path)))
        .map_err(err)
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,audio_engine=debug,rustify_player=debug".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            let home = dirs_home();
            let data_dir = home.join(".local/share/rustify-player");
            let cache_dir = home.join(".cache/rustify-player");
            std::fs::create_dir_all(&data_dir).ok();
            std::fs::create_dir_all(&cache_dir).ok();

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
            _app.manage(Library {
                handle: indexer,
                cache_dir,
                music_root,
            });

            let engine = Engine::start().expect("failed to start audio engine");

            let rx = engine.subscribe();
            let app_handle = _app.handle().clone();
            std::thread::spawn(move || {
                while let Ok(event) = rx.recv() {
                    let _ = app_handle.emit("player-state", event);
                }
            });

            _app.manage(Player(Mutex::new(Some(engine))));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lib_list_genres,
            lib_list_tracks,
            lib_list_albums,
            lib_list_artists,
            lib_search,
            lib_get_track,
            lib_get_album,
            lib_get_artist,
            lib_similar,
            lib_shuffle,
            lib_snapshot,
            lib_rescan,
            lib_list_folders,
            lib_list_folder_tracks,
            lib_record_play,
            lib_list_history,
            player_play,
            player_pause,
            player_resume,
            player_stop,
            player_seek,
            player_set_volume,
            player_enqueue_next,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home"))
}
