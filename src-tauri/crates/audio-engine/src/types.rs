//! Shared types crossing the engine/consumer boundary.
//!
//! All types are `Send + Sync + Clone` unless noted. When the `serde` feature
//! is enabled, types that a Tauri app would serialize over IPC derive
//! `Serialize`/`Deserialize`.

use std::path::PathBuf;
use std::time::Duration;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

/// Opaque monotonically-increasing identifier for a loaded track.
/// The engine assigns new ids every time a file is loaded; the UI uses this
/// to correlate [`PositionUpdate`] events with the track currently shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct TrackHandle(pub u64);

/// Minimal track metadata exposed by the engine.
///
/// The library indexer (subsystem B) owns richer metadata (artist, album,
/// cover art, replaygain, etc.). The engine only knows what it reads from
/// the FLAC header itself.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct TrackInfo {
    pub handle: TrackHandle,
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    /// Total number of frames (samples per channel), if known from the header.
    pub total_frames: Option<u64>,
    /// Total duration in seconds, if `total_frames` is known.
    pub duration: Option<Duration>,
}

/// Sample format the engine is willing to negotiate with the output.
///
/// The MVP pipeline is always internally `F32` (symphonia's `SampleBuffer<f32>`
/// gives us vectorized conversion for free); this enum exists so the output
/// implementation can say what the device actually supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub enum SampleFormat {
    F32,
}

/// Format description negotiated between the engine and the output device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct StreamFormat {
    /// Hz (e.g. 44100, 96000, 192000).
    pub sample_rate: u32,
    /// Channel count of the source file.
    pub source_channels: u16,
    /// Channel count expected by the output device.
    pub output_channels: u16,
    pub sample_format: SampleFormat,
}

/// High-level playback state published to consumers.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub enum PlaybackState {
    Idle,
    Loading {
        track: TrackHandle,
    },
    Playing {
        track: TrackHandle,
        position_samples: u64,
    },
    Paused {
        track: TrackHandle,
        position_samples: u64,
    },
    Stopped,
    Error {
        message: String,
        track: Option<TrackHandle>,
    },
}

/// High-frequency (~10 Hz) position update.
///
/// Sent along with the current sample rate so the UI can do correct math
/// across track boundaries with differing sample rates.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct PositionUpdate {
    pub track: TrackHandle,
    pub samples_played: u64,
    pub sample_rate: u32,
    pub channels: u16,
}

impl PositionUpdate {
    pub fn seconds(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.samples_played as f64 / self.sample_rate as f64
        }
    }

    pub fn duration(&self) -> Duration {
        Duration::from_secs_f64(self.seconds())
    }
}

/// Output routing mode the user picks in settings.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub enum OutputMode {
    /// System default (on Linux this goes ALSA default -> PipeWire -> user's
    /// default sink, which is typically routed through EasyEffects).
    /// PipeWire handles sample-rate conversion; the engine does not.
    System,

    /// Open an ALSA `hw:X,Y` device directly, bypassing PipeWire. The engine
    /// reconfigures the output stream to match each track's sample rate.
    BitPerfect { device: String },

    /// Route through a running JACK server.
    Jack,
}

impl Default for OutputMode {
    fn default() -> Self {
        OutputMode::System
    }
}

/// Information about an enumerated output device (shown in Settings).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct DeviceInfo {
    pub host: String,
    pub name: String,
    pub is_default: bool,
    /// Sample rates the device advertises support for. Unreliable on PipeWire
    /// (reports a single value), informational on ALSA `hw:X,Y` devices.
    pub supported_sample_rates: Vec<u32>,
    /// Channel counts the device advertises support for.
    pub supported_channels: Vec<u16>,
}

/// Commands driven from the consumer (UI/CLI) to the engine.
#[derive(Debug, Clone)]
pub enum Command {
    /// Open a FLAC file, prepare its decoder, and transition to `Paused`.
    Load(PathBuf),
    /// Start (or resume) playback.
    Play,
    /// Pause playback without tearing the decoder down.
    Pause,
    /// Stop, drop the current decoder, and transition to `Stopped`.
    Stop,
    /// Seek to a position relative to the start of the current track.
    Seek(Duration),
    /// Set playback volume. Clamped to `0.0..=1.0`.
    SetVolume(f32),
    /// Change the output backend (triggers a stream reconfigure).
    SetOutputMode(OutputMode),
    /// Pre-load a track into the gapless "next" slot.
    EnqueueNext(PathBuf),
    /// Drop the pre-loaded next track without affecting the current one.
    ClearQueue,
    /// Cleanly stop the engine thread and release resources.
    Shutdown,
}

/// Events broadcast from the engine back to consumers.
#[derive(Debug, Clone)]
pub enum StateUpdate {
    StateChanged(PlaybackState),
    Position(PositionUpdate),
    TrackStarted(TrackInfo),
    TrackEnded(TrackHandle),
    DeviceDisconnected,
    Xrun { total: u64 },
    VolumeChanged(f32),
    OutputModeChanged(OutputMode),
    /// A recoverable error; engine returns to `Stopped` state.
    Error(String),
}

/// Runtime counters exposed via [`crate::EngineHandle::metrics`].
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct EngineMetrics {
    pub xrun_count: u64,
    pub decoded_samples_total: u64,
    pub uptime: Duration,
}
