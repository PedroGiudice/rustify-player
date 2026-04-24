//! Engine thread: main loop, state machine, and coordination between the
//! decoder, the output backend, and the consumer (UI or CLI).
//!
//! Responsibilities:
//!
//! - Own `current_decoder` and `next_decoder`.
//! - Pump decoded samples into the ring buffer owned by the active output
//!   stream (the callback thread drains it).
//! - Apply per-chunk transformations: channel remap (mono upmix only) and
//!   optional volume scaling.
//! - React to `Command`s from the consumer, and emit `StateUpdate`s back.
//! - Detect end-of-stream and either perform a gapless swap (same format)
//!   or stop (different format / no next decoder).
//!
//! First-iteration notes:
//!
//! - Scheduled events (defer `TrackStarted` by the ring-buffer fill) are not
//!   yet implemented; we emit immediately. The UI will be a few hundred
//!   milliseconds ahead of the DAC on track boundaries. Acceptable for v1.
//! - Format-change drain (mid-track reconfigure of the output stream) is not yet
//!   implemented; same-format gapless swap only. Different-format next
//!   tracks are handled by stopping and re-configuring from the top.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{select, tick, Receiver, Sender};

use crate::decoder::FlacDecoder;
use crate::error::{EngineError, OutputError};
use crate::output::{ActiveStream, AudioOutput, PipewireBackend};
use crate::position::EventScheduler;
use crate::queue::{spawn_prepare, PrepareTarget, PreparedDecoder, PreparedMessage};
use crate::types::{
    Command, EngineMetrics, PlaybackState, PositionUpdate, StateUpdate, StreamFormat, TrackHandle,
    TrackInfo,
};
use crate::EngineHandle;

/// How often the engine loop wakes up to pump samples and evaluate state.
const PUMP_INTERVAL: Duration = Duration::from_millis(5);

/// How often we emit a `PositionUpdate` to the consumer (approximate).
const POSITION_INTERVAL: Duration = Duration::from_millis(100);

/// Intermediate scratch buffer size per iteration (samples, not frames).
/// 4096 f32s = 16 KB; fits L1 on any modern CPU.
const DECODE_SCRATCH: usize = 8192;

/// Counters shared with the output backend (xruns) and exposed to the
/// consumer via `EngineHandle::metrics`.
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

/// Full engine state. Lives on the engine thread; never shared.
struct EngineState {
    // Output backend (PipeWire AUTOCONNECT, no device picker).
    output: Box<dyn AudioOutput>,
    active_stream: Option<ActiveStream>,

    // Decoders.
    current: Option<LoadedTrack>,
    next: Option<LoadedTrack>,

    // Playback state machine.
    state: PlaybackState,
    volume: f32,
    next_track_id: u64,

    // Channels.
    state_tx: Sender<StateUpdate>,
    prepared_tx: Sender<PreparedMessage>,

    // Scratch buffers reused across iterations to avoid allocation.
    decode_scratch: Vec<f32>,
    output_scratch: Vec<f32>,

    // Housekeeping.
    scheduler: EventScheduler,
    metrics: Arc<SharedMetrics>,
    last_position_emit: Instant,
}

struct LoadedTrack {
    decoder: FlacDecoder,
    info: TrackInfo,
    format: StreamFormat,
}

