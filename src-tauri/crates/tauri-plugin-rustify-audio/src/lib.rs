//! Camada de playback Android do Rustify Player.
//!
//! A fila e o log de escuta vivem no Kotlin: um `MediaSessionService` com
//! ExoPlayer segura a fila nativa (auto-advance sem JS) e appenda uma linha
//! JSON no journal `filesDir/play_events.jsonl` a cada transicao de faixa.
//! O Rust/JS e consumidor: drena o journal por `seq` e confirma o consumo.
//!
//! Fora do Android todo command falha com [`Error::UnsupportedPlatform`] — o
//! app desktop nao registra este plugin.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod models;

#[cfg(target_os = "android")]
mod mobile;
#[cfg(not(target_os = "android"))]
mod desktop;

pub use error::{Error, Result};
pub use models::*;

#[cfg(target_os = "android")]
pub use mobile::RustifyAudio;
#[cfg(not(target_os = "android"))]
pub use desktop::RustifyAudio;

#[cfg(target_os = "android")]
use mobile::init as init_platform;
#[cfg(not(target_os = "android"))]
use desktop::init as init_platform;

/// Extensao de [`tauri::App`] / [`tauri::AppHandle`] para alcancar a API.
pub trait RustifyAudioExt<R: Runtime> {
    fn rustify_audio(&self) -> &RustifyAudio<R>;
}

impl<R: Runtime, T: Manager<R>> RustifyAudioExt<R> for T {
    fn rustify_audio(&self) -> &RustifyAudio<R> {
        self.state::<RustifyAudio<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("rustify-audio")
        .invoke_handler(tauri::generate_handler![
            commands::initialize,
            commands::set_queue,
            commands::play,
            commands::pause,
            commands::seek_to,
            commands::next,
            commands::previous,
            commands::skip_to_index,
            commands::get_state,
            commands::get_queue,
            commands::add_items,
            commands::truncate_queue,
            commands::set_repeat_mode,
            commands::drain_events,
            commands::ack_events,
            commands::register_listener,
            commands::remove_listener,
        ])
        .setup(|app, api| {
            let audio = init_platform(app, api)?;
            app.manage(audio);
            Ok(())
        })
        .build()
}
