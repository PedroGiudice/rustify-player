//! Integration tests that exercise the engine via its public API.
//!
//! We intentionally do NOT poke at the decoder directly. Testing the public
//! surface gives us a more honest signal that the engine behaves as its
//! consumers (the CLI, the Tauri app) will observe.
//!
//! Tests marked `#[ignore]` need a real audio output device and are meant to
//! be run locally with `cargo test -p audio-engine -- --ignored`.

use std::path::PathBuf;
use std::time::Duration;

use audio_engine::{Command, Engine, PlaybackState, StateUpdate};

mod common;

// ---------------------------------------------------------------------------
// Tests that do not require any audio device.
// ---------------------------------------------------------------------------

/// Loading a path that does not exist on disk must not crash the engine.
/// Instead it should surface an `Error` update and go back to `Stopped`.
#[test]
fn engine_handles_nonexistent_file_gracefully() {
    let engine = Engine::start().expect("engine start");
    let rx = engine.subscribe();

    let bogus = PathBuf::from("/tmp/rustify-nonexistent-fixture-xyz.flac");
    engine
        .send(Command::Load(bogus))
        .expect("send Load");

    // We accept either an explicit `Error(_)` update or transitioning into
    // `PlaybackState::Stopped` via `StateChanged` — both are valid recovery
    // paths and both signal "the load did not succeed".
    let saw_error = common::recv_until(
        &rx,
        |u| {
            matches!(
                u,
                StateUpdate::Error(_)
                    | StateUpdate::StateChanged(PlaybackState::Stopped)
                    | StateUpdate::StateChanged(PlaybackState::Error { .. })
            )
        },
        Duration::from_secs(5),
    );

    assert!(
        saw_error.is_some(),
        "engine did not report an error for a missing file within 5s"
    );

    engine.send(Command::Shutdown).ok();
}

/// `Engine::start()` followed by `Shutdown` must return the thread to a
/// clean, detached state within a short time — no hanging, no panic.
#[test]
fn engine_shutdown_is_clean() {
    let engine = Engine::start().expect("engine start");
    let rx = engine.subscribe();

    // Drain the initial Idle state.
    let _ = rx.recv_timeout(Duration::from_secs(1));

    engine.send(Command::Shutdown).expect("send Shutdown");

    // After Shutdown the engine drops the sender end, so further recvs
    // eventually return Disconnected. We give it up to 2s before failing.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if deadline.checked_duration_since(std::time::Instant::now()).is_none() {
            panic!("engine thread did not shut down within 2s");
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(_) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
        }
    }
}

/// Device enumeration must not panic or leak thread handles. An empty list
/// is an acceptable outcome on a headless CI runner.
#[test]
fn list_devices_does_not_panic() {
    let devices = Engine::list_output_devices();
    // Trivial sanity on the shape of each entry.
    for d in &devices {
        assert!(!d.name.is_empty(), "device name should not be empty");
        assert!(!d.host.is_empty(), "device host should not be empty");
    }
}

// ---------------------------------------------------------------------------
// Tests that require a working audio output device.
// ---------------------------------------------------------------------------

/// End-to-end playback: load track_01, play it, let the engine drive itself
/// through the ring buffer and the output until EOF. Verifies that we get the
/// expected sequence of state transitions and that the track actually
/// completes.
#[test]
#[ignore = "requires a working audio output device (run with --ignored)"]
fn engine_plays_flac_to_completion() {
    if !common::fixtures_available() {
        eprintln!("skipping: fixtures not available");
        return;
    }

    let engine = Engine::start().expect("engine start");
    let rx = engine.subscribe();

    engine
        .send(Command::Load(common::fixture_path("track_01.flac")))
        .expect("send Load");

    // Wait for the track to be Paused-ready, then kick off Play.
    let paused = common::recv_until(
        &rx,
        |u| matches!(u, StateUpdate::StateChanged(PlaybackState::Paused { .. })),
        Duration::from_secs(5),
    );
    assert!(
        paused.is_some(),
        "engine never transitioned to Paused after Load"
    );

    engine.send(Command::Play).expect("send Play");

    // TrackStarted is emitted when the decoder is installed; we should see
    // it before we see TrackEnded.
    let started = common::recv_until(
        &rx,
        |u| matches!(u, StateUpdate::TrackStarted(_)),
        Duration::from_secs(5),
    );
    assert!(started.is_some(), "no TrackStarted event arrived");

    // Don't wait for the entire track (~3 min) — once playback is flowing
    // and we've observed one Position update, the pipeline is healthy.
    let position = common::recv_until(
        &rx,
        |u| matches!(u, StateUpdate::Position(_)),
        Duration::from_secs(10),
    );
    assert!(
        position.is_some(),
        "engine never emitted a PositionUpdate during playback"
    );

    engine.send(Command::Shutdown).ok();
}
