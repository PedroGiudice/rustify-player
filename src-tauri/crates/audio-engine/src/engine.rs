//! Engine thread: state machine driven by GStreamer Play.
//!
//! GStreamer handles decode, resampling, volume, and output. The engine
//! thread processes commands from the consumer (UI/CLI) and translates
//! them into GStreamer Play API calls. Position updates and state
//! changes come from GStreamer signals via PlaySignalAdapter.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{select, tick, Receiver, Sender, TryRecvError};

use gstreamer as gst;
use gstreamer::glib;
use gstreamer::prelude::ClockExt;

use crate::error::EngineError;
use crate::output::GstreamerPlayer;
use crate::types::{
    Command, EngineMetrics, PlaybackState, PositionUpdate, StateUpdate, TrackHandle, TrackInfo,
};
use crate::EngineHandle;

const POSITION_INTERVAL: Duration = Duration::from_millis(100);
const TICK_INTERVAL: Duration = Duration::from_millis(50);

pub struct SharedMetrics {
    pub xrun_count: AtomicU64,
    pub decoded_samples_total: AtomicU64,
    pub started_at: Instant,
    pub sink_latency_ms: AtomicU64,
    pub running_time_ns: AtomicU64,
    pub pipeline_clock: OnceLock<gst::Clock>,
    pub pipeline_base_time_ns: AtomicU64,
}

impl SharedMetrics {
    pub fn new() -> Self {
        Self {
            xrun_count: AtomicU64::new(0),
            decoded_samples_total: AtomicU64::new(0),
            started_at: Instant::now(),
            sink_latency_ms: AtomicU64::new(50),
            running_time_ns: AtomicU64::new(0),
            pipeline_clock: OnceLock::new(),
            pipeline_base_time_ns: AtomicU64::new(0),
        }
    }

    pub fn live_running_time_ns(&self) -> u64 {
        match self.pipeline_clock.get() {
            Some(clock) => {
                let now = clock.time().nseconds();
                let base = self.pipeline_base_time_ns.load(Ordering::Relaxed);
                now.saturating_sub(base)
            }
            None => self.running_time_ns.load(Ordering::Relaxed),
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

struct EngineState {
    player: GstreamerPlayer,
    current: Option<CurrentTrack>,
    next_path: Option<PathBuf>,
    state: PlaybackState,
    volume: f64,
    rg_gain: f64,
    next_track_id: u64,
    state_tx: Sender<StateUpdate>,
    #[allow(dead_code)]
    metrics: Arc<SharedMetrics>,
    last_position_emit: Instant,
    eos_rx: Receiver<()>,
}

struct CurrentTrack {
    info: TrackInfo,
}

pub(crate) fn spawn() -> Result<EngineHandle, EngineError> {
    let (command_tx, command_rx) = crossbeam_channel::unbounded::<Command>();
    let (state_tx, state_rx) = crossbeam_channel::unbounded::<StateUpdate>();
    let metrics = Arc::new(SharedMetrics::new());

    state_tx
        .send(StateUpdate::StateChanged(PlaybackState::Idle))
        .ok();

    let metrics_thread = metrics.clone();
    let state_tx_thread = state_tx.clone();
    let state_tx_panic = state_tx.clone();

    // (running_time_ns, magnitudes) — timestamped spectrum data
    let spectrum_latest = Arc::new(std::sync::Mutex::new((0u64, Vec::<u8>::new())));
    let spectrum_latest_pub = spectrum_latest.clone();

    thread::Builder::new()
        .name("audio-engine".to_string())
        .spawn(move || {
            let player = match GstreamerPlayer::new() {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(?e, "failed to init GStreamer player");
                    let _ = state_tx_thread.send(StateUpdate::Error(e.to_string()));
                    return;
                }
            };

            tracing::info!("audio-engine started (GStreamer backend)");

            // Connect GStreamer's end-of-stream signal via the PlaySignalAdapter.
            // GLib signals require MainContext iteration — we do that in tick().
            let (eos_tx, eos_rx) = crossbeam_channel::bounded::<()>(4);
            {
                let adapter = player.signal_adapter();
                adapter.connect_end_of_stream(move |_| {
                    let _ = eos_tx.try_send(());
                });
            }

            // PipeWire capture for spectrum — captures from our own sink monitor,
            // inherently synchronized with audio output (no pipeline delay).
            let _pw_capture = crate::output::pw_capture::start(
                "rustify-player",
                spectrum_latest.clone(),
            );
            if _pw_capture.is_none() {
                tracing::warn!("PipeWire capture unavailable — spectrum will be silent");
            }

            let mut engine = EngineState {
                player,
                current: None,
                next_path: None,
                state: PlaybackState::Idle,
                volume: 1.0,
                rg_gain: 1.0,
                next_track_id: 1,
                state_tx: state_tx_thread,
                metrics: metrics_thread,
                last_position_emit: Instant::now(),
                eos_rx,
            };

            if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                engine.run(command_rx);
            })) {
                let msg = panic
                    .downcast_ref::<String>()
                    .map(|s| s.as_str())
                    .or_else(|| panic.downcast_ref::<&str>().copied())
                    .unwrap_or("unknown panic");
                tracing::error!("engine thread panicked: {msg}");
                let _ = state_tx_panic.send(StateUpdate::Error(format!("engine panic: {msg}")));
            }
        })
        .map_err(|err| EngineError::Decode(format!("failed to spawn engine thread: {err}")))?;

    Ok(EngineHandle {
        command_tx,
        state_rx,
        metrics,
        spectrum_buf: spectrum_latest_pub,
    })
}

