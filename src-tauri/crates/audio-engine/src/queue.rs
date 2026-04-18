//! Gapless pre-load slot.
//!
//! The engine keeps exactly two decoders alive at any time: `current` (being
//! consumed by the output) and optionally `next` (preloaded for a gapless
//! transition). User-facing queues (history, shuffle, Up Next, etc.) live in
//! subsystem C, not here.

#![allow(dead_code)]

use crate::decoder::FlacDecoder;
use crate::error::EngineError;
use crate::types::{StreamFormat, TrackHandle, TrackInfo};
use std::path::PathBuf;

/// Opening a FLAC file touches the disk and parses headers; those operations
/// must never run on the engine thread, which has a realtime-ish deadline
/// to keep the ring buffer fed. Preparation happens on a one-shot worker
/// thread and returns this struct, which the engine can install as
/// `next_decoder` in O(1).
pub(crate) struct PreparedDecoder {
    pub decoder: FlacDecoder,
    pub info: TrackInfo,
    pub format: StreamFormat,
}

/// Spawn a short-lived worker thread that opens `path`, parses the FLAC
/// header, and sends back a `PreparedDecoder`. The worker strips embedded
/// visual metadata so a 15 MB cover art block never becomes a latency spike.
pub(crate) fn spawn_prepare(
    path: PathBuf,
    handle: TrackHandle,
    tx: crossbeam_channel::Sender<Result<PreparedDecoder, EngineError>>,
) {
    std::thread::Builder::new()
        .name("audio-prepare".to_string())
        .spawn(move || {
            let result = prepare(path, handle);
            // Receiver may have been dropped if the engine was shut down
            // mid-preparation; ignoring the send error is correct.
            let _ = tx.send(result);
        })
        .expect("spawn worker thread");
}

fn prepare(_path: PathBuf, _handle: TrackHandle) -> Result<PreparedDecoder, EngineError> {
    // Stub: depends on the real decoder implementation.
    Err(EngineError::UnsupportedFormat)
}
