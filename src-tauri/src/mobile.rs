// Rustify Android v0 — shell + biblioteca manifest-backed.
//
// Sem audio-engine (playback = plugin Kotlin Media3, spec
// 2026-08-13-android-v0-audio-plugin-design), sem Qdrant (eventos locais →
// sync fase 2), sem mcp-bridge. Os commands lib_* espelham o subset de
// leitura do contrato desktop (src/tauri.ts) para a UI navegar; a fila
// nativa entra via plugin.

use crate::mobile_library::{Folder, MobileLibrary, Track};
use std::sync::Mutex;
use tauri::State;

struct Library(Mutex<MobileLibrary>);

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
            lib_rescan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
