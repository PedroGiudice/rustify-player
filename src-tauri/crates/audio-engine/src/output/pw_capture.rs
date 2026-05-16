//! PipeWire monitor capture + FFT processing for real-time spectrum data.
//!
//! Opens a PipeWire stream in capture mode targeting the app's own sink monitor
//! node. Audio samples flow through a lock-free ring buffer to a dedicated FFT
//! worker thread that produces 512 magnitude bins at ~60Hz.
//!
//! Also computes two envelope-tracked signals used by the Now Playing
//! beat-sync visualizer (see docs/.../design_handoff_signal_screens):
//!
//! - `low_band_mag`: magnitude média do range 20–150 Hz, com envelope follower
//!   one-pole IIR (attack ~5 ms, release ~100 ms). Mapeada para 0..1.
//! - `rms_energy`: soma slow-averaged (lowpass ~2 Hz) de todas as bands.
//!   Mapeada para 0..1.
//!
//! Ambos vivem num buffer compartilhado separado do `spectrum_buf` (que
//! continua sendo apenas os 512 bins em u8) para evitar mexer no payload
//! existente de `audio-fft` e nos consumidores atuais.

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

/// Fallback sample rate used to compute bin indices for the low-band envelope
/// when the PipeWire stream hasn't reported a negotiated rate yet.
const DEFAULT_SAMPLE_RATE: u32 = 48_000;

/// Tick period of the FFT worker — must match the sleep used in `fft_worker_loop`.
const FFT_TICK_MS: u32 = 16;

/// Envelope follower target time constants (in seconds).
const ENV_ATTACK_S: f32 = 0.005; // ~5 ms
const ENV_RELEASE_S: f32 = 0.100; // ~100 ms

/// RMS slow-average cutoff frequency (Hz). ~2 Hz => ~80 ms time constant.
const RMS_LOWPASS_HZ: f32 = 2.0;

/// Snapshot of the beat-sync envelopes (publicado pelo FFT worker, consumido
/// pelo spectrum-emitter na crate Tauri).
///
/// Ambos campos em range 0..1 e já com smoothing aplicado:
/// - `low_band_mag`: envelope follower do range 20–150 Hz (attack ~5 ms, release ~100 ms)
/// - `rms_energy`: RMS lowpass ~2 Hz sobre todas as bands
#[derive(Clone, Copy, Debug, Default)]
pub struct SpectrumEnvelope {
    pub low_band_mag: f32,
    pub rms_energy: f32,
}

/// Shared buffer type used to publish the envelope from the FFT worker.
pub type SharedEnvelope = Arc<Mutex<SpectrumEnvelope>>;

/// Negotiated sample rate (Hz). Updated by `param_changed` callback; the
/// FFT worker uses this to compute bin indices for the low-band envelope.
/// `AtomicU32` so the RT callback can publish without locking.
type SharedSampleRate = Arc<std::sync::atomic::AtomicU32>;

