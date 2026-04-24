//! Audio engine for rustify-player.
//!
//! GStreamer-based: decode, resampling, volume, and output are all
//! handled by GStreamer's Play library. The engine thread is a thin
//! state machine that translates commands into GStreamer API calls.

pub mod error;
pub mod types;

pub(crate) mod decoder;
mod engine;
mod output;

pub use error::{EngineError, OutputError};
pub use types::{
    Command, EngineMetrics, PlaybackState, PositionUpdate, SampleFormat, StateUpdate, StreamFormat,
    TrackHandle, TrackInfo,
};

use crossbeam_channel::Receiver;

/// Top-level entry point of the audio engine.
pub struct Engine;

impl Engine {
    pub fn start() -> Result<EngineHandle, EngineError> {
        engine::spawn()
    }
}

#[derive(Clone)]
pub struct EngineHandle {
    pub(crate) command_tx: crossbeam_channel::Sender<Command>,
    pub(crate) state_rx: Receiver<StateUpdate>,
    pub(crate) metrics: std::sync::Arc<engine::SharedMetrics>,
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
}
