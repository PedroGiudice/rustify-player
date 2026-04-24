//! Native PipeWire implementation of [`AudioOutput`].
//!
//! Architecture
//! ------------
//!
//! The engine thread never touches libpipewire directly. Instead each call to
//! [`PipewireBackend::configure`] spawns a dedicated OS thread that owns the
//! entire pipewire object graph (`MainLoopRc` → `ContextRc` → `Core` →
//! `StreamBox`). These types are not `Send`, so everything must be created and
//! dropped on the same thread.
//!
//! Communication crosses the thread boundary through three channels:
//!
//! - `rtrb::RingBuffer<f32>` (SPSC): decoded samples flow from the engine to
//!   the realtime `process` callback. Zero allocation, zero locking.
//! - `pipewire::channel` (custom, fd-backed): control-plane commands (just
//!   `Shutdown` for now). The `Receiver` is `attach`ed to the mainloop so the
//!   loop wakes up on each message.
//! - `std::sync::mpsc::sync_channel` (bootstrap): the spawned thread reports
//!   its setup result back synchronously so `configure()` can surface errors
//!   before the stream starts running.
//!
//! Routing is always AUTOCONNECT with `MEDIA_ROLE=Music`: wireplumber sends
//! the stream to the user's default sink, which on the target setup goes
//! through EasyEffects automatically. No device picker, no bit-perfect mode.

use std::any::Any;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use pipewire as pw;
use pw::spa;
use pw::stream::StreamFlags;
use rtrb::{Consumer, RingBuffer};
use spa::pod::Pod;

use super::{ActiveStream, AudioOutput};
use crate::error::OutputError;
use crate::types::{SampleFormat, StreamFormat};

/// Ring buffer target: ~500 ms of samples at the negotiated rate. Matches the
/// previous cpal backend for consistency.
const RING_BUFFER_MS: u32 = 1500;

/// Minimum ring buffer size in samples. Guards against tiny buffers at low
/// sample rates that would underrun immediately. 8192 samples = 4096 frames
/// at stereo, giving ~85ms of headroom at 48 kHz even under scheduler jitter.
const MIN_RING_SAMPLES: usize = 8192;

/// Timeout for the bootstrap handshake. If pipewire takes longer than this to
/// come up, something is wrong (daemon down, broken env) and we give up.
const BOOT_TIMEOUT: Duration = Duration::from_secs(3);

/// Control-plane command sent from the engine thread to the mainloop thread.
enum Cmd {
    Shutdown,
    Cork,
    Uncork,
}

/// Shared data accessed by the realtime `process` callback.
///
/// `Consumer` and the atomics/mutex are moved into the pipewire mainloop
/// thread and owned by the listener closure through
/// `add_local_listener_with_user_data`. They never cross threads after that.
struct UserData {
    consumer: Consumer<f32>,
    xruns: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    logged_buffer_sizes: bool,
    last_error: Arc<Mutex<Option<OutputError>>>,
    actual_format: Arc<Mutex<Option<StreamFormat>>>,
    requested_format: StreamFormat,
}

/// Keepalive guard stored inside `ActiveStream::_keepalive`.
///
/// Dropping this sends `Shutdown` to the mainloop and joins the thread, which
/// tears the stream down cleanly. The `JoinHandle` is wrapped in `Option` so
/// `Drop` can `take()` it.
struct PipewireStreamGuard {
    thread: Option<JoinHandle<()>>,
    cmd_tx: pw::channel::Sender<Cmd>,
}

impl Drop for PipewireStreamGuard {
    fn drop(&mut self) {
        // Best effort: if the receiver is already gone the loop has exited.
        let _ = self.cmd_tx.send(Cmd::Shutdown);
        if let Some(handle) = self.thread.take() {
            if let Err(err) = handle.join() {
                tracing::error!(?err, "pipewire mainloop thread panicked on shutdown");
            }
        }
    }
}

// SAFETY: We never deref `cmd_tx` or `thread` across threads in a way that
// violates libpipewire's threading rules. The `Sender` wraps an `Arc<Mutex<_>>`
// internally (see `pipewire::channel`) and is already `Send`. `JoinHandle` is
// `Send`. The guard itself only needs to be `Send` to satisfy the
// `Box<dyn Any + Send>` type bound on `ActiveStream::_keepalive`.
unsafe impl Send for PipewireStreamGuard {}

