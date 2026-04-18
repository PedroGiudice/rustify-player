//! Shared helpers for `audio-engine` integration tests.
//!
//! Fixture FLAC files live in `tests/fixtures/`. They are too large for git
//! (~30 MB each) and may or may not be present in the checkout. All tests
//! that need them go through [`fixture_path`] and short-circuit politely via
//! [`fixtures_available`] when the files are missing.

#![allow(dead_code)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use audio_engine::StateUpdate;
use crossbeam_channel::Receiver;

/// Resolve a fixture file name (e.g. `"track_01.flac"`) to an absolute path
/// inside `tests/fixtures/`.
pub fn fixture_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("fixtures");
    p.push(name);
    p
}

/// True when the three album fixtures are readable. Tests should skip
/// themselves (passing trivially) when this returns false, so CI without
/// fixtures still gives a green result.
pub fn fixtures_available() -> bool {
    ["track_01.flac", "track_02.flac", "track_03.flac"]
        .iter()
        .all(|name| fixture_path(name).is_file())
}

/// Consume `StateUpdate`s from `rx` until `pred` returns true or `timeout`
/// elapses. Returns the matching update, or `None` on timeout or channel
/// disconnect.
pub fn recv_until<F>(
    rx: &Receiver<StateUpdate>,
    mut pred: F,
    timeout: Duration,
) -> Option<StateUpdate>
where
    F: FnMut(&StateUpdate) -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        match rx.recv_timeout(remaining) {
            Ok(update) => {
                if pred(&update) {
                    return Some(update);
                }
            }
            Err(_) => return None,
        }
    }
}
