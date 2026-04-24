//! CLI for validating the audio engine end-to-end.
//!
//! Loads one or more FLAC files into the engine, drives the state machine,
//! and prints a progress bar to stderr. Useful as a smoke test when a Tauri
//! UI is not available.
//!
//! ```text
//! $ cargo run --example play_file --release -- path/to/track.flac
//! ```

use std::collections::VecDeque;
use std::error::Error;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use audio_engine::types::TrackInfo;
use audio_engine::{Command, Engine, EngineHandle, PlaybackState, PositionUpdate, StateUpdate};
use clap::Parser;
use tracing_subscriber::EnvFilter;

/// Width in characters of the progress bar rendered on stderr.
const PROGRESS_BAR_WIDTH: usize = 20;

/// Poll interval for the main event loop. We block on a channel recv with
/// this timeout so progress updates stay responsive even when the engine is
/// quiet.
const RECV_TIMEOUT: Duration = Duration::from_millis(100);

/// Grace period granted to the engine thread after `Shutdown`.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(250);

#[derive(Parser, Debug)]
#[command(
    name = "play_file",
    about = "Validate the audio-engine by playing FLAC files"
)]
struct Args {
    /// Files to play (at least one). Multiple files are enqueued for gapless
    /// playback.
    files: Vec<PathBuf>,

    /// Volume 0.0..=1.0 (default 1.0).
    #[arg(long, default_value_t = 1.0)]
    volume: f32,

    /// Log level: error, warn, info, debug, trace (default: info).
    #[arg(long, default_value = "info")]
    log_level: String,

    /// Maximum seconds to play before exiting (for smoke tests). 0 = no limit.
    #[arg(long, default_value_t = 0u64)]
    max_seconds: u64,
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();
    init_tracing(&args.log_level);

    if args.files.is_empty() {
        return Err("provide at least one file".into());
    }

    for file in &args.files {
        if !file.is_file() {
            return Err(format!("file not found: {}", file.display()).into());
        }
    }

    let engine = Engine::start()?;
    let updates = engine.subscribe();

    engine.send(Command::SetVolume(args.volume.clamp(0.0, 1.0)))?;

    // Queue controller: spawns a small helper thread that enqueues next
    // tracks as earlier ones end, so the engine sees at most one `EnqueueNext`
    // in flight at a time.
    let queue = QueueController::spawn(engine.clone(), args.files.clone());

    engine.send(Command::Load(args.files[0].clone()))?;

    let exit_code = run_loop(&engine, &updates, &args, &queue);

    let _ = engine.send(Command::Shutdown);
    thread::sleep(SHUTDOWN_GRACE);

