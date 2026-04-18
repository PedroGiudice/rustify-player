//! `cpal` implementation of [`AudioOutput`].
//!
//! Two modes matter for this crate:
//!
//! - `OutputMode::System`: `cpal::default_host().default_output_device()`.
//!   On Ubuntu + PipeWire this is the ALSA `default` device routed through
//!   the `libasound` PipeWire plugin, so audio flows through PipeWire (and
//!   through any user routing like EasyEffects). The player does *not* try
//!   to force the stream sample rate; PipeWire handles resampling.
//! - `OutputMode::BitPerfect { device }`: a specific ALSA device such as
//!   `hw:0,0`. The stream is configured to match the track's sample rate and
//!   channel count exactly. Downmix is refused; unsupported sample rates
//!   are surfaced as `OutputError::FormatNotSupported`.
//!
//! The realtime audio callback obeys the usual rules: zero allocation, zero
//! locks, zero I/O. It only pops samples from the ring buffer and fills the
//! output slice, counting underruns with an atomic.

use std::any::Any;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat as CpalSampleFormat, Stream, StreamConfig};
use rtrb::{Consumer, RingBuffer};

use super::{ActiveStream, AudioOutput};
use crate::error::OutputError;
use crate::types::{DeviceInfo, OutputMode, SampleFormat, StreamFormat};

/// Ring buffer target: ~500 ms of samples at the negotiated rate.
const RING_BUFFER_MS: u32 = 500;

pub struct CpalOutput {
    mode: OutputMode,
    xruns: Arc<AtomicU64>,
}