/// Start PipeWire capture targeting `target_node` and write FFT magnitudes
/// into `spectrum_buf` and beat-sync envelopes into `envelope_buf`.
///
/// Returns `None` if the PipeWire thread fails to spawn.
pub fn start(
    target_node: &str,
    spectrum_buf: Arc<Mutex<(u64, Vec<u8>)>>,
    envelope_buf: SharedEnvelope,
) -> Option<PwCaptureHandle> {
    let running = Arc::new(AtomicBool::new(true));

    // Lock-free SPSC ring buffer: PW RT thread produces, FFT thread consumes.
    let (producer, consumer) = rtrb::RingBuffer::<f32>::new(RING_BUF_CAPACITY);

    // Sample rate published by PW param_changed, consumed by FFT worker.
    let sample_rate: SharedSampleRate = Arc::new(std::sync::atomic::AtomicU32::new(0));

    let running_pw = running.clone();
    let target = target_node.to_string();
    let sample_rate_pw = sample_rate.clone();

    let pw_thread = thread::Builder::new()
        .name("pw-capture".into())
        .spawn(move || {
            if let Err(e) = pw_capture_loop(&target, producer, running_pw, sample_rate_pw) {
                error!("PipeWire capture loop failed: {e}");
            }
        })
        .ok()?;

    let running_fft = running.clone();

    let fft_thread = thread::Builder::new()
        .name("fft-worker".into())
        .spawn(move || {
            fft_worker_loop(consumer, spectrum_buf, envelope_buf, sample_rate, running_fft);
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
    sample_rate_out: SharedSampleRate,
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

    // User data passed into callbacks — the producer half of the ring buffer
    // plus the shared sample-rate publisher (used by the FFT worker to compute
    // bin indices for the low-band envelope).
    struct CaptureData {
        producer: rtrb::Producer<f32>,
        channels: u32,
        sample_rate_out: SharedSampleRate,
    }

    let data = CaptureData {
        producer,
        channels: 0,
        sample_rate_out,
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
                user_data
                    .sample_rate_out
                    .store(info.rate(), Ordering::Relaxed);
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
    envelope_buf: SharedEnvelope,
    sample_rate_in: SharedSampleRate,
    running: Arc<AtomicBool>,
) {
    let window = hanning_window();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    // Accumulation buffer for incoming samples.
    let mut accum: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    // Scratch buffer for FFT input (complex).
    let mut fft_input: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); FFT_SIZE];
    // Output magnitudes (dB-mapped to 0..255 for compatibility with the
    // existing `audio-fft` consumers).
    let mut magnitudes: Vec<u8> = vec![0u8; NUM_BINS];
    // Linear magnitudes scratch — preserved across the loop to feed the
    // envelope follower without re-computing from dB-quantized u8s.
    let mut linear_mags: Vec<f32> = vec![0.0; NUM_BINS];

    // Envelope follower state. One-pole IIR coefficients derived from the
    // tick rate (FFT_TICK_MS). At ~60 Hz tick:
    //   coef = exp(-tick / tau)  (single-pole lowpass)
    //   tau_attack  ~5 ms  -> coef ≈ 0.0408
    //   tau_release ~100 ms -> coef ≈ 0.8521
    let tick_s = (FFT_TICK_MS as f32) * 1e-3;
    let attack_coef = (-tick_s / ENV_ATTACK_S).exp();
    let release_coef = (-tick_s / ENV_RELEASE_S).exp();
    // RMS lowpass: 2 Hz cutoff -> tau = 1/(2*pi*fc) ≈ 80 ms
    let rms_tau_s = 1.0 / (2.0 * std::f32::consts::PI * RMS_LOWPASS_HZ);
    let rms_coef = (-tick_s / rms_tau_s).exp();

    let mut low_env: f32 = 0.0;
    let mut rms_env: f32 = 0.0;

    // Cached bin range — recomputed only when the negotiated sample rate
    // changes. Initial value derives from DEFAULT_SAMPLE_RATE.
    let mut cached_rate: u32 = 0;
    let (mut low_bin_start, mut low_bin_end) = low_band_bin_range(DEFAULT_SAMPLE_RATE);

    while running.load(Ordering::Relaxed) {
        // Sleep ~16ms for ~60Hz refresh rate.
        thread::sleep(Duration::from_millis(FFT_TICK_MS.into()));

        // Drain all available samples from ring buffer into accumulator.
        while let Ok(sample) = consumer.pop() {
            accum.push(sample);
        }

        // Need at least FFT_SIZE samples to run a transform.
        if accum.len() < FFT_SIZE {
            continue;
        }

        // Refresh bin range if the negotiated sample rate changed.
        let rate = sample_rate_in.load(Ordering::Relaxed);
        if rate != 0 && rate != cached_rate {
            cached_rate = rate;
            let (s, e) = low_band_bin_range(rate);
            low_bin_start = s;
            low_bin_end = e;
            debug!(
                "fft-worker: bin range for 20–150 Hz recomputed @ {} Hz => [{}..{})",
                rate, low_bin_start, low_bin_end
            );
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

        // Compute linear magnitudes and dB-quantized u8 in one pass.
        let norm = 1.0 / FFT_SIZE as f32;
        for (i, bin) in fft_input[..NUM_BINS].iter().enumerate() {
            let mag = (bin.re * bin.re + bin.im * bin.im).sqrt() * norm;
            linear_mags[i] = mag;
            let db = if mag > 1e-10 {
                20.0 * mag.log10()
            } else {
                DB_FLOOR
            };
            let normalized = ((db - DB_FLOOR) / DB_RANGE).clamp(0.0, 1.0);
            magnitudes[i] = (normalized * 255.0) as u8;
        }

        // ─── Beat-sync envelopes ─────────────────────────────────────────
        //
        // low_band: média linear no range 20–150 Hz, soft-compressed por
        // sqrt e mapeada para 0..1 com um gain empírico, depois passada
        // pelo envelope follower assimétrico (attack rápido, release lento).
        let raw_low = mean_linear(&linear_mags, low_bin_start, low_bin_end);
        let low_target = normalize_low(raw_low);

        if low_target > low_env {
            low_env = attack_coef * low_env + (1.0 - attack_coef) * low_target;
        } else {
            low_env = release_coef * low_env + (1.0 - release_coef) * low_target;
        }
        // Numerical safety: clamp e remove tail residual.
        if low_env < 1e-4 {
            low_env = 0.0;
        }
        low_env = low_env.clamp(0.0, 1.0);

        // rms_energy: norma L2 da magnitude vector, mapeada para 0..1 via
        // log e suavizada por lowpass ~2 Hz.
        let raw_rms = rms_linear(&linear_mags);
        let rms_target = normalize_rms(raw_rms);
        rms_env = rms_coef * rms_env + (1.0 - rms_coef) * rms_target;
        if rms_env < 1e-4 {
            rms_env = 0.0;
        }
        rms_env = rms_env.clamp(0.0, 1.0);

        // Write spectrum to shared buffer. Timestamp 0 = render immediately.
        if let Ok(mut guard) = spectrum_buf.lock() {
            guard.0 = 0;
            guard.1.clear();
            guard.1.extend_from_slice(&magnitudes);
        }

        // Publish envelope snapshot.
        if let Ok(mut guard) = envelope_buf.lock() {
            *guard = SpectrumEnvelope {
                low_band_mag: low_env,
                rms_energy: rms_env,
            };
        }
    }

    debug!("FFT worker thread exited");
}

/// Compute the FFT bin index range that covers 20–150 Hz given a sample rate.
/// Bin frequency = i * (sample_rate / FFT_SIZE).
/// Returns `(start_inclusive, end_exclusive)`. Always >= 1 (skip DC bin).
fn low_band_bin_range(sample_rate: u32) -> (usize, usize) {
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let start = ((20.0 / bin_hz).floor() as usize).max(1);
    let end = ((150.0 / bin_hz).ceil() as usize + 1).min(NUM_BINS);
    if end <= start {
        (1, (start + 1).min(NUM_BINS))
    } else {
        (start, end)
    }
}

/// Mean of a slice of linear magnitudes within `[start, end)`. Returns 0 when
/// the range is empty.
#[inline]
fn mean_linear(mags: &[f32], start: usize, end: usize) -> f32 {
    let slice = &mags[start..end.min(mags.len())];
    if slice.is_empty() {
        return 0.0;
    }
    let sum: f32 = slice.iter().sum();
    sum / slice.len() as f32
}

/// RMS (L2 norm normalized) over all bins.
#[inline]
fn rms_linear(mags: &[f32]) -> f32 {
    if mags.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = mags.iter().map(|m| m * m).sum();
    (sum_sq / mags.len() as f32).sqrt()
}

/// Map a raw linear low-band magnitude to a perceptual 0..1 range.
/// FFT magnitudes pós-normalização tipicamente vivem em ~1e-4..1e-1, então
/// usamos `sqrt` para soft-compress e um gain empírico fixo. Mantemos uma
/// fórmula pura (sem estado) pra facilitar testes.
#[inline]
fn normalize_low(raw: f32) -> f32 {
    const GAIN: f32 = 4.0;
    (raw.sqrt() * GAIN).clamp(0.0, 1.0)
}

/// Map raw RMS to 0..1 with the same approach as `normalize_low`, ajustado
/// para a faixa típica de RMS sobre todos os bins (mais baixa que pico).
#[inline]
fn normalize_rms(raw: f32) -> f32 {
    const GAIN: f32 = 10.0;
    (raw.sqrt() * GAIN).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_range_at_48k_covers_20_to_150_hz() {
        let (start, end) = low_band_bin_range(48_000);
        // bin_hz @ 48k/2048 ≈ 23.44 Hz
        // 20/23.44 ≈ 0.85 -> floor 0 -> clamped to 1
        // 150/23.44 ≈ 6.4 -> ceil 7 -> end 8
        assert_eq!(start, 1);
        assert_eq!(end, 8);
        assert!(end > start);
    }

    #[test]
    fn bin_range_at_44k_covers_20_to_150_hz() {
        let (start, end) = low_band_bin_range(44_100);
        // bin_hz @ 44.1k/2048 ≈ 21.53 Hz
        // 20/21.53 ≈ 0.93 -> floor 0 -> clamped to 1
        // 150/21.53 ≈ 6.97 -> ceil 7 -> end 8
        assert_eq!(start, 1);
        assert_eq!(end, 8);
    }

    #[test]
    fn bin_range_never_inverts() {
        for rate in [8_000, 16_000, 22_050, 32_000, 48_000, 96_000, 192_000] {
            let (s, e) = low_band_bin_range(rate);
            assert!(e > s, "rate {rate}: start={s} end={e}");
            assert!(s >= 1, "rate {rate}: must skip DC bin");
            assert!(e <= NUM_BINS, "rate {rate}: end out of range");
        }
    }

    #[test]
    fn mean_linear_handles_empty_range() {
        let mags = vec![0.5; 16];
        assert_eq!(mean_linear(&mags, 4, 4), 0.0);
    }

    #[test]
    fn mean_linear_clamps_end() {
        let mags = vec![1.0; 10];
        // end > len is clamped to len.
        let m = mean_linear(&mags, 5, 100);
        assert!((m - 1.0).abs() < 1e-6);
    }

    #[test]
    fn rms_linear_silence_is_zero() {
        let mags = vec![0.0; 32];
        assert_eq!(rms_linear(&mags), 0.0);
    }

    #[test]
    fn rms_linear_unit_amplitude() {
        let mags = vec![1.0; 64];
        assert!((rms_linear(&mags) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn normalize_low_is_monotonic_and_clamped() {
        // Range of interest for low-band FFT magnitudes after window+norm:
        // typical bass kick @ peak ~0.02–0.06, silence ~1e-5.
        assert_eq!(normalize_low(0.0), 0.0);
        assert!(normalize_low(1e-5) < normalize_low(1e-4));
        assert!(normalize_low(1e-4) < normalize_low(1e-3));
        assert!(normalize_low(1.0) <= 1.0);
        assert!(normalize_low(1e6) <= 1.0);
        // Strong kick should saturate to ~1.0 (visualizer is fully pulsing).
        assert!(normalize_low(0.1) >= 0.95);
    }

    #[test]
    fn normalize_rms_is_monotonic_and_clamped() {
        // RMS over all bins is lower than peak — typical music: 1e-5..1e-3.
        assert_eq!(normalize_rms(0.0), 0.0);
        assert!(normalize_rms(1e-5) < normalize_rms(1e-4));
        assert!(normalize_rms(1e-4) < normalize_rms(1e-3));
        assert!(normalize_rms(1e6) <= 1.0);
    }

    #[test]
    fn envelope_attack_is_faster_than_release() {
        // Verifica numericamente que com tick=16ms,
        // attack tau=5ms => coef pequeno (resposta rapida),
        // release tau=100ms => coef grande (resposta lenta).
        let tick_s = (FFT_TICK_MS as f32) * 1e-3;
        let attack = (-tick_s / ENV_ATTACK_S).exp();
        let release = (-tick_s / ENV_RELEASE_S).exp();
        assert!(attack < release);
        assert!((0.0..0.1).contains(&attack));
        assert!((0.8..1.0).contains(&release));
    }
}
