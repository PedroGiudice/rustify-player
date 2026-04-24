//! Error types for the audio engine.

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("failed to open file: {path}")]
    FileOpen {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("unsupported file format (FLAC only)")]
    UnsupportedFormat,

    #[error("decoder error: {0}")]
    Decode(String),

    #[error("output device error: {0}")]
    Output(#[from] OutputError),

    #[error("engine thread is no longer running")]
    EngineDead,

    #[error("engine thread panicked")]
    EnginePanic,
}

impl From<symphonia::core::errors::Error> for EngineError {
    fn from(err: symphonia::core::errors::Error) -> Self {
        EngineError::Decode(err.to_string())
    }
}

#[derive(Debug, Error)]
pub enum OutputError {
    #[error("no output devices available")]
    NoDevices,

    #[error("requested device not found: {name}")]
    DeviceNotFound { name: String },

    #[error("requested format not supported by device: {detail}")]
    FormatNotSupported { detail: String },

    #[error("device disconnected")]
    Disconnected,

    #[error("GStreamer error: {0}")]
    GstreamerError(String),

    // Keep for compatibility with existing code that uses this variant.
    #[error("init error: {0}")]
    PipewireInit(String),

    #[error("stream error: {0}")]
    PipewireStream(String),
}