pub struct PipewireBackend {
    xruns: Arc<AtomicU64>,
}

impl Default for PipewireBackend {
    fn default() -> Self {
        Self {
            xruns: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl PipewireBackend {
    pub fn new() -> Self {
        Self::default()
    }
}

impl AudioOutput for PipewireBackend {
    fn configure(&mut self, format: StreamFormat) -> Result<ActiveStream, OutputError> {
        debug_assert!(matches!(format.sample_format, SampleFormat::F32));

        // Sample count for ~500 ms at the negotiated rate/channel count.
        let ring_samples = (u64::from(format.sample_rate))
            .saturating_mul(u64::from(format.source_channels))
            .saturating_mul(u64::from(RING_BUFFER_MS))
            / 1000;
        let ring_samples = (ring_samples as usize).max(MIN_RING_SAMPLES);

        let (producer, consumer) = RingBuffer::<f32>::new(ring_samples);

        let alive = Arc::new(AtomicBool::new(true));
        let last_error = Arc::new(Mutex::new(None::<OutputError>));
        let actual_format = Arc::new(Mutex::new(None::<StreamFormat>));

        let (boot_tx, boot_rx) = sync_channel::<Result<(), OutputError>>(0);
        let (cmd_tx, cmd_rx) = pw::channel::channel::<Cmd>();

        let thread_xruns = self.xruns.clone();
        let thread_alive = alive.clone();
        let thread_err = last_error.clone();
        let thread_actual = actual_format.clone();

        let thread = thread::Builder::new()
            .name("pipewire-mainloop".to_string())
            .spawn(move || {
                run_mainloop(
                    format,
                    consumer,
                    thread_xruns,
                    thread_alive,
                    thread_err,
                    thread_actual,
                    cmd_rx,
                    boot_tx,
                );
            })
            .map_err(|err| OutputError::PipewireInit(err.to_string()))?;

        // Wait for the bootstrap handshake. If the mainloop thread fails to
        // set up the stream, it reports the error before starting the loop.
        match boot_rx.recv_timeout(BOOT_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                // Thread will exit on its own after sending the error.
                let _ = thread.join();
                return Err(err);
            }
            Err(_) => {
                // Timeout or sender dropped. Try to shut the thread down.
                let _ = cmd_tx.send(Cmd::Shutdown);
                let _ = thread.join();
                return Err(OutputError::PipewireInit(
                    "timed out waiting for pipewire stream to come up".to_string(),
                ));
            }
        }

        // `param_changed` may not have fired yet; surface the requested format
        // so the engine has something to work with. If the daemon later
        // negotiates a different rate, the engine will see an xrun rather
        // than a pitch shift, and we log it from `param_changed`.
        let advertised = actual_format
            .lock()
            .ok()
            .and_then(|slot| *slot)
            .unwrap_or(format);

        let cork_tx = cmd_tx.clone();
        Ok(ActiveStream {
            producer,
            actual_format: advertised,
            alive,
            last_error,
            _keepalive: Box::new(PipewireStreamGuard {
                thread: Some(thread),
                cmd_tx,
            }) as Box<dyn Any + Send>,
            set_cork: Some(Box::new(move |cork: bool| {
                let _ = cork_tx.send(if cork { Cmd::Cork } else { Cmd::Uncork });
            })),
        })
    }

    fn stop(&mut self) {
        // Streams live inside `ActiveStream::_keepalive`; dropping that value
        // signals the mainloop to quit and joins the thread. Nothing to do
        // here.
    }

    fn xrun_count(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }
}

/// Entry point for the pipewire mainloop thread. Sets up the graph, reports
/// success/failure through `boot_tx`, then blocks in `mainloop.run()` until a
/// `Cmd::Shutdown` is received.
#[allow(clippy::too_many_arguments)]
fn run_mainloop(
    format: StreamFormat,
    consumer: Consumer<f32>,
    xruns: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<OutputError>>>,
    actual_format: Arc<Mutex<Option<StreamFormat>>>,
    cmd_rx: pw::channel::Receiver<Cmd>,
    boot_tx: SyncSender<Result<(), OutputError>>,
) {
    pw::init();

    let user_data = UserData {
        consumer,
        xruns: xruns.clone(),
        alive: alive.clone(),
        last_error: last_error.clone(),
        actual_format: actual_format.clone(),
        requested_format: format,
        logged_buffer_sizes: false,
    };

    // Build the object graph. Any failure here is reported through boot_tx
    // and the thread exits without running the loop.
    let mainloop = match pw::main_loop::MainLoopRc::new(None) {
        Ok(ml) => ml,
        Err(err) => {
            let _ = boot_tx.send(Err(OutputError::PipewireInit(err.to_string())));
            return;
        }
    };

    let context = match pw::context::ContextRc::new(&mainloop, None) {
        Ok(ctx) => ctx,
        Err(err) => {
            let _ = boot_tx.send(Err(OutputError::PipewireInit(err.to_string())));
            return;
        }
    };

    let core = match context.connect_rc(None) {
        Ok(c) => c,
        Err(err) => {
            let _ = boot_tx.send(Err(OutputError::PipewireInit(err.to_string())));
            return;
        }
    };

    // Request explicit latency to prevent PipeWire from allocating huge
    // buffers that don't align with sink quantum. Without this hint, a
    // 44.1kHz stream into a 96kHz/8192-quantum sink gets ~170ms buffers,
    // double the sink tick — causing timing artifacts that sound like
    // crackling even with clean sample data. 1024 frames at source rate
    // matches what mpv/pulseaudio-compat apps negotiate by default.
    let latency = format!("1024/{}", format.sample_rate);
    let rate = format!("1/{}", format.sample_rate);
    let mut props = pw::properties::PropertiesBox::new();
    props.insert(*pw::keys::APP_NAME, "rustify-player");
    props.insert(*pw::keys::NODE_NAME, "rustify-player");
    props.insert(*pw::keys::MEDIA_TYPE, "Audio");
    props.insert(*pw::keys::MEDIA_CATEGORY, "Playback");
    props.insert(*pw::keys::MEDIA_ROLE, "Music");
    props.insert(*pw::keys::NODE_LATENCY, latency.as_str());
    props.insert("node.rate", rate.as_str());

    let stream = match pw::stream::StreamBox::new(&core, "rustify-player", props) {
        Ok(s) => s,
        Err(err) => {
            let _ = boot_tx.send(Err(OutputError::PipewireInit(err.to_string())));
            return;
        }
    };

    // Grab the raw pointer before the borrow-checker ties it to local
    // lifetimes. The `cmd_rx.attach` closure requires `'static`, but the
    // stream outlives the mainloop — so dereferencing is safe inside any
    // callback attached to this loop.
    let raw_stream: *mut pw::sys::pw_stream = stream.as_raw_ptr();

    // Listener must outlive `mainloop.run()`. Keep it in scope until the end
    // of this function.
    let _listener = stream
        .add_local_listener_with_user_data(user_data)
        .param_changed(|_stream, user_data, id, param| {
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Some(param) = param else {
                return;
            };

            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param)
            else {
                return;
            };

            if media_type != spa::param::format::MediaType::Audio
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }

            let mut info = spa::param::audio::AudioInfoRaw::new();
            if info.parse(param).is_err() {
                return;
            }

            let actual = StreamFormat {
                sample_rate: info.rate(),
                source_channels: info.channels() as u16,
                output_channels: info.channels() as u16,
                sample_format: SampleFormat::F32,
            };

            if actual.sample_rate != user_data.requested_format.sample_rate {
                tracing::warn!(
                    requested = user_data.requested_format.sample_rate,
                    actual = actual.sample_rate,
                    "pipewire negotiated a different sample rate than requested"
                );
            } else {
                tracing::info!(
                    rate = actual.sample_rate,
                    channels = actual.output_channels,
                    "pipewire stream format negotiated"
                );
            }

            if let Ok(mut slot) = user_data.actual_format.lock() {
                *slot = Some(actual);
            }
        })
        .state_changed(|_stream, user_data, old, new| {
            tracing::debug!(?old, ?new, "pipewire stream state changed");
            if matches!(new, pw::stream::StreamState::Error(_) | pw::stream::StreamState::Unconnected) {
                // Treat error/unconnected as a disconnect from the engine's
                // perspective so it can recover.
                user_data.alive.store(false, Ordering::Release);
                if let pw::stream::StreamState::Error(msg) = new {
                    if let Ok(mut slot) = user_data.last_error.lock() {
                        *slot = Some(OutputError::PipewireStream(msg.clone()));
                    }
                }
            }
        })
        .process(|stream, user_data| {
            // Realtime callback. No allocations, no locks (atomics only).
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let data = &mut datas[0];

            let channels = usize::from(user_data.requested_format.output_channels.max(1));
            let stride = channels * std::mem::size_of::<f32>();

            // Read chunk hint BEFORE taking the mutable borrow on data.
            // chunk.size() may indicate the quantum size PipeWire wants.
            let chunk_hint = data.chunk().size() as usize;

            let Some(slice) = data.data() else {
                return;
            };
            // Log buffer geometry once per stream for diagnostics.
            if !user_data.logged_buffer_sizes {
                user_data.logged_buffer_sizes = true;
                tracing::info!(
                    maxsize = slice.len(),
                    chunk_hint,
                    channels,
                    stride,
                    "pipewire process: buffer geometry (first callback)"
                );
            }

            let target_bytes = if chunk_hint > 0 && chunk_hint <= slice.len() {
                chunk_hint
            } else {
                slice.len()
            };

            let target_frames = target_bytes / stride;
            let target_samples = target_frames * channels;

            let usable_bytes = target_samples * std::mem::size_of::<f32>();
            let (f32_slice, _tail) = slice[..usable_bytes]
                .as_chunks_mut_layout();

            let written = fill_f32_from_ring(f32_slice, &mut user_data.consumer);

            // Kept for diagnostics: sample integrity check on first batch.
            #[cfg(debug_assertions)]
            if written > 0 {
                static CHECKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
                if !CHECKED.load(Ordering::Relaxed) {
                    CHECKED.store(true, Ordering::Relaxed);
                    let mut nan_count = 0u32;
                    let mut inf_count = 0u32;
                    let mut clip_count = 0u32;
                    let mut max_abs: f32 = 0.0;
                    for &s in &f32_slice[..written] {
                        if s.is_nan() { nan_count += 1; }
                        else if s.is_infinite() { inf_count += 1; }
                        else {
                            let a = s.abs();
                            if a > 1.0 { clip_count += 1; }
                            if a > max_abs { max_abs = a; }
                        }
                    }
                    tracing::info!(
                        written,
                        nan_count,
                        inf_count,
                        clip_count,
                        max_abs,
                        "pipewire process: sample integrity check"
                    );
                }
            }

            if written < f32_slice.len() {
                // Underrun: pad silence, bump counter.
                let missing = f32_slice.len() - written;
                for s in &mut f32_slice[written..] {
                    *s = 0.0;
                }
                let prev = user_data.xruns.fetch_add(1, Ordering::Relaxed);
                if prev == 0 {
                    tracing::warn!(
                        missing_samples = missing,
                        requested = f32_slice.len(),
                        got = written,
                        "pipewire underrun: ring buffer starved (first of burst)"
                    );
                }
            }

            let chunk = data.chunk_mut();
            *chunk.offset_mut() = 0;
            *chunk.stride_mut() = stride as i32;
            *chunk.size_mut() = (target_frames * stride) as u32;
        })
        .register();

