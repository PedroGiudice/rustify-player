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
    /// Bits per sample from the codec (e.g. 16, 24, 32). `None` if unavailable.
    pub bit_depth: Option<u32>,
    /// Total number of frames (samples per channel), if known from the header.
    pub total_frames: Option<u64>,
    /// Total duration in seconds, if `total_frames` is known.
    pub duration: Option<Duration>,
    /// ReplayGain track gain in dB (e.g. `-6.28`). `None` when absent.
    pub track_gain_db: Option<f32>,
    /// ReplayGain album gain in dB. `None` when absent.
    pub album_gain_db: Option<f32>,
    /// ReplayGain track peak (linear, `0.0..=1.0+`). `None` when absent.
    pub track_peak: Option<f32>,
    /// ReplayGain album peak (linear). `None` when absent.
    pub album_peak: Option<f32>,
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
        play_on_load: bool,
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
    /// Pre-load a track into the gapless "next" slot.
    EnqueueNext(PathBuf),
    /// Drop the pre-loaded next track without affecting the current one.
    ClearQueue,

    // -- DSP control ----------------------------------------------------------

    /// Set a single EQ band (band 0-15, freq Hz, gain dB, Q factor).
    DspSetEqBand {
        band: u8,
        freq: f32,
        gain_db: f32,
        q: f32,
    },
    /// Set EQ filter type for a band.
    DspSetEqFilterType { band: u8, filter_type: i32 },
    /// Set EQ filter mode for a band (0=RLC BT .. 6=APO DR).
    DspSetEqFilterMode { band: u8, mode: i32 },
    /// Set EQ slope for a band (0=x1, 1=x2, 2=x3, 3=x4).
    DspSetEqSlope { band: u8, slope: i32 },
    /// Set EQ band solo (xs-N).
    DspSetEqSolo { band: u8, solo: bool },
    /// Set EQ band mute (xm-N).
    DspSetEqMute { band: u8, mute: bool },
    /// Set EQ operating mode (0=IIR, 1=FIR, 2=FFT, 3=SPM).
    DspSetEqMode(i32),
    /// Set EQ enabled (true = processing, false = passthrough).
    DspSetEqEnabled(bool),
    /// Set EQ global input/output gain (linear).
    DspSetEqGain { input: f32, output: f32 },
    /// Set limiter enabled (true = processing, false = passthrough).
    DspSetLimiterEnabled(bool),
    /// Set limiter threshold in dB.
    DspSetLimiterThreshold(f32),
    /// Set limiter knee.
    DspSetLimiterKnee(f32),
    /// Set limiter lookahead.
    DspSetLimiterLookahead(f32),
    /// Set limiter mode.
    DspSetLimiterMode(i32),
    /// Set limiter input/output gain (linear).
    DspSetLimiterGain { input: f32, output: f32 },
    /// Set limiter boost.
    DspSetLimiterBoost(bool),
    /// Set limiter attack time (ms).
    DspSetLimiterAttack(f32),
    /// Set limiter release time (ms).
    DspSetLimiterRelease(f32),
    /// Set limiter stereo link (0–100 %).
    DspSetLimiterStereoLink(f32),
    /// Set limiter sidechain preamp (linear).
    DspSetLimiterScPreamp(f32),
    /// Set limiter oversampling mode (enum).
    DspSetLimiterOversampling(i32),
    /// Set limiter dithering mode (enum).
    DspSetLimiterDither(i32),
    /// Set limiter ALR enabled.
    DspSetLimiterAlr(bool),
    /// Set limiter ALR attack time (ms).
    DspSetLimiterAlrAttack(f32),
    /// Set limiter ALR release time (ms).
    DspSetLimiterAlrRelease(f32),
    /// Set bass enhancer amount.
    DspSetBassAmount(f32),
    /// Set bass enhancer drive.
    DspSetBassDrive(f32),
    /// Set bass enhancer blend.
    DspSetBassBlend(f32),
    /// Set bass enhancer frequency.
    DspSetBassFreq(f32),
    /// Set bass enhancer floor.
    DspSetBassFloor(f32),
    /// Set bass enhancer bypass.
    DspSetBassBypass(bool),
    /// Set bass enhancer input/output levels.
    DspSetBassLevels { input: f32, output: f32 },
    /// Set bass enhancer floor-active toggle.
    DspSetBassFloorActive(bool),
    /// Set bass enhancer listen (solo harmonics).
    DspSetBassListen(bool),
    /// Global DSP bypass.
    DspSetBypass(bool),

    /// Cleanly stop the engine thread and release resources.
    Shutdown,
}

/// Events broadcast from the engine back to consumers.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub enum StateUpdate {
    StateChanged(PlaybackState),
    Position(PositionUpdate),
    TrackStarted(TrackInfo),
    TrackEnded(TrackHandle),
    DeviceDisconnected,
    Xrun {
        total: u64,
    },
    VolumeChanged(f32),
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