    if exit_code != 0 {
        std::process::exit(exit_code);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

/// Returns a process exit code. 0 = clean exit, 1 = engine error or device
/// failure, 2 = max_seconds reached.
fn run_loop(
    engine: &EngineHandle,
    updates: &crossbeam_channel::Receiver<StateUpdate>,
    args: &Args,
    queue: &QueueController,
) -> i32 {
    let started = Instant::now();
    let max_duration = (args.max_seconds > 0).then(|| Duration::from_secs(args.max_seconds));

    let mut current_info: Option<TrackInfo> = None;
    let mut last_position: Option<PositionUpdate> = None;
    let mut xruns: u64 = 0;
    let mut loaded_first = false;
    let mut playing_started = false;
    let mut progress_dirty = false;
    let mut last_render = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);

    loop {
        if let Some(limit) = max_duration {
            if started.elapsed() >= limit {
                finish_line();
                eprintln!("[play_file] reached --max-seconds={}", args.max_seconds);
                return 2;
            }
        }

        match updates.recv_timeout(RECV_TIMEOUT) {
            Ok(update) => match update {
                StateUpdate::StateChanged(state) => match state {
                    PlaybackState::Paused { .. } if !loaded_first => {
                        loaded_first = true;
                        if let Err(err) = engine.send(Command::Play) {
                            eprintln!("[play_file] failed to send Play: {err}");
                            return 1;
                        }
                    }
                    PlaybackState::Playing { .. } => {
                        playing_started = true;
                    }
                    PlaybackState::Stopped => {
                        if playing_started && queue.is_empty() {
                            finish_line();
                            return 0;
                        }
                    }
                    PlaybackState::Error { message, .. } => {
                        finish_line();
                        eprintln!("[play_file] engine error: {message}");
                        return 1;
                    }
                    _ => {}
                },
                StateUpdate::Position(pos) => {
                    last_position = Some(pos);
                    progress_dirty = true;
                }
                StateUpdate::TrackStarted(info) => {
                    if current_info.is_some() {
                        finish_line();
                    }
                    eprintln!(
                        "[play_file] track started: {} ({} Hz, {} ch)",
                        info.path.display(),
                        info.sample_rate,
                        info.channels
                    );
                    current_info = Some(info);
                    last_position = None;
                    progress_dirty = true;
                }
                StateUpdate::TrackEnded(_handle) => {
                    if let Some(path) = queue.pop_next() {
                        if let Err(err) = engine.send(Command::EnqueueNext(path)) {
                            eprintln!("[play_file] failed to enqueue next: {err}");
                            return 1;
                        }
                    }
                }
                StateUpdate::Xrun { total } => {
                    xruns = total;
                    progress_dirty = true;
                }
                StateUpdate::Error(msg) => {
                    finish_line();
                    eprintln!("[play_file] error: {msg}");
                    return 1;
                }
                StateUpdate::DeviceDisconnected => {
                    finish_line();
                    eprintln!("[play_file] output device disconnected");
                    return 1;
                }
                StateUpdate::VolumeChanged(_) => {}
            },
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                finish_line();
                eprintln!("[play_file] engine channel disconnected");
                return 1;
            }
        }

        // Throttle rendering to ~20 Hz so we don't flood the terminal even
        // if position updates arrive faster.
        if progress_dirty && last_render.elapsed() >= Duration::from_millis(50) {
            if let Some(info) = &current_info {
                render_progress(info, last_position.as_ref(), xruns);
            }
            last_render = Instant::now();
            progress_dirty = false;
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn render_progress(info: &TrackInfo, pos: Option<&PositionUpdate>, xruns: u64) {
    let total_secs: f64 = info.duration.map_or(0.0, |d| d.as_secs_f64());
    let current_secs = pos.map_or(0.0_f64, PositionUpdate::seconds);

    let ratio = if total_secs > 0.0 {
        (current_secs / total_secs).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let filled = (ratio * PROGRESS_BAR_WIDTH as f64).round() as usize;
    let filled = filled.min(PROGRESS_BAR_WIDTH);
    let mut bar = String::with_capacity(PROGRESS_BAR_WIDTH * 3);
    for _ in 0..filled {
        bar.push('\u{2588}'); // full block
    }
    for _ in filled..PROGRESS_BAR_WIDTH {
        bar.push('\u{2591}'); // light shade
    }

    let sr = pos.map_or(info.sample_rate, |p| p.sample_rate);
    let ch = pos.map_or(info.channels, |p| p.channels);
    let line = format!(
        "\r{cur} / {tot}  {bar}  xruns={xruns}  sr={sr} ch={ch}",
        cur = format_time(current_secs),
        tot = format_time(total_secs),
    );

    let mut stderr = io::stderr().lock();
    let _ = stderr.write_all(line.as_bytes());
    // Pad with spaces to clear any leftover from a longer previous line.
    let _ = stderr.write_all(b"    ");
    let _ = stderr.flush();
}

fn finish_line() {
    let mut stderr = io::stderr().lock();
    let _ = stderr.write_all(b"\n");
    let _ = stderr.flush();
}

fn format_time(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "--:--".to_string();
    }
    let total = seconds as u64;
    let mm = total / 60;
    let ss = total % 60;
    format!("{mm:02}:{ss:02}")
}

// ---------------------------------------------------------------------------
// Queue controller
// ---------------------------------------------------------------------------

/// Manages sequential `EnqueueNext` calls so the engine always has at most one
/// pending next track. Enqueues file #2 shortly after load, then enqueues
/// file #3 once file #1's `TrackEnded` fires, and so on.
struct QueueController {
    pending: Arc<Mutex<VecDeque<PathBuf>>>,
}

impl QueueController {
    fn spawn(engine: EngineHandle, mut files: Vec<PathBuf>) -> Self {
        // The first file is driven by the main loop via `Load`. Everything
        // after that gets queued sequentially.
        if files.is_empty() {
            return Self {
                pending: Arc::new(Mutex::new(VecDeque::new())),
            };
        }
        files.remove(0);
        let pending: Arc<Mutex<VecDeque<PathBuf>>> = Arc::new(Mutex::new(VecDeque::from(files)));

        // If we have a second file, enqueue it after a short delay to let the
        // engine finish preparing the first track first.
        let pending_thread = pending.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            let next = pending_thread.lock().ok().and_then(|mut q| q.pop_front());
            if let Some(path) = next {
                let _ = engine.send(Command::EnqueueNext(path));
            }
        });

        Self { pending }
    }

    /// Pop the next queued file, if any. Called by the main loop whenever a
    /// `TrackEnded` event arrives.
    fn pop_next(&self) -> Option<PathBuf> {
        self.pending.lock().ok().and_then(|mut q| q.pop_front())
    }

    fn is_empty(&self) -> bool {
        self.pending.lock().map(|q| q.is_empty()).unwrap_or(true)
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

fn init_tracing(level: &str) {
    let filter = EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .try_init();
}