/// Spawn the engine thread and return a clone-able handle.
pub(crate) fn spawn() -> Result<EngineHandle, EngineError> {
    let (command_tx, command_rx) = crossbeam_channel::unbounded::<Command>();
    let (state_tx, state_rx) = crossbeam_channel::unbounded::<StateUpdate>();
    let (prepared_tx, prepared_rx) = crossbeam_channel::unbounded::<PreparedMessage>();
    let metrics = Arc::new(SharedMetrics::new());

    // Publish the initial Idle state right away so consumers that subscribe
    // before the first command don't sit on an empty channel.
    state_tx
        .send(StateUpdate::StateChanged(PlaybackState::Idle))
        .ok();

    let metrics_thread = metrics.clone();
    let state_tx_thread = state_tx.clone();
    let prepared_tx_thread = prepared_tx.clone();

    thread::Builder::new()
        .name("audio-engine".to_string())
        .spawn(move || {
            // Promote this thread to SCHED_FIFO — a hard realtime scheduling
            // class. Unlike nice-value tweaks (SCHED_OTHER), SCHED_FIFO threads
            // are never pre-empted by normal threads; only higher-priority FIFO
            // threads or kernel IRQs interrupt them. PipeWire's own audio thread
            // runs at FIFO/88; we use 50, below PipeWire but above everything
            // else. Requires CAP_SYS_NICE or ulimit -r >= 50 (user's machine
            // has ulimit -r = 95, so this works without root).
            //
            // If the OS refuses (e.g. container, SELinux), we fall back silently
            // to the default scheduling policy — playback still works, just with
            // higher risk of xruns under load.
            {
                use thread_priority::unix::*;
                use thread_priority::{ThreadPriority, ThreadPriorityValue};
                let policy = ThreadSchedulePolicy::Realtime(
                    RealtimeThreadSchedulePolicy::Fifo,
                );
                let priority = ThreadPriority::Crossplatform(
                    ThreadPriorityValue::try_from(50u8)
                        .unwrap_or(ThreadPriorityValue::try_from(20u8).unwrap()),
                );
                match set_thread_priority_and_policy(
                    thread_native_id(),
                    priority,
                    policy,
                ) {
                    Ok(()) => tracing::info!(
                        "audio-engine thread promoted to SCHED_FIFO rtprio 50"
                    ),
                    Err(err) => tracing::warn!(
                        ?err,
                        "failed to set SCHED_FIFO on audio-engine thread; \
                         continuing at default priority"
                    ),
                }
            }

            let mut engine = EngineState {
                output: Box::new(PipewireBackend::new()),
                active_stream: None,
                current: None,
                next: None,
                state: PlaybackState::Idle,
                volume: 1.0,
                next_track_id: 1,
                state_tx: state_tx_thread,
                prepared_tx: prepared_tx_thread,
                decode_scratch: Vec::with_capacity(DECODE_SCRATCH),
                output_scratch: Vec::with_capacity(DECODE_SCRATCH * 2),
                scheduler: EventScheduler::default(),
                metrics: metrics_thread,
                last_position_emit: Instant::now(),
            };

            engine.run(command_rx, prepared_rx);
        })
        .map_err(|err| EngineError::Decode(format!("failed to spawn engine thread: {err}")))?;

    Ok(EngineHandle {
        command_tx,
        state_rx,
        metrics,
    })
}

impl EngineState {
    fn run(&mut self, command_rx: Receiver<Command>, prepared_rx: Receiver<PreparedMessage>) {
        let ticker = tick(PUMP_INTERVAL);

        loop {
            select! {
                recv(command_rx) -> msg => {
                    match msg {
                        Ok(Command::Shutdown) => {
                            self.teardown();
                            tracing::info!("engine shutdown requested");
                            return;
                        }
                        Ok(cmd) => self.handle_command(cmd),
                        Err(_) => {
                            // Consumer dropped all senders; exit cleanly.
                            self.teardown();
                            tracing::info!("engine command channel closed; exiting");
                            return;
                        }
                    }
                }
                recv(prepared_rx) -> msg => {
                    if let Ok(prep) = msg {
                        self.handle_prepared(prep);
                    }
                }
                recv(ticker) -> _ => {
                    self.pump();
                }
            }

            self.drain_scheduled();
        }
    }

    // ---------------------------------------------------------------------
    //  Command handlers
    // ---------------------------------------------------------------------

    fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::Load(path) => self.cmd_load(path),
            Command::Play => self.cmd_play(),
            Command::Pause => self.cmd_pause(),
            Command::Stop => self.cmd_stop(),
            Command::Seek(pos) => self.cmd_seek(pos),
            Command::SetVolume(v) => self.cmd_set_volume(v),
            Command::EnqueueNext(path) => self.cmd_enqueue_next(path),
            Command::ClearQueue => {
                self.next = None;
            }
            Command::Shutdown => {
                // Handled in `run` directly so we can `return`.
            }
        }
    }

    fn cmd_load(&mut self, path: PathBuf) {
        let handle = self.fresh_handle();
        self.set_state(PlaybackState::Loading { track: handle, play_on_load: false });
        spawn_prepare(path, handle, PrepareTarget::Current, self.prepared_tx.clone());
    }

    fn cmd_enqueue_next(&mut self, path: PathBuf) {
        let handle = self.fresh_handle();
        spawn_prepare(path, handle, PrepareTarget::Next, self.prepared_tx.clone());
    }

    fn cmd_play(&mut self) {
        // If a Load is in progress (new track prepare pending), defer the
        // actual Play to install_current by flagging play_on_load. This
        // handles both: (a) Play on an empty engine after Load, and (b)
        // track switch mid-playback — Load is dispatched, Play arrives
        // before prepare finishes, and without this branch the old track
        // gets a phantom Playing state that install_current later misreads
        // as "not Loading" and so the new track lands in Paused.
        if let PlaybackState::Loading { track, .. } = &self.state {
            self.set_state(PlaybackState::Loading { track: *track, play_on_load: true });
            return;
        }
        if self.current.is_none() {
            return;
        }
        if self.active_stream.is_none() {
            if let Err(err) = self.reconfigure_stream() {
                self.emit_error(err);
                return;
            }
        }
        // Uncork the output stream when resuming from pause.
        if let Some(stream) = &self.active_stream {
            if let Some(set_cork) = &stream.set_cork {
                (set_cork)(false);
            }
        }
        let (handle, pos) = match &self.current {
            Some(t) => (t.info.handle, t.decoder.position_samples()),
            None => return,
        };
        self.set_state(PlaybackState::Playing {
            track: handle,
            position_samples: pos,
        });
    }

    fn cmd_pause(&mut self) {
        // Symmetric to cmd_play: if a Load is in progress, the user's Pause
        // cancels any auto-play intent. Without this, a sequence of
        // Load → Play → Pause-before-prepare-completes would still
        // auto-play when install_current fires, ignoring the user's Pause.
        //
        // Mid-playback track switch: the old track's stream is still active
        // while the new track's prepare runs. Cork it here so the user
        // stops hearing audio immediately; install_current will replace or
        // reconfigure the stream when it installs the new track.
        if let PlaybackState::Loading { track, .. } = &self.state {
            self.set_state(PlaybackState::Loading { track: *track, play_on_load: false });
            if let Some(stream) = &self.active_stream {
                if let Some(set_cork) = &stream.set_cork {
                    (set_cork)(true);
                }
            }
            return;
        }
        if let Some(t) = &self.current {
            // Cork the output stream to stop callbacks and prevent phantom xruns.
            if let Some(stream) = &self.active_stream {
                if let Some(set_cork) = &stream.set_cork {
                    (set_cork)(true);
                }
            }
            let handle = t.info.handle;
            let pos = t.decoder.position_samples();
            self.set_state(PlaybackState::Paused {
                track: handle,
                position_samples: pos,
            });
        }
    }

    fn cmd_stop(&mut self) {
        self.current = None;
        self.next = None;
        self.active_stream = None;
        self.output.stop();
        self.scheduler.clear();
        self.set_state(PlaybackState::Stopped);
    }

    fn cmd_seek(&mut self, pos: Duration) {
        let Some(track) = self.current.as_mut() else {
            return;
        };
        let target_samples = (pos.as_secs_f64() * f64::from(track.info.sample_rate)) as u64;
        if let Err(err) = track.decoder.seek(target_samples) {
            self.emit_error(err);
            return;
        }
        // Drop the active stream so the next pump reconfigures it. This is
        // the simplest correct implementation: it guarantees that no stale
        // samples from before the seek leak to the DAC.
        self.active_stream = None;

        let handle = track.info.handle;
        let new_pos = track.decoder.position_samples();
        match &self.state {
            PlaybackState::Playing { .. } => {
                self.set_state(PlaybackState::Playing {
                    track: handle,
                    position_samples: new_pos,
                });
            }
            PlaybackState::Paused { .. } => {
                self.set_state(PlaybackState::Paused {
                    track: handle,
                    position_samples: new_pos,
                });
            }
            _ => {}
        }
    }

    fn cmd_set_volume(&mut self, v: f32) {
        self.volume = v.clamp(0.0, 1.0);
        let _ = self
            .state_tx
            .send(StateUpdate::VolumeChanged(self.volume));
    }

    fn handle_prepared(&mut self, msg: PreparedMessage) {
        match (msg.target, msg.result) {
            (PrepareTarget::Current, Ok(prep)) => {
                self.install_current(prep);
            }
            (PrepareTarget::Next, Ok(prep)) => {
                self.next = Some(LoadedTrack {
                    decoder: prep.decoder,
                    info: prep.info,
                    format: prep.format,
                });
            }
            (_, Err(err)) => {
                self.emit_error(err);
            }
        }
    }

    fn install_current(&mut self, prep: PreparedDecoder) {
        // Drop the active stream if the new track's format differs (e.g.
        // switching from 96kHz to 44.1kHz). The next pump() will call
        // reconfigure_stream() which creates a stream matching the new format.
        let needs_reconfigure = self
            .active_stream
            .as_ref()
            .is_some_and(|s| !format_matches(&prep.format, &s.actual_format));
        if needs_reconfigure {
            self.active_stream = None;
        }

        self.current = Some(LoadedTrack {
            decoder: prep.decoder,
            info: prep.info.clone(),
            format: prep.format,
        });

        let handle = prep.info.handle;
        let _ = self.state_tx.send(StateUpdate::TrackStarted(prep.info));

        let should_play = if let PlaybackState::Loading { play_on_load, .. } = self.state {
            play_on_load
        } else {
            false
        };

        if should_play {
            self.set_state(PlaybackState::Playing {
                track: handle,
                position_samples: 0,
            });
        } else {
            // Entering Paused preserves the "Load loads but does not play" contract.
            self.set_state(PlaybackState::Paused {
                track: handle,
                position_samples: 0,
            });
        }
    }

    // ---------------------------------------------------------------------
    //  Pump: decode samples and push to the ring buffer
    // ---------------------------------------------------------------------

    fn pump(&mut self) {
        // Emit a position update on a steady cadence independent of whether
        // we have anything to do. The consumer uses these to drive progress
        // bars and interpolates with RAF between them.
        self.maybe_emit_position();

        let playing = matches!(self.state, PlaybackState::Playing { .. });
        if !playing {
            return;
        }
        if self.current.is_none() {
            return;
        }
        let mut just_created_stream = false;
        if self.active_stream.is_none() {
            if let Err(err) = self.reconfigure_stream() {
                self.emit_error(err);
                return;
            }
            just_created_stream = true;
        }

        // Detect disconnect from the output callback thread.
        if let Some(stream) = &self.active_stream {
            if !stream.alive.load(Ordering::Acquire) {
                self.active_stream = None;
                self.emit_disconnect();
                return;
            }
        }

        // Keep decoding until the ring buffer has no more space for a chunk.
        // We break out once we can't fit a full `DECODE_SCRATCH` frame; the
        // tick loop will come back shortly.
        loop {
            if !self.can_push_more() {
                break;
            }
            match self.decode_and_push_one() {
                Ok(ControlFlow::Continue) => continue,
                Ok(ControlFlow::Stop) => break,
                Err(err) => {
                    self.emit_error(err);
                    break;
                }
            }
        }

        // Uncork AFTER the first decode pass has filled the ring buffer.
        // The INACTIVE flag prevents PipeWire's process callback from firing
        // on an empty buffer; we only activate the stream once there is real
        // audio data to consume.
        if just_created_stream {
            if let Some(stream) = &self.active_stream {
                if let Some(set_cork) = &stream.set_cork {
                    (set_cork)(false);
                }
            }
        }
    }

    fn can_push_more(&self) -> bool {
        let Some(stream) = &self.active_stream else {
            return false;
        };
        stream.producer.slots() >= DECODE_SCRATCH
    }

    fn decode_and_push_one(&mut self) -> Result<ControlFlow, EngineError> {
        let Some(track) = self.current.as_mut() else {
            return Ok(ControlFlow::Stop);
        };
        let Some(stream) = self.active_stream.as_mut() else {
            return Ok(ControlFlow::Stop);
        };

        self.decode_scratch.clear();
        let decoded = track
            .decoder
            .next_chunk(&mut self.decode_scratch)?;

        match decoded {
            None => {
                // End of current track. Try gapless swap.
                self.on_current_end()?;
                Ok(ControlFlow::Stop)
            }
            Some(_count) => {
                let src_channels = track.format.source_channels;
                let out_channels = stream.actual_format.output_channels;

                // Remap channels into `output_scratch`.
                self.output_scratch.clear();
                remap_channels(
                    &self.decode_scratch,
                    src_channels,
                    out_channels,
                    &mut self.output_scratch,
                )?;

                // Apply volume (branch-predicted away when == 1.0).
                let volume = self.volume;
                if (volume - 1.0).abs() > f32::EPSILON {
                    for sample in self.output_scratch.iter_mut() {
                        *sample *= volume;
                    }
                }

                // Push to ring buffer. If we somehow can't write the whole
                // chunk, writing what fits and coming back is safer than
                // failing the command.
                push_samples(&mut stream.producer, &self.output_scratch);

                self.metrics
                    .decoded_samples_total
                    .fetch_add(self.output_scratch.len() as u64, Ordering::Relaxed);
                Ok(ControlFlow::Continue)
            }
        }
    }

    fn on_current_end(&mut self) -> Result<(), EngineError> {
        let ended = self.current.take().map(|t| t.info.handle);
        if let Some(handle) = ended {
            let _ = self.state_tx.send(StateUpdate::TrackEnded(handle));
        }

        if let Some(next) = self.next.take() {
            let same_format = self
                .active_stream
                .as_ref()
                .is_some_and(|s| format_matches(&next.format, &s.actual_format));

            if same_format {
                // Gapless swap: promote next to current, keep stream running.
                let info = next.info.clone();
                self.current = Some(next);
                let handle = info.handle;
                let _ = self.state_tx.send(StateUpdate::TrackStarted(info));
                self.set_state(PlaybackState::Playing {
                    track: handle,
                    position_samples: 0,
                });
                return Ok(());
            }

            // Different format: tear down, reconfigure on next pump.
            let info = next.info.clone();
            self.current = Some(next);
            self.active_stream = None;
            let handle = info.handle;
            let _ = self.state_tx.send(StateUpdate::TrackStarted(info));
            self.set_state(PlaybackState::Playing {
                track: handle,
                position_samples: 0,
            });
            return Ok(());
        }

        // Nothing queued: stop.
        self.active_stream = None;
        self.output.stop();
        self.set_state(PlaybackState::Stopped);
        Ok(())
    }

    fn reconfigure_stream(&mut self) -> Result<(), OutputError> {
        let Some(track) = &self.current else {
            return Err(OutputError::NoDevices);
        };
        let stream = self.output.configure(track.format)?;
        self.active_stream = Some(stream);
        Ok(())
    }

    // ---------------------------------------------------------------------
    //  Housekeeping
    // ---------------------------------------------------------------------

    fn fresh_handle(&mut self) -> TrackHandle {
        let h = TrackHandle(self.next_track_id);
        self.next_track_id = self.next_track_id.saturating_add(1);
        h
    }

    fn set_state(&mut self, state: PlaybackState) {
        self.state = state.clone();
        let _ = self.state_tx.send(StateUpdate::StateChanged(state));
    }

    fn emit_error(&mut self, err: impl Into<EngineError>) {
        let err = err.into();
        tracing::warn!(?err, "engine error");
        let _ = self.state_tx.send(StateUpdate::Error(err.to_string()));
        self.current = None;
        self.next = None;
        self.active_stream = None;
        self.set_state(PlaybackState::Stopped);
    }

    fn emit_disconnect(&mut self) {
        tracing::warn!("output device disconnected");
        let _ = self.state_tx.send(StateUpdate::DeviceDisconnected);
        self.current = None;
        self.next = None;
        self.output.stop();
        self.set_state(PlaybackState::Stopped);
    }

    fn maybe_emit_position(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.last_position_emit) < POSITION_INTERVAL {
            return;
        }
        self.last_position_emit = now;

        let Some(track) = &self.current else {
            return;
        };
        let Some(stream) = &self.active_stream else {
            return;
        };
        // Subtract the samples still unplayed in the ring buffer so the
        // reported position matches what's actually leaving the DAC.
        let buffered = stream.producer.buffer().capacity() - stream.producer.slots();
        let buffered_frames = buffered as u64
            / u64::from(stream.actual_format.output_channels.max(1));
        let reported_samples = track
            .decoder
            .position_samples()
            .saturating_sub(buffered_frames);

        let _ = self.state_tx.send(StateUpdate::Position(PositionUpdate {
            track: track.info.handle,
            samples_played: reported_samples,
            sample_rate: track.info.sample_rate,
            channels: track.info.channels,
        }));

        // Also surface xrun counts when they change.
        let xruns = self.output.xrun_count();
        let prev = self.metrics.xrun_count.load(Ordering::Relaxed);
        if xruns > prev {
            let delta = xruns - prev;
            self.metrics.xrun_count.store(xruns, Ordering::Relaxed);
            tracing::warn!(
                xrun_delta = delta,
                xrun_total = xruns,
                sample_rate = track.info.sample_rate,
                "pipewire xrun (underrun) detected"
            );
            let _ = self.state_tx.send(StateUpdate::Xrun { total: xruns });
        }
    }

    fn drain_scheduled(&mut self) {
        let now = Instant::now();
        let mut scratch = Vec::new();
        for update in self.scheduler.drain_ready(now) {
            scratch.push(update);
        }
        for u in scratch {
            let _ = self.state_tx.send(u);
        }
    }

    fn teardown(&mut self) {
        self.current = None;
        self.next = None;
        self.active_stream = None;
        self.output.stop();
        self.set_state(PlaybackState::Stopped);
    }
}