impl EngineState {
    fn run(&mut self, command_rx: Receiver<Command>) {
        let ticker = tick(TICK_INTERVAL);

        loop {
            select! {
                recv(command_rx) -> msg => {
                    match msg {
                        Ok(Command::Shutdown) => {
                            self.player.stop();
                            tracing::info!("engine shutdown");
                            return;
                        }
                        Ok(cmd) => self.handle_command(cmd),
                        Err(_) => {
                            self.player.stop();
                            tracing::info!("engine command channel closed");
                            return;
                        }
                    }
                }
                recv(ticker) -> _ => {
                    self.tick();
                }
            }
        }
    }

    fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::Load(path) => self.cmd_load(path),
            Command::Play => self.cmd_play(),
            Command::Pause => self.cmd_pause(),
            Command::Stop => self.cmd_stop(),
            Command::Seek(pos) => self.cmd_seek(pos),
            Command::SetVolume(v) => self.cmd_set_volume(v),
            Command::EnqueueNext(path) => {
                self.next_path = Some(path);
            }
            Command::ClearQueue => {
                self.next_path = None;
            }

            // -- DSP commands -------------------------------------------------
            Command::DspSetEqBand { band, freq, gain_db, q } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_band(band, freq, gain_db, q);
                }
            }
            Command::DspSetEqFilterType { band, filter_type } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_filter_type(band, filter_type);
                }
            }
            Command::DspSetEqFilterMode { band, mode } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_filter_mode(band, mode);
                }
            }
            Command::DspSetEqSlope { band, slope } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_slope(band, slope);
                }
            }
            Command::DspSetEqSolo { band, solo } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_solo(band, solo);
                }
            }
            Command::DspSetEqMute { band, mute } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_mute(band, mute);
                }
            }
            Command::DspSetEqMode(mode) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_mode(mode);
                }
            }
            Command::DspSetEqEnabled(enabled) => {
                if let Some(dsp) = &mut self.player.dsp {
                    dsp.set_eq_enabled(enabled);
                }
            }
            Command::DspSetEqGain { input, output } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_eq_gain(input, output);
                }
            }
            Command::DspSetLimiterEnabled(enabled) => {
                if let Some(dsp) = &mut self.player.dsp {
                    dsp.set_limiter_enabled(enabled);
                }
            }
            Command::DspSetLimiterThreshold(th) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_threshold(th);
                }
            }
            Command::DspSetLimiterKnee(knee) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_knee(knee);
                }
            }
            Command::DspSetLimiterLookahead(lk) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_lookahead(lk);
                }
            }
            Command::DspSetLimiterMode(mode) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_mode(mode);
                }
            }
            Command::DspSetLimiterGain { input, output } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_gain(input, output);
                }
            }
            Command::DspSetLimiterBoost(boost) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_boost(boost);
                }
            }
            Command::DspSetLimiterAttack(at) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_attack(at);
                }
            }
            Command::DspSetLimiterRelease(rt) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_release(rt);
                }
            }
            Command::DspSetLimiterStereoLink(link) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_stereo_link(link);
                }
            }
            Command::DspSetLimiterScPreamp(preamp) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_sc_preamp(preamp);
                }
            }
            Command::DspSetLimiterOversampling(ovs) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_oversampling(ovs);
                }
            }
            Command::DspSetLimiterDither(dith) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_dither(dith);
                }
            }
            Command::DspSetLimiterAlr(alr) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_alr(alr);
                }
            }
            Command::DspSetLimiterAlrAttack(at) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_alr_attack(at);
                }
            }
            Command::DspSetLimiterAlrRelease(rt) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_limiter_alr_release(rt);
                }
            }
            Command::DspSetBassAmount(amount) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_amount(amount);
                }
            }
            Command::DspSetBassDrive(drive) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_drive(drive);
                }
            }
            Command::DspSetBassBlend(blend) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_blend(blend);
                }
            }
            Command::DspSetBassFreq(freq) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_freq(freq);
                }
            }
            Command::DspSetBassFloor(floor) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_floor(floor);
                }
            }
            Command::DspSetBassBypass(bypass) => {
                if let Some(dsp) = &mut self.player.dsp {
                    dsp.set_bass_bypass(bypass);
                }
            }
            Command::DspSetBassLevels { input, output } => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_levels(input, output);
                }
            }
            Command::DspSetBassFloorActive(active) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_floor_active(active);
                }
            }
            Command::DspSetBassListen(listen) => {
                if let Some(dsp) = &self.player.dsp {
                    dsp.set_bass_listen(listen);
                }
            }
            Command::DspSetBypass(bypass) => {
                if let Some(dsp) = &mut self.player.dsp {
                    dsp.set_bypassed(bypass);
                }
            }
            Command::DspSetNormGainDb(gain_db) => {
                if let Some(dsp) = &mut self.player.dsp {
                    dsp.set_norm_gain_db(gain_db);
                }
            }
            Command::DspSetNormEnabled(enabled) => {
                if let Some(dsp) = &mut self.player.dsp {
                    dsp.set_norm_enabled(enabled);
                }
            }

            Command::Shutdown => {}
        }
    }

    fn cmd_load(&mut self, path: PathBuf) {
        let handle = self.fresh_handle();

        // Extract metadata via symphonia before handing off to GStreamer.
        let info = match extract_track_info(handle, &path) {
            Ok(info) => info,
            Err(err) => {
                self.emit_error(err);
                return;
            }
        };

        self.rg_gain = compute_rg_gain(&info);
        self.player.set_sample_rate(info.sample_rate);
        self.player.load(&path);
        self.player.set_volume(self.volume * self.rg_gain);

        let _ = self.state_tx.send(StateUpdate::TrackStarted(info.clone()));
        self.current = Some(CurrentTrack { info });
        self.set_state(PlaybackState::Paused {
            track: handle,
            position_samples: 0,
        });
    }

    fn cmd_play(&mut self) {
        let Some(track) = &self.current else { return };
        let handle = track.info.handle;
        self.player.play();
        let latency = self.player.sink_latency_ms();
        self.metrics.sink_latency_ms.store(latency, Ordering::Relaxed);

        // Publish pipeline clock for direct access by spectrum emitter
        let rt = self.player.running_time_ns();
        if rt > 0 {
            // Store clock + base from the player's own method
            if self.metrics.pipeline_clock.get().is_none() {
                if let Some(clock) = self.player.pipeline_clock() {
                    let _ = self.metrics.pipeline_clock.set(clock);
                }
            }
            let base = self.player.pipeline_base_time_ns();
            self.metrics.pipeline_base_time_ns.store(base, Ordering::Relaxed);
        }

        self.set_state(PlaybackState::Playing {
            track: handle,
            position_samples: self.player.position_samples(),
        });
    }

    fn cmd_pause(&mut self) {
        let Some(track) = &self.current else { return };
        let handle = track.info.handle;
        self.player.pause();
        self.set_state(PlaybackState::Paused {
            track: handle,
            position_samples: self.player.position_samples(),
        });
    }

    fn cmd_stop(&mut self) {
        self.player.stop();
        self.current = None;
        self.next_path = None;
        self.set_state(PlaybackState::Stopped);
    }

    fn cmd_seek(&mut self, pos: Duration) {
        self.player.seek(pos);
        if let Some(track) = &self.current {
            let handle = track.info.handle;
            let pos_samples =
                (pos.as_secs_f64() * f64::from(track.info.sample_rate)) as u64;
            match &self.state {
                PlaybackState::Playing { .. } => {
                    self.set_state(PlaybackState::Playing {
                        track: handle,
                        position_samples: pos_samples,
                    });
                }
                PlaybackState::Paused { .. } => {
                    self.set_state(PlaybackState::Paused {
                        track: handle,
                        position_samples: pos_samples,
                    });
                }
                _ => {}
            }
        }
    }

    fn cmd_set_volume(&mut self, v: f32) {
        self.volume = f64::from(v).clamp(0.0, 1.0);
        self.player.set_volume(self.volume * self.rg_gain);
        let _ = self
            .state_tx
            .send(StateUpdate::VolumeChanged(self.volume as f32));
    }

    fn tick(&mut self) {
        // Pump GLib MainContext so PlaySignalAdapter signals are dispatched.
        let ctx = glib::MainContext::default();
        ctx.iteration(false);

        self.metrics.running_time_ns.store(
            self.player.running_time_ns(),
            Ordering::Relaxed,
        );
        self.maybe_emit_position();
        self.check_eos();
    }


    fn check_eos(&mut self) {
        // Drain the EOS channel — the signal adapter fires connect_end_of_stream
        // which sends on eos_tx. We handle it here in the engine loop.
        match self.eos_rx.try_recv() {
            Ok(()) => {}
            Err(TryRecvError::Empty) => return,
            Err(TryRecvError::Disconnected) => return,
        }

        if let Some(track) = &self.current {
            let handle = track.info.handle;
            let _ = self.state_tx.send(StateUpdate::TrackEnded(handle));

            // Gapless: load next if queued.
            if let Some(next_path) = self.next_path.take() {
                self.cmd_load(next_path);
                self.cmd_play();
            } else {
                self.current = None;
                self.set_state(PlaybackState::Stopped);
            }
        }
    }

    fn maybe_emit_position(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.last_position_emit) < POSITION_INTERVAL {
            return;
        }
        self.last_position_emit = now;

        let Some(track) = &self.current else { return };
        let _ = self.state_tx.send(StateUpdate::Position(PositionUpdate {
            track: track.info.handle,
            samples_played: self.player.position_samples(),
            sample_rate: track.info.sample_rate,
            channels: track.info.channels,
        }));
    }

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
        self.player.stop();
        self.current = None;
        self.next_path = None;
        self.set_state(PlaybackState::Stopped);
    }
}

