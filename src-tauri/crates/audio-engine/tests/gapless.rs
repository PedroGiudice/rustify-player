//! Gapless playback integration test.
//!
//! Requires a working audio output device and the album fixtures in
//! `tests/fixtures/`. Runs only with `cargo test -p audio-engine -- --ignored`.

use std::time::Duration;

use audio_engine::{Command, Engine, PlaybackState, StateUpdate, TrackHandle};

mod common;

/// Load track_01, start playing, enqueue track_02, and verify that the
/// engine eventually reports `TrackEnded(handle1)` followed by a
/// `TrackStarted(handle2)` where `handle1 != handle2`.
///
/// We don't wait for the full runtime of track_01 (~2-3 min); instead we
/// seek close to the end so the swap happens quickly.
#[test]
#[ignore = "requires a working audio output device (run with --ignored)"]
fn gapless_enqueue_next_emits_track_events() {
    if !common::fixtures_available() {
        eprintln!("skipping: fixtures not available");
        return;
    }

    let engine = Engine::start().expect("engine start");
    let rx = engine.subscribe();

    engine
        .send(Command::Load(common::fixture_path("track_01.flac")))
        .expect("send Load");

    // Wait until track_01 is loaded.
    let paused = common::recv_until(
        &rx,
        |u| matches!(u, StateUpdate::StateChanged(PlaybackState::Paused { .. })),
        Duration::from_secs(5),
    );
    assert!(paused.is_some(), "track_01 never reached Paused");

    // Capture the first track handle via TrackStarted.
    let first_started = common::recv_until(
        &rx,
        |u| matches!(u, StateUpdate::TrackStarted(_)),
        Duration::from_secs(5),
    );
    let first_handle: TrackHandle = match first_started {
        Some(StateUpdate::TrackStarted(info)) => info.handle,
        _ => panic!("never saw TrackStarted for track_01"),
    };

    engine.send(Command::Play).expect("send Play");

    // Seek near the end of track_01 so the test doesn't take minutes.
    // Duration::from_secs(9999) is fine: the decoder clamps to the track
    // length on seek errors by returning EOS on the next pump, which is
    // what we want here.
    engine
        .send(Command::Seek(Duration::from_secs(9999)))
        .ok();

    engine
        .send(Command::EnqueueNext(common::fixture_path("track_02.flac")))
        .expect("send EnqueueNext");

    // Wait for TrackEnded(first_handle).
    let ended = common::recv_until(
        &rx,
        |u| matches!(u, StateUpdate::TrackEnded(h) if *h == first_handle),
        Duration::from_secs(30),
    );
    assert!(
        ended.is_some(),
        "did not observe TrackEnded for track_01 within 30s"
    );

    // Then expect a new TrackStarted with a different handle.
    let next_started = common::recv_until(
        &rx,
        |u| matches!(u, StateUpdate::TrackStarted(info) if info.handle != first_handle),
        Duration::from_secs(10),
    );
    assert!(
        next_started.is_some(),
        "gapless swap did not produce a new TrackStarted for track_02"
    );

    engine.send(Command::Shutdown).ok();
}