#[derive(Debug, Clone, Copy)]
enum ControlFlow {
    Continue,
    Stop,
}

/// True when two StreamFormats can share an output stream (no reconfigure).
fn format_matches(a: &StreamFormat, b: &StreamFormat) -> bool {
    a.sample_rate == b.sample_rate && a.output_channels == b.output_channels
}

/// Remap source samples into `out` to match the output channel count.
///
/// MVP handles three cases:
/// - source == output: copy
/// - source == 1, output == 2: duplicate each sample
/// - otherwise: error (downmix and N→M mapping are out of scope here)
fn remap_channels(
    src: &[f32],
    source_channels: u16,
    output_channels: u16,
    out: &mut Vec<f32>,
) -> Result<(), EngineError> {
    if source_channels == output_channels {
        out.extend_from_slice(src);
        return Ok(());
    }
    if source_channels == 1 && output_channels == 2 {
        out.reserve(src.len() * 2);
        for sample in src {
            out.push(*sample);
            out.push(*sample);
        }
        return Ok(());
    }
    Err(EngineError::Output(OutputError::FormatNotSupported {
        detail: format!(
            "cannot map {source_channels}ch source to {output_channels}ch output in engine"
        ),
    }))
}

/// Push as many samples as fit from `src` into the ring-buffer producer.
/// If the buffer is too full, the remainder is dropped — callers must only
/// invoke this when `producer.slots() >= src.len()`, which `pump` enforces
/// via `can_push_more`.
fn push_samples(producer: &mut rtrb::Producer<f32>, src: &[f32]) {
    let to_write = src.len().min(producer.slots());
    if to_write == 0 {
        return;
    }
    if let Ok(mut chunk) = producer.write_chunk_uninit(to_write) {
        let (a, b) = chunk.as_mut_slices();
        let first = a.len().min(to_write);
        // SAFETY: write_chunk_uninit gives us MaybeUninit slots; writing f32
        // into them is trivially safe because f32 has no drop glue and
        // overwriting uninitialized memory is defined for primitive types.
        for (dst, s) in a.iter_mut().zip(&src[..first]) {
            dst.write(*s);
        }
        if to_write > first {
            let rest = &src[first..to_write];
            for (dst, s) in b.iter_mut().zip(rest) {
                dst.write(*s);
            }
        }
        // SAFETY: we wrote exactly `to_write` slots sequentially.
        unsafe {
            chunk.commit_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_matches_ignores_source_channels() {
        let a = StreamFormat {
            sample_rate: 44_100,
            source_channels: 2,
            output_channels: 2,
            sample_format: crate::types::SampleFormat::F32,
        };
        let b = StreamFormat {
            sample_rate: 44_100,
            source_channels: 1,
            output_channels: 2,
            sample_format: crate::types::SampleFormat::F32,
        };
        assert!(format_matches(&a, &b));
    }

    #[test]
    fn format_matches_detects_sr_change() {
        let a = StreamFormat {
            sample_rate: 44_100,
            source_channels: 2,
            output_channels: 2,
            sample_format: crate::types::SampleFormat::F32,
        };
        let b = StreamFormat {
            sample_rate: 96_000,
            source_channels: 2,
            output_channels: 2,
            sample_format: crate::types::SampleFormat::F32,
        };
        assert!(!format_matches(&a, &b));
    }

    #[test]
    fn remap_mono_to_stereo_duplicates() {
        let src = vec![0.1, 0.2, 0.3];
        let mut out = Vec::new();
        remap_channels(&src, 1, 2, &mut out).unwrap();
        assert_eq!(out, vec![0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
    }

    #[test]
    fn remap_stereo_passthrough() {
        let src = vec![0.1, 0.2, 0.3, 0.4];
        let mut out = Vec::new();
        remap_channels(&src, 2, 2, &mut out).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn remap_unsupported_errors() {
        let src = vec![0.0; 6];
        let mut out = Vec::new();
        let result = remap_channels(&src, 5, 2, &mut out);
        assert!(result.is_err());
    }

    /// Cheap smoke test: the engine thread spins up, reports `Idle`, and
    /// responds to `Shutdown`. No audio device needed.
    #[test]
    fn engine_starts_and_shuts_down() {
        let handle = spawn().expect("spawn ok");
        let updates = handle.subscribe();
        // Expect an initial Idle state.
        let first = updates
            .recv_timeout(Duration::from_secs(1))
            .expect("initial state");
        match first {
            StateUpdate::StateChanged(PlaybackState::Idle) => {}
            other => panic!("expected initial Idle, got {other:?}"),
        }
        handle
            .send(Command::Shutdown)
            .expect("shutdown send ok");
        // Drain any further state updates that arrive before the engine exits.
        while updates.recv_timeout(Duration::from_millis(200)).is_ok() {}
    }
}
