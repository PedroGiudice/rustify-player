use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::{models::*, RustifyAudio, RustifyAudioExt};

// Dois detalhes nao-obvios:
//
// 1. Todo command e `async`. `run_mobile_plugin*` despacha pro main looper do
//    Android e espera a resposta; command sincrono roda na thread principal e
//    daria deadlock.
// 2. O handle vem de `AppHandle<R>`, nao de `State<'_, RustifyAudio<R>>`:
//    `State` nao amarra o parametro `R` do command, e `generate_handler!` fica
//    sem conseguir inferir o Runtime.
fn audio<R: Runtime>(app: &AppHandle<R>) -> RustifyAudio<R> {
    app.rustify_audio().clone()
}

#[tauri::command]
pub(crate) async fn initialize<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    audio(&app).initialize().await
}

#[tauri::command]
pub(crate) async fn set_queue<R: Runtime>(
    app: AppHandle<R>,
    items: Vec<QueueItem>,
    start_index: Option<u32>,
    origin: String,
    context_id: Option<String>,
    play_now: Option<bool>,
) -> crate::Result<()> {
    audio(&app)
        .set_queue(SetQueueRequest {
            items,
            start_index: start_index.unwrap_or(0),
            origin,
            context_id,
            play_now: play_now.unwrap_or(true),
        })
        .await
}

#[tauri::command]
pub(crate) async fn play<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    audio(&app).play().await
}

#[tauri::command]
pub(crate) async fn pause<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    audio(&app).pause().await
}

#[tauri::command]
pub(crate) async fn seek_to<R: Runtime>(
    app: AppHandle<R>,
    position_ms: i64,
) -> crate::Result<()> {
    audio(&app).seek_to(position_ms).await
}

#[tauri::command]
pub(crate) async fn next<R: Runtime>(app: AppHandle<R>) -> crate::Result<StepResult> {
    audio(&app).next().await
}

#[tauri::command]
pub(crate) async fn previous<R: Runtime>(app: AppHandle<R>) -> crate::Result<StepResult> {
    audio(&app).previous().await
}

#[tauri::command]
pub(crate) async fn skip_to_index<R: Runtime>(
    app: AppHandle<R>,
    index: u32,
) -> crate::Result<()> {
    audio(&app).skip_to_index(index).await
}

#[tauri::command]
pub(crate) async fn get_state<R: Runtime>(app: AppHandle<R>) -> crate::Result<PlaybackState> {
    audio(&app).get_state().await
}

#[tauri::command]
pub(crate) async fn get_queue<R: Runtime>(app: AppHandle<R>) -> crate::Result<QueueSnapshot> {
    audio(&app).get_queue().await
}

#[tauri::command]
pub(crate) async fn add_items<R: Runtime>(
    app: AppHandle<R>,
    items: Vec<QueueItem>,
    origin: String,
    context_id: Option<String>,
    mode: AddMode,
    resume_if_ended: Option<bool>,
) -> crate::Result<QueueSnapshot> {
    audio(&app)
        .add_items(AddItemsRequest {
            items,
            origin,
            context_id,
            mode,
            resume_if_ended: resume_if_ended.unwrap_or(false),
        })
        .await
}

#[tauri::command]
pub(crate) async fn truncate_queue<R: Runtime>(
    app: AppHandle<R>,
    from_index: u32,
) -> crate::Result<QueueSnapshot> {
    audio(&app).truncate_queue(from_index).await
}

#[tauri::command]
pub(crate) async fn set_repeat_mode<R: Runtime>(
    app: AppHandle<R>,
    mode: RepeatMode,
) -> crate::Result<()> {
    audio(&app).set_repeat_mode(mode).await
}

#[tauri::command]
pub(crate) async fn drain_events<R: Runtime>(
    app: AppHandle<R>,
    after_seq: Option<i64>,
) -> crate::Result<DrainEventsResponse> {
    audio(&app).drain_events(after_seq.unwrap_or(0)).await
}

#[tauri::command]
pub(crate) async fn ack_events<R: Runtime>(
    app: AppHandle<R>,
    upto_seq: i64,
) -> crate::Result<()> {
    audio(&app).ack_events(upto_seq).await
}

// `addPluginListener` / `PluginListener.unregister` do @tauri-apps/api batem
// nestes dois commands; eles apenas repassam o Channel pro `trigger()` Kotlin.

#[tauri::command]
pub(crate) async fn register_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    handler: Channel<serde_json::Value>,
) -> crate::Result<()> {
    audio(&app).register_listener(event, handler).await
}

#[tauri::command]
pub(crate) async fn remove_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    channel_id: u32,
) -> crate::Result<()> {
    audio(&app).remove_listener(event, channel_id).await
}
