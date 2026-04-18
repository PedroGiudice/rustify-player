//! cpal-backed output implementation.
//!
//! Stub — real implementation delegated to rust-developer agent.

#![allow(dead_code)]

use super::{ActiveStream, AudioOutput};
use crate::error::OutputError;
use crate::types::{DeviceInfo, OutputMode, StreamFormat};

pub struct CpalOutput {
    _mode: OutputMode,
    xruns: u64,
}

impl CpalOutput {
    pub fn new(mode: OutputMode) -> Self {
        Self {
            _mode: mode,
            xruns: 0,
        }
    }

    pub fn set_mode(&mut self, mode: OutputMode) {
        self._mode = mode;
    }
}

impl AudioOutput for CpalOutput {
    fn configure(&mut self, _format: StreamFormat) -> Result<ActiveStream, OutputError> {
        Err(OutputError::NoDevices)
    }

    fn stop(&mut self) {}

    fn xrun_count(&self) -> u64 {
        self.xruns
    }
}

pub(super) fn list_devices() -> Vec<DeviceInfo> {
    Vec::new()
}
