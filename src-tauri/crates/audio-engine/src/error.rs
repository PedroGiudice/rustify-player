//! Error types for the audio engine.

use std::path::PathBuf;
use thiserror::Error;

/// Top-level engine error. All public functions on [`crate::Engine`]/[`crate::EngineHandle`]
/// return this type (or the engine emits it as a [`crate::StateUpdate::Error`]).
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

/// Errors raised by the output backend trait implementations.
#[derive(Debug, Error)]
pub enum OutputError {
    #[error("no output devices available")]
    NoDevices,

    #[error("requested device not found: {name}")]
    DeviceNotFound { name: String },

    #[error("requested format not supported by device: {detail}")]
    FormatNotSupported { detail: String },

    #[error(
        "downmix not allowed in bit-perfect mode ({source_channels}ch -> {target_channels}ch)"
    )]
    DownmixNotAllowed {
        source_channels: u16,
        target_channels: u16,
    },

    #[error("device disconnected")]
    Disconnected,

    #[error("pipewire stream error: {0}")]
    PipewireStream(String),

    #[error("pipewire init error: {0}")]
    PipewireInit(String),
}

impl From<pipewire::Error> for OutputError {
    fn from(err: pipewire::Error) -> Self {
        OutputError::PipewireInit(err.to_string())
    }
}
