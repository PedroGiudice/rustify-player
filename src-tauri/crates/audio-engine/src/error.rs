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

    #[error("downmix not allowed in bit-perfect mode ({source_channels}ch -> {target_channels}ch)")]
    DownmixNotAllowed {
        source_channels: u16,
        target_channels: u16,
    },

    #[error("device disconnected")]
    Disconnected,

    #[error("cpal stream error: {0}")]
    CpalStream(String),

    #[error("cpal build stream error: {0}")]
    CpalBuild(String),

    #[error("cpal devices error: {0}")]
    CpalDevices(String),
}

impl From<cpal::StreamError> for OutputError {
    fn from(err: cpal::StreamError) -> Self {
        match err {
            cpal::StreamError::DeviceNotAvailable => OutputError::Disconnected,
            cpal::StreamError::BackendSpecific { err } => {
                OutputError::CpalStream(err.description)
            }
            // cpal 0.17 added these variants; treat both as generic stream
            // errors rather than disconnects (they may be recoverable).
            other => OutputError::CpalStream(other.to_string()),
        }
    }
}

impl From<cpal::BuildStreamError> for OutputError {
    fn from(err: cpal::BuildStreamError) -> Self {
        OutputError::CpalBuild(err.to_string())
    }
}

impl From<cpal::DevicesError> for OutputError {
    fn from(err: cpal::DevicesError) -> Self {
        OutputError::CpalDevices(err.to_string())
    }
}

impl From<cpal::DefaultStreamConfigError> for OutputError {
    fn from(err: cpal::DefaultStreamConfigError) -> Self {
        OutputError::CpalBuild(err.to_string())
    }
}

impl From<cpal::SupportedStreamConfigsError> for OutputError {
    fn from(err: cpal::SupportedStreamConfigsError) -> Self {
        OutputError::CpalDevices(err.to_string())
    }
}
