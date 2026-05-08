//! PipeWire monitor capture + FFT processing for real-time spectrum data.
//!
//! Opens a PipeWire stream in capture mode targeting the app's own sink monitor
//! node. Audio samples flow through a lock-free ring buffer to a dedicated FFT
//! worker thread that produces 512 magnitude bins at ~60Hz.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use bytemuck;
use rustfft::{num_complex::Complex, FftPlanner};
use tracing::{debug, error, info};

/// Opaque handle returned by [`start`]. Stops all threads on drop.
pub struct PwCaptureHandle {
    running: Arc<AtomicBool>,
    pw_thread: Option<thread::JoinHandle<()>>,
    fft_thread: Option<thread::JoinHandle<()>>,
}

impl Drop for PwCaptureHandle {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(h) = self.fft_thread.take() {
            let _ = h.join();
        }
        // PW thread will quit its main loop when `running` goes false
        if let Some(h) = self.pw_thread.take() {
            let _ = h.join();
        }
    }
}

/// FFT window size — 2048 samples gives 1024 positive-frequency bins (~23Hz/bin at 48kHz).
const FFT_SIZE: usize = 2048;

/// Number of output magnitude bins (positive frequencies only).
const NUM_BINS: usize = FFT_SIZE / 2;

/// Ring buffer capacity in samples. ~100ms at 48kHz stereo downmixed to mono.
const RING_BUF_CAPACITY: usize = 8192;

/// Minimum dB threshold — values below this map to 0.
const DB_FLOOR: f32 = -80.0;

/// dB dynamic range mapped to 0..255.
const DB_RANGE: f32 = 80.0;

/// Start PipeWire capture targeting `target_node` and write FFT magnitudes
/// into `spectrum_buf`.
///
/// Returns `None` if the PipeWire thread fails to spawn.
pub fn start(
    target_node: &str,
    spectrum_buf: Arc<Mutex<(u64, Vec<u8>)>>,
) -> Option<PwCaptureHandle> {
    let running = Arc::new(AtomicBool::new(true));

    // Lock-free SPSC ring buffer: PW RT thread produces, FFT thread consumes.
    let (producer, consumer) = rtrb::RingBuffer::<f32>::new(RING_BUF_CAPACITY);

    let running_pw = running.clone();
    let target = target_node.to_string();

    let pw_thread = thread::Builder::new()
        .name("pw-capture".into())
        .spawn(move || {
            if let Err(e) = pw_capture_loop(&target, producer, running_pw) {
                error!("PipeWire capture loop failed: {e}");
            }
        })
        .ok()?;

    let running_fft = running.clone();

    let fft_thread = thread::Builder::new()
        .name("fft-worker".into())
        .spawn(move || {
            fft_worker_loop(consumer, spectrum_buf, running_fft);
        })
        .ok()?;

    Some(PwCaptureHandle {
        running,
        pw_thread: Some(pw_thread),
        fft_thread: Some(fft_thread),
    })
}

/// Precomputed Hanning window coefficients for FFT_SIZE samples.
fn hanning_window() -> Vec<f32> {
    (0..FFT_SIZE)
        .map(|i| {
            // w(n) = 0.5 * (1 - cos(2*pi*n / (N-1)))
            let phase = 2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32;
            0.5 * (1.0 - phase.cos())
        })
        .collect()
}

// ─── PipeWire Capture Thread ─────────────────────────────────────────────────

