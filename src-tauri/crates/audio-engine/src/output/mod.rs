//! Output backend abstraction.
//!
//! The engine does not own a specific audio API; it talks to an
//! [`AudioOutput`] implementation. Two implementations are expected:
//!
//! - [`CpalOutput`] (real): routes through cpal to ALSA/PipeWire/Jack.
//! - `MockAudioOutput` (tests): consumes samples at a fake clock rate.

#![allow(dead_code)]

mod cpal_backend;

pub use cpal_backend::CpalOutput;

use crate::error::OutputError;
use crate::types::{DeviceInfo, StreamFormat};
use rtrb::Producer;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// Active stream handle owned by the engine thread.
///
/// Dropping this stops playback. The `producer` is written to by the engine
/// thread; the matching `Consumer` is owned internally by the output
/// implementation and read from the realtime audio callback.
pub struct ActiveStream {
    pub producer: Producer<f32>,
    pub actual_format: StreamFormat,
    pub alive: Arc<AtomicBool>,
    pub last_error: Arc<Mutex<Option<OutputError>>>,
    /// Backend-private handle that keeps the stream alive; dropping this
    /// tears the stream down.
    pub(crate) _keepalive: Box<dyn std::any::Any + Send>,
}

/// Trait for swappable output backends.
pub trait AudioOutput: Send {
    /// (Re)configure the output for the given source format. Returns a new
    /// [`ActiveStream`]; any previous stream on this backend is torn down.
    fn configure(&mut self, format: StreamFormat) -> Result<ActiveStream, OutputError>;

    /// Stop the current stream if any. Idempotent.
    fn stop(&mut self);

    /// Monotonically-increasing count of underruns observed since startup.
    fn xrun_count(&self) -> u64;
}

/// Enumerate output devices across every host cpal knows about.
pub fn list_devices() -> Vec<DeviceInfo> {
    cpal_backend::list_devices()
}
