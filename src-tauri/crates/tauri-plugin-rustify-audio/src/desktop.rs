//! Stub de host. O app desktop nunca registra este plugin — a existencia do
//! stub serve pro `cargo check` do workspace rodar no Linux/macOS/Windows.

use serde::de::DeserializeOwned;
use tauri::{ipc::Channel, plugin::PluginApi, AppHandle, Runtime};

use crate::{models::*, Error};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<RustifyAudio<R>> {
    Ok(RustifyAudio(app.clone()))
}

/// Acesso a camada de playback nativa (indisponivel fora do Android).
#[derive(Debug)]
pub struct RustifyAudio<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Clone for RustifyAudio<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> RustifyAudio<R> {
    pub async fn initialize(&self) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn set_queue(&self, _request: SetQueueRequest) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn play(&self) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn pause(&self) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn seek_to(&self, _position_ms: i64) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn next(&self) -> crate::Result<StepResult> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn previous(&self) -> crate::Result<StepResult> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn skip_to_index(&self, _index: u32) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn get_state(&self) -> crate::Result<PlaybackState> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn get_queue(&self) -> crate::Result<QueueSnapshot> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn add_items(&self, _request: AddItemsRequest) -> crate::Result<QueueSnapshot> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn truncate_queue(&self, _from_index: u32) -> crate::Result<QueueSnapshot> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn shuffle_upcoming(&self) -> crate::Result<QueueSnapshot> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn set_repeat_mode(&self, _mode: RepeatMode) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn drain_events(&self, _after_seq: i64) -> crate::Result<DrainEventsResponse> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn ack_events(&self, _upto_seq: i64) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn register_listener(
        &self,
        _event: String,
        _handler: Channel<serde_json::Value>,
    ) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn remove_listener(&self, _event: String, _channel_id: u32) -> crate::Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn updater_check(&self, _request: UpdaterCheckRequest) -> crate::Result<UpdateCheck> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn updater_install(
        &self,
        _request: UpdaterInstallRequest,
    ) -> crate::Result<UpdaterInstallResult> {
        Err(Error::UnsupportedPlatform)
    }
}
