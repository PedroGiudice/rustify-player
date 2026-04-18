//! Gapless pre-load slot and off-thread decoder preparation.
//!
//! The engine keeps at most two decoders alive: `current` (being consumed by
//! the output) and optionally `next` (preloaded for a gapless transition).
//! User-facing queues (history, shuffle, "Up Next", etc.) live in subsystem
//! C — the audio engine only knows "what's playing now" and "what's cued".
//!
//! Opening a FLAC file touches the disk and parses headers, which must NOT
//! happen on the engine thread (it has a soft realtime deadline to keep the
//! ring buffer fed). Preparation runs on a short-lived worker thread and
//! the result is delivered back via a crossbeam channel.

use std::path::PathBuf;
use std::thread;

use crossbeam_channel::Sender;

use crate::decoder::FlacDecoder;
use crate::error::EngineError;
use crate::types::{StreamFormat, TrackHandle, TrackInfo};

/// Decoder that was successfully opened off-thread and is now ready to be
/// installed into the engine's `current` or `next` slot in O(1).
pub(crate) struct PreparedDecoder {
    pub decoder: FlacDecoder,
    pub info: TrackInfo,
    pub format: StreamFormat,
}

/// Where the prepared decoder should land once it arrives at the engine.
#[derive(Debug, Clone, Copy)]
pub(crate) enum PrepareTarget {
    /// Replace the currently loaded track (e.g. `Command::Load`).
    Current,
    /// Install into the gapless pre-load slot (e.g. `Command::EnqueueNext`).
    Next,
}

/// Message sent from the worker back to the engine.
pub(crate) struct PreparedMessage {
    pub target: PrepareTarget,
    pub result: Result<PreparedDecoder, EngineError>,
    #[allow(dead_code)] // Held for tracing/diagnostics; may be surfaced later.
    pub handle: TrackHandle,
}

/// Spawn a worker that opens `path`, validates the format, and sends back
/// a `PreparedDecoder`. The worker is single-use — once it finishes, its
/// thread exits and is cleaned up by the OS.
pub(crate) fn spawn_prepare(
    path: PathBuf,
    handle: TrackHandle,
    target: PrepareTarget,
    tx: Sender<PreparedMessage>,
) {
    let builder = thread::Builder::new().name("audio-engine-prepare".to_string());
    let worker_tx = tx.clone();
    let spawn = builder.spawn(move || {
        let result = prepare(&path, handle);
        // If the engine has shut down, the receiver is gone — silently drop.
        let _ = worker_tx.send(PreparedMessage {
            target,
            result,
            handle,
        });
    });

    if let Err(err) = spawn {
        // Spawning failed. Synthesize an error message so the engine still
        // gets a response; otherwise a Load command would silently do nothing.
        tracing::error!(?err, "failed to spawn prepare worker");
        let _ = tx.send(PreparedMessage {
            target,
            result: Err(EngineError::Decode(format!(
                "failed to spawn prepare worker: {err}"
            ))),
            handle,
        });
    }
}

fn prepare(path: &std::path::Path, handle: TrackHandle) -> Result<PreparedDecoder, EngineError> {
    let decoder = FlacDecoder::open(handle, path)?;
    let info = decoder.info().clone();
    let format = decoder.stream_format();
    Ok(PreparedDecoder {
        decoder,
        info,
        format,
    })
}
