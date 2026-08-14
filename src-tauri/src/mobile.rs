// Rustify Android v0 — shell + biblioteca manifest-backed.
//
// Sem audio-engine (playback = plugin Kotlin Media3, spec
// 2026-08-13-android-v0-audio-plugin-design), sem Qdrant (eventos locais →
// sync fase 2), sem mcp-bridge. Os commands lib_* espelham o subset de
// leitura do contrato desktop (src/tauri.ts) para a UI navegar; a fila
// nativa entra via plugin.

use crate::mobile_intel::StationMeta;
use crate::mobile_library::{Folder, MobileLibrary, Track};
use std::sync::Mutex;
use tauri::State;

struct Library(Mutex<MobileLibrary>);

/// Seed de sorteio pros lotes de station — tempo corrente (variedade entre
/// chamadas; determinismo só nos testes das funções puras).
fn shuffle_seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}

#[tauri::command]
fn lib_list_folders(lib: State<Library>) -> Vec<Folder> {
    lib.0.lock().expect("library lock").folders()
}

#[tauri::command]
fn lib_list_folder_tracks(lib: State<Library>, name: String) -> Vec<Track> {
    lib.0.lock().expect("library lock").folder_tracks(&name)
}

#[tauri::command]
fn lib_list_tracks(lib: State<Library>) -> Vec<Track> {
    lib.0.lock().expect("library lock").all_tracks().to_vec()
}

#[tauri::command]
fn lib_get_tracks_by_ids(lib: State<Library>, ids: Vec<String>) -> Vec<Track> {
    lib.0.lock().expect("library lock").by_ids(&ids)
}

// ── Inteligência local (CMR-190) — vetores + gosto + stations exportados ────

#[tauri::command]
fn lib_similar_tracks(lib: State<Library>, id: String, k: Option<usize>) -> Vec<Track> {
    lib.0
        .lock()
        .expect("library lock")
        .similar_tracks(&id, k.unwrap_or(20))
}

#[tauri::command]
fn lib_list_stations(lib: State<Library>) -> Vec<StationMeta> {
    lib.0.lock().expect("library lock").stations_meta()
}

/// Primeiro lote de uma station (espelha o contrato do desktop; stats de
/// played ficam no desktop — aqui o play volta via sync de play_events).
#[tauri::command]
fn lib_play_station(lib: State<Library>, id: String, limit: Option<usize>) -> Vec<Track> {
    lib.0
        .lock()
        .expect("library lock")
        .station_batch(&id, &[], limit.unwrap_or(40), shuffle_seed())
}

/// Lote incremental com contexto de rodada (exclui já vistas).
#[tauri::command]
fn lib_station_next(
    lib: State<Library>,
    station_id: String,
    exclude_ids: Vec<String>,
    limit: Option<usize>,
) -> Vec<Track> {
    lib.0
        .lock()
        .expect("library lock")
        .station_batch(&station_id, &exclude_ids, limit.unwrap_or(6), shuffle_seed())
}

/// Rail "Based on your favorites" — positives do snapshot de gosto.
#[tauri::command]
fn lib_taste_positives(lib: State<Library>) -> Vec<Track> {
    lib.0.lock().expect("library lock").taste_positive_tracks()
}

/// Letra da faixa a partir do sidecar `.lrc` do acervo (1328 no S24 em
/// 14/08). Mesmo nome e wire do desktop (`LyricLine { t, line, header }`);
/// sem sidecar → lista vazia e a UI esconde o toggle.
#[tauri::command]
fn lib_get_lyrics(lib: State<Library>, track_id: String) -> Vec<crate::mobile_lyrics::LyricLine> {
    let lrc = lib
        .0
        .lock()
        .expect("library lock")
        .by_ids(&[track_id])
        .into_iter()
        .next()
        .and_then(|t| t.lrc_path);
    let Some(path) = lrc else { return Vec::new() };
    match std::fs::read_to_string(&path) {
        Ok(content) => crate::mobile_lyrics::parse_lrc(&content),
        Err(e) => {
            tracing::warn!(%e, path, "lib_get_lyrics: sidecar ilegível");
            Vec::new()
        }
    }
}

/// Recarrega manifest + walk do acervo (após sync ou concessão de permissão).
#[tauri::command]
fn lib_rescan(lib: State<Library>) -> usize {
    let fresh = MobileLibrary::load();
    let count = fresh.all_tracks().len();
    *lib.0.lock().expect("library lock") = fresh;
    count
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("rustify_player", log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_rustify_audio::init())
        .setup(|app| {
            use tauri::Manager;
            // Walk de ~3k arquivos é rápido (<1s), mas fora da main thread
            // ficaria invisível pro get_state inicial — v0 aceita o load
            // síncrono no setup.
            app.manage(Library(Mutex::new(MobileLibrary::load())));
            crate::mobile_sync::worker::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lib_list_folders,
            lib_list_folder_tracks,
            lib_list_tracks,
            lib_get_tracks_by_ids,
            lib_similar_tracks,
            lib_list_stations,
            lib_play_station,
            lib_station_next,
            lib_taste_positives,
            lib_get_lyrics,
            lib_rescan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
