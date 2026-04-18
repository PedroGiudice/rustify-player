//! FLAC decoder wrapping `symphonia`.
//!
//! Intentionally stub — real implementation delegated to rust-developer agent.
//! This placeholder keeps the crate compiling while the engine scaffold lands.

#![allow(dead_code)]

use crate::error::EngineError;
use crate::types::{StreamFormat, TrackHandle, TrackInfo};
use std::path::Path;

/// Handle to an opened FLAC file ready to decode samples on demand.
pub(crate) struct FlacDecoder {
    // fields filled in by real implementation
}

impl FlacDecoder {
    pub(crate) fn open(_handle: TrackHandle, _path: &Path) -> Result<Self, EngineError> {
        Err(EngineError::UnsupportedFormat)
    }

    pub(crate) fn info(&self) -> &TrackInfo {
        unimplemented!("decoder stub")
    }

    pub(crate) fn stream_format(&self) -> StreamFormat {
        unimplemented!("decoder stub")
    }

    /// Pull the next packet, return the decoded f32 interleaved samples.
    /// Returns `Ok(None)` on end-of-stream.
    pub(crate) fn next_chunk(&mut self, _out: &mut Vec<f32>) -> Result<Option<usize>, EngineError> {
        unimplemented!("decoder stub")
    }

    pub(crate) fn seek(&mut self, _position_samples: u64) -> Result<(), EngineError> {
        unimplemented!("decoder stub")
    }

    pub(crate) fn position_samples(&self) -> u64 {
        0
    }
}