    let _listener = match _listener {
        Ok(l) => l,
        Err(err) => {
            let _ = boot_tx.send(Err(OutputError::PipewireInit(err.to_string())));
            return;
        }
    };

    // Build the EnumFormat POD describing what we want to send.
    let mut audio_info = spa::param::audio::AudioInfoRaw::new();
    audio_info.set_format(spa::param::audio::AudioFormat::F32LE);
    audio_info.set_rate(format.sample_rate);
    audio_info.set_channels(u32::from(format.source_channels));

    let pod_bytes = match spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(spa::pod::Object {
            type_: spa::sys::SPA_TYPE_OBJECT_Format,
            id: spa::sys::SPA_PARAM_EnumFormat,
            properties: audio_info.into(),
        }),
    ) {
        Ok((cursor, _)) => cursor.into_inner(),
        Err(err) => {
            let _ = boot_tx.send(Err(OutputError::PipewireInit(format!(
                "failed to serialize format POD: {err}"
            ))));
            return;
        }
    };

    let Some(format_pod) = Pod::from_bytes(&pod_bytes) else {
        let _ = boot_tx.send(Err(OutputError::PipewireInit(
            "failed to wrap format POD bytes".to_string(),
        )));
        return;
    };

    let mut params = [format_pod];

    if let Err(err) = stream.connect(
        spa::utils::Direction::Output,
        None,
        StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS | StreamFlags::INACTIVE,
        &mut params,
    ) {
        let _ = boot_tx.send(Err(OutputError::PipewireInit(err.to_string())));
        return;
    }

    // Attach the command receiver to the loop so we can react to commands.
    let mainloop_weak = mainloop.downgrade();
    let _cmd_attached = cmd_rx.attach(mainloop.loop_(), move |cmd| match cmd {
        Cmd::Shutdown => {
            if let Some(ml) = mainloop_weak.upgrade() {
                ml.quit();
            }
        }
        Cmd::Cork => {
            // SAFETY: `raw_stream` points to the `StreamBox` declared above,
            // which outlives `mainloop.run()`. This closure is attached to the
            // same mainloop, so it cannot fire after the stream is dropped.
            unsafe { pw::sys::pw_stream_set_active(raw_stream, false) };
        }
        Cmd::Uncork => {
            // SAFETY: same as Cork.
            unsafe { pw::sys::pw_stream_set_active(raw_stream, true) };
        }
    });

    // All set — unblock the caller.
    let _ = boot_tx.send(Ok(()));

    mainloop.run();

    // After mainloop exits: mark stream as no longer alive so the engine
    // notices even if the drop order is odd. Scope-based drop order (reverse
    // of declaration) handles teardown: _cmd_attached → _listener → stream →
    // core → context → mainloop.
    alive.store(false, Ordering::Release);
}