impl CpalOutput {
    pub fn new(mode: OutputMode) -> Self {
        Self {
            mode,
            xruns: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_mode(&mut self, mode: OutputMode) {
        self.mode = mode;
    }
}

impl AudioOutput for CpalOutput {
    fn configure(&mut self, format: StreamFormat) -> Result<ActiveStream, OutputError> {
        debug_assert!(matches!(format.sample_format, SampleFormat::F32));
        match &self.mode {
            OutputMode::System => configure_system(self.xruns.clone(), format),
            OutputMode::BitPerfect { device } => {
                configure_bit_perfect(self.xruns.clone(), format, device)
            }
        }
    }

    fn stop(&mut self) {
        // Streams live inside `ActiveStream::_keepalive`; dropping that value
        // tears the stream down. No backend-side bookkeeping to clear here.
    }

    fn xrun_count(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }
}

/// System default output: open whatever cpal says is the default device at
/// the device's preferred config. PipeWire resamples between the stream
/// sample rate and the source file if they differ.
fn configure_system(
    xruns: Arc<AtomicU64>,
    format: StreamFormat,
) -> Result<ActiveStream, OutputError> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or(OutputError::NoDevices)?;
    let supported = device.default_output_config()?;

    // Open the stream at the SOURCE sample rate, not the device default.
    // cpal's default_output_config() returns the device's preferred rate
    // (e.g. 48000 on PipeWire), not a mandatory rate. Requesting the source
    // rate here lets the ALSA->PipeWire plugin resample internally; without
    // this override, the engine feeds source-rate samples into a device-rate
    // stream and playback speed/pitch shifts (96k source -> 48k stream plays
    // at half speed; 44.1k source -> 48k stream plays 8.8% fast).
    let mut stream_config: StreamConfig = supported.config();
    stream_config.sample_rate = format.sample_rate;

    let actual = StreamFormat {
        sample_rate: format.sample_rate,
        source_channels: format.source_channels,
        output_channels: stream_config.channels,
        sample_format: SampleFormat::F32,
    };

    tracing::info!(
        host = host.id().name(),
        device = %device_name(&device),
        sr = actual.sample_rate,
        ch = actual.output_channels,
        src_ch = actual.source_channels,
        "configured system output"
    );

    build_stream(&device, &stream_config, xruns, actual)
}

/// Bit-perfect output: user picked a specific ALSA device. We refuse to
/// resample or downmix; the engine is expected to reconfigure whenever a new
/// track needs a different sample rate or channel count.
fn configure_bit_perfect(
    xruns: Arc<AtomicU64>,
    format: StreamFormat,
    device_name_req: &str,
) -> Result<ActiveStream, OutputError> {
    let host = cpal::default_host();
    let device = host
        .output_devices()?
        .find(|d| device_name(d) == device_name_req)
        .ok_or_else(|| OutputError::DeviceNotFound {
            name: device_name_req.to_string(),
        })?;

    let target_channels = format.source_channels;
    let target_rate = format.sample_rate;

    let supported = pick_supported_config(&device, target_rate, target_channels)?;
    let stream_config: StreamConfig = supported.config();

    let actual = StreamFormat {
        sample_rate: stream_config.sample_rate,
        source_channels: format.source_channels,
        output_channels: stream_config.channels,
        sample_format: SampleFormat::F32,
    };

    tracing::info!(
        device = %device_name(&device),
        sr = actual.sample_rate,
        ch = actual.output_channels,
        "configured bit-perfect output"
    );

    build_stream(&device, &stream_config, xruns, actual)
}

/// Walks `supported_output_configs()` and returns the closest-matching one
/// that preserves sample rate, prefers matching channel count (refusing any
/// downmix), and advertises F32 support.
fn pick_supported_config(
    device: &cpal::Device,
    sample_rate: u32,
    channels: u16,
) -> Result<cpal::SupportedStreamConfig, OutputError> {
    let mut seen_rate = false;

    for range in device.supported_output_configs()? {
        if range.sample_format() != CpalSampleFormat::F32 {
            continue;
        }

        let rate_ok =
            range.min_sample_rate() <= sample_rate && sample_rate <= range.max_sample_rate();
        if rate_ok {
            seen_rate = true;
        }
        if !rate_ok {
            continue;
        }

        if range.channels() == channels {
            return Ok(range.with_sample_rate(sample_rate));
        }
        if channels == 1 && range.channels() == 2 {
            // Mono source with stereo device: acceptable, the engine will
            // duplicate the channel in-band.
            return Ok(range.with_sample_rate(sample_rate));
        }
        if range.channels() < channels {
            return Err(OutputError::DownmixNotAllowed {
                source_channels: channels,
                target_channels: range.channels(),
            });
        }
    }

    if seen_rate {
        Err(OutputError::FormatNotSupported {
            detail: format!(
                "device does not expose a {channels}-channel F32 config at {sample_rate} Hz"
            ),
        })
    } else {
        Err(OutputError::FormatNotSupported {
            detail: format!("device does not advertise support for {sample_rate} Hz"),
        })
    }
}

/// Build the cpal stream, spawn the callback, and bundle everything into an
/// [`ActiveStream`]. Ring buffer size is derived from the negotiated format.
fn build_stream(
    device: &cpal::Device,
    stream_config: &StreamConfig,
    xruns: Arc<AtomicU64>,
    actual_format: StreamFormat,
) -> Result<ActiveStream, OutputError> {
    let ring_samples = (actual_format.sample_rate as u64)
        .saturating_mul(actual_format.output_channels as u64)
        .saturating_mul(RING_BUFFER_MS as u64)
        / 1000;
    let ring_samples = ring_samples.max(2048) as usize;

    let (producer, mut consumer): (rtrb::Producer<f32>, Consumer<f32>) =
        RingBuffer::<f32>::new(ring_samples);

    let alive = Arc::new(AtomicBool::new(true));
    let last_error = Arc::new(Mutex::new(None::<OutputError>));

    let xruns_cb = xruns.clone();
    let err_alive = alive.clone();
    let err_slot = last_error.clone();

    let stream = device.build_output_stream(
        stream_config,
        move |out: &mut [f32], _info: &cpal::OutputCallbackInfo| {
            let popped = fill_output(out, &mut consumer);
            if popped < out.len() {
                // Underrun: fill the tail with silence, bump the counter.
                out[popped..].fill(0.0);
                xruns_cb.fetch_add(1, Ordering::Relaxed);
            }
        },
        move |err| {
            tracing::error!(?err, "cpal stream error");
            let mapped: OutputError = err.into();
            // Lock-poison is fine here: error path is already broken.
            if let Ok(mut slot) = err_slot.lock() {
                *slot = Some(match &mapped {
                    OutputError::Disconnected => OutputError::Disconnected,
                    OutputError::CpalStream(s) => OutputError::CpalStream(s.clone()),
                    other => OutputError::CpalStream(other.to_string()),
                });
            }
            err_alive.store(false, Ordering::Release);
        },
        None,
    )?;

    stream.play().map_err(|e| match e {
        cpal::PlayStreamError::DeviceNotAvailable => OutputError::Disconnected,
        cpal::PlayStreamError::BackendSpecific { err } => OutputError::CpalStream(err.description),
    })?;

    Ok(ActiveStream {
        producer,
        actual_format,
        alive,
        last_error,
        _keepalive: Box::new(StreamGuard { _stream: stream }) as Box<dyn Any + Send>,
    })
}

/// Wrapper to satisfy `Box<dyn Any + Send>` — `cpal::Stream` is `!Sync` on
/// some platforms but is `Send`, which is all the engine thread needs.
struct StreamGuard {
    _stream: Stream,
}

// SAFETY: We never share the stream across threads; `ActiveStream` is owned
// by a single consumer (the engine thread). cpal's Stream impl is Send on
// Linux but not Sync. Marking StreamGuard as Send makes the `Box<dyn Any +
// Send>` trait object inference happy on hosts where `Stream: !Sync`.
unsafe impl Send for StreamGuard {}

/// Read the device's display name as a short string. cpal 0.17 deprecated
/// `DeviceTrait::name()` in favour of `description()`, but for UI display we
/// only want the short human-readable label, which `description().name()`
/// returns. We keep a single helper to silence the deprecation once.
fn device_name(device: &cpal::Device) -> String {
    match device.description() {
        Ok(desc) => desc.name().to_string(),
        Err(_) => String::new(),
    }
}

/// Pop up to `out.len()` samples from `consumer` into `out` in one pass.
/// Returns the number of samples written.
fn fill_output(out: &mut [f32], consumer: &mut Consumer<f32>) -> usize {
    let requested = out.len();
    let available = consumer.slots();
    let to_read = available.min(requested);
    if to_read == 0 {
        return 0;
    }
    let Ok(chunk) = consumer.read_chunk(to_read) else {
        return 0;
    };
    let (a, b) = chunk.as_slices();
    let mut written = 0;
    out[..a.len()].copy_from_slice(a);
    written += a.len();
    if !b.is_empty() {
        out[written..written + b.len()].copy_from_slice(b);
        written += b.len();
    }
    chunk.commit_all();
    written
}

/// Enumerate all hosts and output devices, returning a sorted list suitable
/// for rendering in the settings UI.
pub(super) fn list_devices() -> Vec<DeviceInfo> {
    let mut out = Vec::new();

    for host_id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(host_id) else {
            continue;
        };
        let default_name = host.default_output_device().map(|d| device_name(&d));
        let Ok(devices) = host.output_devices() else {
            continue;
        };

        for device in devices {
            let name = device_name(&device);
            if name.is_empty() {
                continue;
            }

            let mut sample_rates: Vec<u32> = Vec::new();
            let mut channels: Vec<u16> = Vec::new();

            if let Ok(configs) = device.supported_output_configs() {
                for range in configs {
                    let max = range.max_sample_rate();
                    let min = range.min_sample_rate();
                    if !sample_rates.contains(&max) {
                        sample_rates.push(max);
                    }
                    if !sample_rates.contains(&min) {
                        sample_rates.push(min);
                    }
                    if !channels.contains(&range.channels()) {
                        channels.push(range.channels());
                    }
                }
            }

            sample_rates.sort_unstable();
            channels.sort_unstable();

            out.push(DeviceInfo {
                host: host_id.name().to_string(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
                supported_sample_rates: sample_rates,
                supported_channels: channels,
            });
        }
    }

    out.sort_by(|a, b| {
        a.host
            .cmp(&b.host)
            .then(b.is_default.cmp(&a.is_default))
            .then(a.name.cmp(&b.name))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_devices_does_not_panic() {
        let list = list_devices();
        // On a headless CI box this can legitimately be empty; we only assert
        // the call returns cleanly.
        let _ = list;
    }

    #[test]
    fn configure_bit_perfect_missing_device_errors() {
        let mut out = CpalOutput::new(OutputMode::BitPerfect {
            device: "__definitely_not_a_real_device__".to_string(),
        });
        let format = StreamFormat {
            sample_rate: 44_100,
            source_channels: 2,
            output_channels: 2,
            sample_format: SampleFormat::F32,
        };
        match out.configure(format) {
            Err(OutputError::DeviceNotFound { name }) => {
                assert_eq!(name, "__definitely_not_a_real_device__");
            }
            Err(OutputError::NoDevices) => {
                // Acceptable on hosts where no output devices exist at all.
            }
            Err(other) => panic!("expected DeviceNotFound, got {other:?}"),
            Ok(_) => panic!("configure should not have succeeded with a fake device"),
        }
    }

    #[test]
    #[ignore = "requires real default output device"]
    fn configure_system_opens_default_device() {
        let mut out = CpalOutput::new(OutputMode::System);
        let format = StreamFormat {
            sample_rate: 44_100,
            source_channels: 2,
            output_channels: 2,
            sample_format: SampleFormat::F32,
        };
        match out.configure(format) {
            Ok(active) => {
                assert!(active.actual_format.sample_rate > 0);
                assert!(active.actual_format.output_channels > 0);
                drop(active);
            }
            Err(e) => panic!("configure failed: {e}"),
        }
    }
}
