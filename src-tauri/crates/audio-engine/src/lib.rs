//! Audio engine for rustify-player.
//!
//! GStreamer-based: decode, resampling, volume, and output are all
//! handled by GStreamer's Play library. The engine thread is a thin
//! state machine that translates commands into GStreamer API calls.

pub mod error;
pub mod loudness;
pub mod types;

pub(crate) mod decoder;
mod engine;
mod output;

pub use error::{EngineError, OutputError};
pub use types::{
    Command, EngineMetrics, PlaybackState, PositionUpdate, SampleFormat, StateUpdate, StreamFormat,
    TrackHandle, TrackInfo,
};
// Re-export gstreamer types needed by the Tauri layer.
pub use gstreamer;

use crossbeam_channel::Receiver;

/// Top-level entry point of the audio engine.
pub struct Engine;

impl Engine {
    pub fn start() -> Result<EngineHandle, EngineError> {
        engine::spawn()
    }
}

/// Re-export do snapshot de envelope publicado pelo FFT worker. Usado pela
/// camada Tauri para incluir os campos `low_band_mag` / `rms_energy` no
/// payload de `audio-fft`.
pub use output::pw_capture::SpectrumEnvelope;

#[derive(Clone)]
pub struct EngineHandle {
    pub(crate) command_tx: crossbeam_channel::Sender<Command>,
    pub(crate) state_rx: Receiver<StateUpdate>,
    pub(crate) metrics: std::sync::Arc<engine::SharedMetrics>,
    pub(crate) spectrum_buf: std::sync::Arc<std::sync::Mutex<(u64, Vec<u8>)>>,
    pub(crate) envelope_buf: std::sync::Arc<std::sync::Mutex<SpectrumEnvelope>>,
}

impl EngineHandle {
    pub fn send(&self, cmd: Command) -> Result<(), EngineError> {
        self.command_tx
            .send(cmd)
            .map_err(|_| EngineError::EngineDead)
    }

    pub fn subscribe(&self) -> Receiver<StateUpdate> {
        self.state_rx.clone()
    }

    pub fn command_sender(&self) -> crossbeam_channel::Sender<Command> {
        self.command_tx.clone()
    }

    pub fn metrics(&self) -> EngineMetrics {
        self.metrics.snapshot()
    }

    pub fn spectrum_buffer(&self) -> std::sync::Arc<std::sync::Mutex<(u64, Vec<u8>)>> {
        self.spectrum_buf.clone()
    }

    /// Buffer compartilhado com o snapshot dos envelopes beat-sync
    /// (`low_band_mag`, `rms_energy`). Consumido pelo spectrum-emitter
    /// para anexar os campos ao payload de `audio-fft`.
    pub fn envelope_buffer(&self) -> std::sync::Arc<std::sync::Mutex<SpectrumEnvelope>> {
        self.envelope_buf.clone()
    }

    pub fn sink_latency_ms(&self) -> u64 {
        self.metrics.sink_latency_ms.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn shared_metrics(&self) -> std::sync::Arc<engine::SharedMetrics> {
        self.metrics.clone()
    }
}
