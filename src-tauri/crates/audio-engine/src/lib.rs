//! Audio engine for rustify-player.
//!
//! The crate exposes [`Engine`] and [`EngineHandle`], the public API for
//! driving playback of FLAC files through native PipeWire while
//! keeping the audio callback thread free of allocations, locks, and I/O.
//!
//! The crate has no dependency on Tauri. Consumers (CLI, Tauri app, tests)
//! drive it via [`Command`] messages and observe state via [`StateUpdate`]
//! events on a `crossbeam_channel::Receiver`.

pub mod error;
pub mod types;

mod decoder;
mod engine;
mod output;
mod position;
mod queue;

pub use error::{EngineError, OutputError};
pub use output::{AudioOutput, PipewireBackend};
pub use types::{
    Command, EngineMetrics, PlaybackState, PositionUpdate, SampleFormat, StateUpdate, StreamFormat,
    TrackHandle,
};

use crossbeam_channel::Receiver;

/// Top-level entry point of the audio engine. Owns the engine thread.
pub struct Engine;

impl Engine {
    /// Spawns the engine thread and returns a [`EngineHandle`] to drive it.
    ///
    /// Returns an error if the engine fails to start (e.g. no output devices
    /// available at all). Individual playback errors are reported via the
    /// [`StateUpdate`] broadcast rather than this function.
    pub fn start() -> Result<EngineHandle, EngineError> {
        engine::spawn()
    }

}

/// Handle to a running engine. Clone-able, `Send`-safe.
#[derive(Clone)]
pub struct EngineHandle {
    pub(crate) command_tx: crossbeam_channel::Sender<Command>,
    pub(crate) state_rx: Receiver<StateUpdate>,
    pub(crate) metrics: std::sync::Arc<engine::SharedMetrics>,
}

impl EngineHandle {
    /// Send a command to the engine. Non-blocking.
    pub fn send(&self, cmd: Command) -> Result<(), EngineError> {
        self.command_tx
            .send(cmd)
            .map_err(|_| EngineError::EngineDead)
    }

    /// Get a new receiver cloned from the engine's broadcast channel.
    ///
    /// Each call returns the *same* underlying receiver (crossbeam channels
    /// deliver each message to a single consumer), so typically you call this
    /// once and hold the receiver for the lifetime of your UI.
    pub fn subscribe(&self) -> Receiver<StateUpdate> {
        self.state_rx.clone()
    }

    /// Snapshot the engine's counters (xruns, uptime, etc.).
    pub fn metrics(&self) -> EngineMetrics {
        self.metrics.snapshot()
    }
}
