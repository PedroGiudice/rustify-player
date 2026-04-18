//! Engine thread: main loop, state machine, gapless transitions.
//!
//! Real implementation lands next; this stub lets `Engine::start` compile
//! and fail loudly when called.

#![allow(dead_code)]

use crate::error::EngineError;
use crate::types::{EngineMetrics, StateUpdate};
use crate::EngineHandle;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub(crate) struct SharedMetrics {
    pub xrun_count: AtomicU64,
    pub decoded_samples_total: AtomicU64,
    pub started_at: Instant,
}

impl SharedMetrics {
    pub fn new() -> Self {
        Self {
            xrun_count: AtomicU64::new(0),
            decoded_samples_total: AtomicU64::new(0),
            started_at: Instant::now(),
        }
    }

    pub fn snapshot(&self) -> EngineMetrics {
        EngineMetrics {
            xrun_count: self.xrun_count.load(Ordering::Relaxed),
            decoded_samples_total: self.decoded_samples_total.load(Ordering::Relaxed),
            uptime: self.started_at.elapsed(),
        }
    }
}

pub(crate) fn spawn() -> Result<EngineHandle, EngineError> {
    let (command_tx, _command_rx) = crossbeam_channel::unbounded();
    let (state_tx, state_rx) = crossbeam_channel::unbounded();
    let metrics = Arc::new(SharedMetrics::new());

    // Emit one broadcast so consumers that `recv()` right away don't block.
    let _ = state_tx.send(StateUpdate::StateChanged(
        crate::types::PlaybackState::Idle,
    ));

    // TODO: spawn the real engine thread. For now the channel endpoints
    // stay alive in the handle; any `send(Command)` will queue but never
    // be processed until the engine thread lands.

    Ok(EngineHandle {
        command_tx,
        state_rx,
        metrics,
    })
}
