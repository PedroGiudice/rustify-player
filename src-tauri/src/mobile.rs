// Rustify Android v0 — shell + biblioteca manifest-backed.
//
// Sem audio-engine (playback = plugin Kotlin Media3, spec
// 2026-08-13-android-v0-audio-plugin-design), sem Qdrant (eventos locais →
// sync fase 2), sem mcp-bridge. Os commands lib_* espelham o subset de
// leitura do contrato desktop (src/tauri.ts) para a UI navegar; a fila
// nativa entra via plugin.

use crate::mobile_continuity::{ContinuityState, Mode};
use crate::mobile_intel::StationMeta;
use crate::mobile_library::{Folder, MobileLibrary, RadioStart, Track};
use std::sync::Mutex;
use tauri::State;

/// Estado Tauri da biblioteca. `pub(crate)` porque a thread de continuidade
/// alcança por `app.state()` — o tender decide a próxima faixa sem o JS.
pub(crate) struct Library(pub(crate) Mutex<MobileLibrary>);

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

/// Primeiro lote do rádio de uma faixa — NUNCA vazio com biblioteca não-vazia.
/// Faixa recém-chegada (sem linha no vectors.bin) cai pra artista/pasta e, no
/// limite, pro acervo; `layer` diz à UI em que modo ela está. O que tocou nos
/// últimos dias fica de fora (anel de recentes); se o acervo inteiro estiver
/// "recente", o último recurso da camada 3 repete mesmo assim.
#[tauri::command]
fn lib_radio_start(
    lib: State<Library>,
    cont: State<ContinuityState>,
    id: String,
    limit: Option<usize>,
) -> RadioStart {
    let recents = cont.recent_ids();
    let (tracks, layer) = lib.0.lock().expect("library lock").radio_candidates(
        &id,
        &recents,
        &[],
        limit.unwrap_or(30),
        shuffle_seed(),
    );
    RadioStart { tracks, layer }
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
        .station_batch(&id, &[], &[], limit.unwrap_or(40), shuffle_seed())
}