/// Copy up to `out.len()` samples from `consumer` into `out`.
/// Returns the number of samples actually written.
fn fill_f32_from_ring(out: &mut [f32], consumer: &mut Consumer<f32>) -> usize {
    let available = consumer.slots();
    let to_read = available.min(out.len());
    if to_read == 0 {
        return 0;
    }
    match consumer.read_chunk(to_read) {
        Ok(chunk) => {
            let (a, b) = chunk.as_slices();
            out[..a.len()].copy_from_slice(a);
            if !b.is_empty() {
                out[a.len()..a.len() + b.len()].copy_from_slice(b);
            }
            let written = a.len() + b.len();
            chunk.commit_all();
            written
        }
        Err(_) => 0,
    }
}

/// Helper trait to reinterpret a `&mut [u8]` as `&mut [f32]` without going
/// through `bytemuck` (adding a dep for one call site is noise). Stable Rust
/// doesn't give us `as_chunks_mut` yet on 1.78, so do the pointer math here
/// with the safety invariants documented.
trait AsChunksMutLayout {
    /// Reinterpret `self` as a slice of `f32`s plus a tail of leftover bytes.
    ///
    /// # Safety
    /// PipeWire F32LE buffers are 4-byte aligned by contract. Callers MUST
    /// ensure the slice comes from `Buffer::data()`.
    fn as_chunks_mut_layout(&mut self) -> (&mut [f32], &mut [u8]);
}

impl AsChunksMutLayout for [u8] {
    fn as_chunks_mut_layout(&mut self) -> (&mut [f32], &mut [u8]) {
        let len = self.len();
        let whole = len / std::mem::size_of::<f32>();
        let whole_bytes = whole * std::mem::size_of::<f32>();
        let (head, tail) = self.split_at_mut(whole_bytes);
        // SAFETY: `head` is `whole * 4` bytes long; PipeWire gives us a
        // 4-byte-aligned buffer. Reinterpreting as `[f32]` is sound.
        let f32_slice = unsafe {
            std::slice::from_raw_parts_mut(head.as_mut_ptr().cast::<f32>(), whole)
        };
        (f32_slice, tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipewire_backend_constructs() {
        let backend = PipewireBackend::new();
        assert_eq!(backend.xrun_count(), 0);
    }
}