fn pw_capture_loop(
    target_node: &str,
    producer: rtrb::Producer<f32>,
    running: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    pipewire::init();

    let mainloop = pipewire::main_loop::MainLoopRc::new(None)?;
    let context = pipewire::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_rc(None)?;

    let props = pipewire::properties::properties! {
        *pipewire::keys::MEDIA_TYPE => "Audio",
        *pipewire::keys::MEDIA_CATEGORY => "Capture",
        *pipewire::keys::MEDIA_ROLE => "DSP",
        *pipewire::keys::STREAM_CAPTURE_SINK => "true",
        *pipewire::keys::NODE_NAME => "rustify-spectrum-capture",
    };
    // No target.object — STREAM_CAPTURE_SINK auto-connects to the default
    // sink monitor (captures everything going to speakers, like EasyEffects).
    let _ = target_node; // kept for future per-node targeting

    let stream = pipewire::stream::StreamBox::new(&core, "rustify-spectrum-capture", props)?;

    // User data passed into callbacks — the producer half of the ring buffer.
    struct CaptureData {
        producer: rtrb::Producer<f32>,
        channels: u32,
    }

    let data = CaptureData {
        producer,
        channels: 0,
    };

    // Register stream listener with process + param_changed callbacks.
    let _listener = stream
        .add_local_listener_with_user_data(data)
        .param_changed(|_stream, user_data, id, param| {
            let Some(param) = param else { return };
            if id != pipewire::spa::param::ParamType::Format.as_raw() {
                return;
            }

            let (media_type, media_subtype) =
                match pipewire::spa::param::format_utils::parse_format(param) {
                    Ok(v) => v,
                    Err(_) => return,
                };

            if media_type != pipewire::spa::param::format::MediaType::Audio
                || media_subtype != pipewire::spa::param::format::MediaSubtype::Raw
            {
                return;
            }

            let mut info = pipewire::spa::param::audio::AudioInfoRaw::new();
            if info.parse(param).is_ok() {
                user_data.channels = info.channels();
                debug!(
                    "PW capture negotiated: rate={} channels={}",
                    info.rate(),
                    info.channels()
                );
            }
        })
        .process(|stream, user_data| {
            // RT callback — NO allocations, NO blocking, NO mutex.
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };

            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }

            let data = &mut datas[0];
            let chunk_size = data.chunk().size() as usize;
            if chunk_size == 0 {
                return;
            }

            let Some(raw_bytes) = data.data() else {
                return;
            };

            // Only use the valid portion indicated by chunk size.
            let valid_bytes = &raw_bytes[..chunk_size.min(raw_bytes.len())];

            // Reinterpret as f32 samples (F32LE format).
            let samples: &[f32] = bytemuck::cast_slice(valid_bytes);

            let channels = user_data.channels.max(1) as usize;

            // Downmix to mono and push into ring buffer (drop if full — no blocking).
            if channels == 1 {
                for &s in samples {
                    let _ = user_data.producer.push(s);
                }
            } else {
                // Mix N channels into mono by averaging.
                for frame in samples.chunks_exact(channels) {
                    let mono: f32 = frame.iter().sum::<f32>() / channels as f32;
                    let _ = user_data.producer.push(mono);
                }
            }
        })
        .register()?;

    // Build format param: accept F32LE, any rate, any channels.
    let mut audio_info = pipewire::spa::param::audio::AudioInfoRaw::new();
    audio_info.set_format(pipewire::spa::param::audio::AudioFormat::F32LE);

    let obj = pipewire::spa::pod::Object {
        type_: pipewire::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: pipewire::spa::param::ParamType::EnumFormat.as_raw(),
        properties: audio_info.into(),
    };

    let values: Vec<u8> = pipewire::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pipewire::spa::pod::Value::Object(obj),
    )
    .map_err(|_| "Failed to serialize audio format pod")?
    .0
    .into_inner();

    let mut params = [pipewire::spa::pod::Pod::from_bytes(&values)
        .ok_or("Failed to create Pod from serialized bytes")?];

    stream.connect(
        pipewire::spa::utils::Direction::Input,
        None,
        pipewire::stream::StreamFlags::AUTOCONNECT
            | pipewire::stream::StreamFlags::MAP_BUFFERS
            | pipewire::stream::StreamFlags::RT_PROCESS,
        &mut params,
    )?;

    info!("PipeWire capture stream connected, targeting '{target_node}'");

    // Poll `running` flag via a timer on the main loop.
    // The mainloop will quit when the flag goes false.
    let mainloop_weak = mainloop.downgrade();
    let timer_running = running.clone();
    let the_loop = mainloop.loop_();
    let timer_source = the_loop.add_timer(move |_expirations| {
        if !timer_running.load(Ordering::Relaxed) {
            if let Some(ml) = mainloop_weak.upgrade() {
                ml.quit();
            }
        }
    });
    // Fire the timer every 100ms to check the running flag.
    timer_source.update_timer(
        Some(Duration::from_millis(100)),
        Some(Duration::from_millis(100)),
    );

    mainloop.run();
    info!("PipeWire capture loop exited");

    Ok(())
}

// ─── FFT Worker Thread ───────────────────────────────────────────────────────

fn fft_worker_loop(
    mut consumer: rtrb::Consumer<f32>,
    spectrum_buf: Arc<Mutex<(u64, Vec<u8>)>>,
    running: Arc<AtomicBool>,
) {
    let window = hanning_window();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    // Accumulation buffer for incoming samples.
    let mut accum: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    // Scratch buffer for FFT input (complex).
    let mut fft_input: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); FFT_SIZE];
    // Output magnitudes.
    let mut magnitudes: Vec<u8> = vec![0u8; NUM_BINS];

    while running.load(Ordering::Relaxed) {
        // Sleep ~16ms for ~60Hz refresh rate.
        thread::sleep(Duration::from_millis(16));

        // Drain all available samples from ring buffer into accumulator.
        while let Ok(sample) = consumer.pop() {
            accum.push(sample);
        }

        // Need at least FFT_SIZE samples to run a transform.
        if accum.len() < FFT_SIZE {
            continue;
        }

        // Use the most recent FFT_SIZE samples (discard older ones).
        let start = accum.len() - FFT_SIZE;
        let frame = &accum[start..];

        // Apply Hanning window and convert to complex.
        for (i, (&sample, &w)) in frame.iter().zip(window.iter()).enumerate() {
            fft_input[i] = Complex::new(sample * w, 0.0);
        }

        // Keep only the tail to avoid unbounded growth, but retain
        // some overlap for the next frame.
        if accum.len() > FFT_SIZE * 4 {
            accum.drain(..accum.len() - FFT_SIZE);
        }

        // Run FFT in-place.
        fft.process(&mut fft_input);

        // Compute magnitude in dB for first 512 bins (positive frequencies).
        // Normalize: FFT_SIZE factor, then 20*log10(magnitude).
        let norm = 1.0 / FFT_SIZE as f32;
        for (i, bin) in fft_input[..NUM_BINS].iter().enumerate() {
            let mag = (bin.re * bin.re + bin.im * bin.im).sqrt() * norm;
            // Convert to dB. Clamp to avoid log10(0).
            let db = if mag > 1e-10 {
                20.0 * mag.log10()
            } else {
                DB_FLOOR
            };
            // Map [DB_FLOOR, 0] -> [0, 255]
            let normalized = ((db - DB_FLOOR) / DB_RANGE).clamp(0.0, 1.0);
            magnitudes[i] = (normalized * 255.0) as u8;
        }

        // Write to shared buffer. Timestamp 0 = render immediately.
        if let Ok(mut guard) = spectrum_buf.lock() {
            guard.0 = 0;
            guard.1.clear();
            guard.1.extend_from_slice(&magnitudes);
        }
    }

    debug!("FFT worker thread exited");
}
