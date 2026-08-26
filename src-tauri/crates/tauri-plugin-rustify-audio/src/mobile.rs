use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    ipc::Channel,
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

/// Pacote Kotlin da classe do plugin. Deve casar exatamente com o `package` de
/// `android/src/main/java/AudioPlugin.kt`.
const PLUGIN_IDENTIFIER: &str = "app.tauri.rustifyaudio";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<RustifyAudio<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "AudioPlugin")?;
    Ok(RustifyAudio(handle))
}

/// Acesso a camada de playback nativa.
#[derive(Debug)]
pub struct RustifyAudio<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for RustifyAudio<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterListenerArgs {
    event: String,
    handler: Channel<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveListenerArgs {
    event: String,
    channel_id: u32,
}

impl<R: Runtime> RustifyAudio<R> {
    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        payload: impl Serialize,
    ) -> crate::Result<T> {
        Ok(self.0.run_mobile_plugin_async(method, payload).await?)
    }

    /// `invoke.resolve()` do Kotlin devolve `null`; `serde_json::Value` aceita
    /// qualquer forma de resposta sem quebrar.
    async fn call_unit(&self, method: &str, payload: impl Serialize) -> crate::Result<()> {
        let _: serde_json::Value = self.call(method, payload).await?;
        Ok(())
    }

    pub async fn initialize(&self) -> crate::Result<()> {
        self.call_unit("initialize", EmptyArgs {}).await
    }

    pub async fn set_queue(&self, request: SetQueueRequest) -> crate::Result<()> {
        self.call_unit("setQueue", request).await
    }

    pub async fn play(&self) -> crate::Result<()> {
        self.call_unit("play", EmptyArgs {}).await
    }

    pub async fn pause(&self) -> crate::Result<()> {
        self.call_unit("pause", EmptyArgs {}).await
    }

    pub async fn seek_to(&self, position_ms: i64) -> crate::Result<()> {
        self.call_unit("seekTo", SeekToRequest { position_ms }).await
    }

    pub async fn next(&self) -> crate::Result<StepResult> {
        self.call("next", EmptyArgs {}).await
    }

    pub async fn previous(&self) -> crate::Result<StepResult> {
        self.call("previous", EmptyArgs {}).await
    }

    pub async fn skip_to_index(&self, index: u32) -> crate::Result<()> {
        self.call_unit("skipToIndex", SkipToIndexRequest { index })
            .await
    }

    pub async fn get_state(&self) -> crate::Result<PlaybackState> {
        self.call("getState", EmptyArgs {}).await
    }

    pub async fn get_queue(&self) -> crate::Result<QueueSnapshot> {
        self.call("getQueue", EmptyArgs {}).await
    }

    pub async fn add_items(&self, request: AddItemsRequest) -> crate::Result<QueueSnapshot> {
        self.call("addItems", request).await
    }

    pub async fn truncate_queue(&self, from_index: u32) -> crate::Result<QueueSnapshot> {
        self.call("truncateQueue", TruncateQueueRequest { from_index })
            .await
    }

    pub async fn shuffle_upcoming(&self) -> crate::Result<QueueSnapshot> {
        self.call("shuffleUpcoming", EmptyArgs {}).await
    }

    pub async fn set_repeat_mode(&self, mode: RepeatMode) -> crate::Result<()> {
        self.call_unit("setRepeatMode", RepeatModeRequest { mode }).await
    }

    pub async fn drain_events(&self, after_seq: i64) -> crate::Result<DrainEventsResponse> {
        self.call("drainEvents", DrainEventsRequest { after_seq })
            .await
    }

    pub async fn ack_events(&self, upto_seq: i64) -> crate::Result<()> {
        self.call_unit("ackEvents", AckEventsRequest { upto_seq })
            .await
    }

    pub async fn register_listener(
        &self,
        event: String,
        handler: Channel<serde_json::Value>,
    ) -> crate::Result<()> {
        self.call_unit("registerListener", RegisterListenerArgs { event, handler })
            .await
    }

    pub async fn remove_listener(&self, event: String, channel_id: u32) -> crate::Result<()> {
        self.call_unit("removeListener", RemoveListenerArgs { event, channel_id })
            .await
    }

    pub async fn updater_check(&self, request: UpdaterCheckRequest) -> crate::Result<UpdateCheck> {
        self.call("updaterCheck", request).await
    }

    pub async fn updater_install(
        &self,
        request: UpdaterInstallRequest,
    ) -> crate::Result<UpdaterInstallResult> {
        self.call("updaterInstall", request).await
    }
}