/// Lote incremental com contexto de rodada (exclui já vistas). Os negativos de
/// sessão vêm da UI porque este caminho é o do app acordado; o tender usa os
/// seus próprios, colhidos do journal.
#[tauri::command]
fn lib_station_next(
    lib: State<Library>,
    station_id: String,
    exclude_ids: Vec<String>,
    session_negative_ids: Option<Vec<String>>,
    limit: Option<usize>,
) -> Vec<Track> {
    let negatives: Vec<u64> = session_negative_ids
        .unwrap_or_default()
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    lib.0.lock().expect("library lock").station_batch(
        &station_id,
        &exclude_ids,
        &negatives,
        limit.unwrap_or(6),
        shuffle_seed(),
    )
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

// ── Continuidade (epic B) — "a música não para" ─────────────────────────────

/// Arma a continuidade para a fila que acabou de ser montada.
///
/// A UI chama isto DEPOIS do set_queue: o modo diz ao tender como reabastecer
/// (station usa o pool dela; qualquer outra fila vira rádio semeado). Fila que
/// o usuário montou à mão e não quer continuar chega com `mode: "off"`.
#[tauri::command]
fn continuity_arm(
    state: State<ContinuityState>,
    mode: String,
    station_id: Option<String>,
    seed_track_id: Option<String>,
) {
    let parsed = match mode.as_str() {
        "station" => station_id
            .map(|station_id| Mode::Station { station_id })
            .unwrap_or(Mode::Off),
        "radio" => seed_track_id
            .and_then(|id| id.parse::<u64>().ok())
            .map(|seed_track_id| Mode::Radio { seed_track_id })
            .unwrap_or(Mode::Off),
        _ => Mode::Off,
    };
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut c = state.inner.lock().expect("continuity lock");
    c.context_id = crate::mobile_continuity::context_for(&parsed, epoch);
    c.mode = parsed;
    // Rodada nova: o que foi visto e o que foi recusado na anterior não devem
    // pesar aqui — a rejeição é da sessão, não do gosto.
    c.seen.clear();
    c.session_negatives.clear();
    c.reaction_pending = false;
    // O journal ainda tem o que o sync não ackou — inclusive skips de horas
    // atrás. O tender reposiciona o cursor no primeiro ciclo desta rodada.
    c.journal_cursor = crate::mobile_continuity::CURSOR_UNSET;
    c.cursor_at = 0;
    c.last_error = None;
}

#[tauri::command]
fn continuity_set_enabled(state: State<ContinuityState>, enabled: bool) {
    state.inner.lock().expect("continuity lock").enabled = enabled;
}

/// Skip feito DENTRO do app. O journal já veria este evento no próximo ciclo,
/// mas isso custaria até 20 segundos de fila velha na tela; aqui a rejeição
/// entra na hora e o sino acorda o tender. Skip para TRÁS (replay) não passa
/// por aqui — quem filtra é o store.
#[tauri::command]
fn continuity_note_skip(
    state: State<ContinuityState>,
    track_id: String,
    position_ms: i64,
    duration_ms: i64,
) {
    if !crate::mobile_continuity::is_early_skip(position_ms, duration_ms) {
        return;
    }
    let Ok(id) = track_id.parse::<u64>() else { return };
    {
        let mut c = state.inner.lock().expect("continuity lock");
        if !c.enabled || c.mode == Mode::Off {
            return;
        }
        c.note_negative(id);
        c.reaction_pending = true;
    }
    state.wake();
}

/// Diagnóstico: sem isto o usuário não tem como saber por que a música parou
/// (fila sem candidatos? tender desligado? erro de IPC?).
#[tauri::command]
fn continuity_status(state: State<ContinuityState>) -> serde_json::Value {
    let c = state.inner.lock().expect("continuity lock");
    let mode = match &c.mode {
        Mode::Off => "off".to_string(),
        Mode::Radio { .. } => "radio".to_string(),
        Mode::Station { .. } => "station".to_string(),
    };
    serde_json::json!({
        "enabled": c.enabled,
        "mode": mode,
        "contextId": c.context_id,
        "seen": c.seen.len(),
        "negatives": c.session_negatives.len(),
        // Ids como STRING (u64 estoura 2^53 em JS) — é o que permite ver, de
        // fora, QUAL faixa foi recusada, e não só quantas.
        "negativeIds": c.session_negatives.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "journalCursor": c.journal_cursor,
        "lastTopupAt": c.last_topup_at,
        "lastError": c.last_error,
    })
}

/// Recarrega manifest + walk do acervo (após sync ou concessão de permissão).
#[tauri::command]
fn lib_rescan(lib: State<Library>) -> usize {
    let fresh = MobileLibrary::load();
    let count = fresh.all_tracks().len();
    *lib.0.lock().expect("library lock") = fresh;
    count
}

/// Versão instalada (tauri.conf.json embutida no APK). Serve à Settings
/// offline; a comparação com o release é do plugin (`updater_check`).
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // O target real dos módulos é o nome da LIB ("rustify_player_lib"),
                // não o do bin — com o nome errado, todo debug! (inclusive as
                // falhas de ciclo do worker de sync) era descartado em silêncio.
                .level_for("rustify_player_lib", log::LevelFilter::Debug)
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
            app.manage(ContinuityState::default());
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                app.state::<ContinuityState>().load_recents(dir.join("recents.json"));
            }
            crate::mobile_sync::worker::spawn(app.handle().clone());
            crate::mobile_continuity::tender::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lib_list_folders,
            lib_list_folder_tracks,
            lib_list_tracks,
            lib_get_tracks_by_ids,
            lib_similar_tracks,
            lib_radio_start,
            lib_list_stations,
            lib_play_station,
            lib_station_next,
            lib_taste_positives,
            lib_get_lyrics,
            lib_rescan,
            continuity_arm,
            continuity_set_enabled,
            continuity_note_skip,
            continuity_status,
            app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