/// Compute effective ReplayGain attenuation (always <= 1.0).
/// Strategy: RG 2.0 Track mode + clip prevention + ISP margin.
fn compute_rg_gain(info: &TrackInfo) -> f64 {
    match (info.track_gain_db, info.track_peak) {
        (Some(gain_db), Some(peak)) => {
            let base = 10.0_f64.powf(f64::from(gain_db) / 20.0);
            let capped = if base * f64::from(peak) > 1.0 {
                0.98 / f64::from(peak)
            } else {
                base
            };
            // -1 dB ISP safety margin
            (capped * 0.891).min(1.0)
        }
        (Some(gain_db), None) => {
            let base = 10.0_f64.powf(f64::from(gain_db) / 20.0);
            (base * 0.891).min(1.0)
        }
        _ => {
            // No RG tags: -3 dB fallback for hi-res, unity for 16-bit
            if info.bit_depth.unwrap_or(16) > 16 {
                0.7079
            } else {
                1.0
            }
        }
    }
}

/// Extract track metadata using symphonia (GStreamer handles decode, but
/// we still need metadata upfront for the UI).
fn extract_track_info(handle: TrackHandle, path: &std::path::Path) -> Result<TrackInfo, EngineError> {
    use crate::decoder::FlacDecoder;
    let decoder = FlacDecoder::open(handle, path)?;
    Ok(decoder.info().clone())
}
