// Rustify Android v0 — shell mínimo.
//
// Sobe o WebView com a UI SolidJS existente. Sem audio-engine (PipeWire não
// existe aqui — playback será plugin Kotlin Media3, passo 2), sem Qdrant
// (eventos locais em SQLite/JSONL, passo 4), sem mcp-bridge (superfície de
// rede desnecessária no celular).

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
