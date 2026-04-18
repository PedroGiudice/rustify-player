//! HTTP client for the `rustify-embed` service running on the Tailnet VM.
//!
//! Embedding inference was moved off the client (see spec: subsystem-b).
//! The local i5 8th gen is too weak to churn through MERT-95M at scale,
//! so the player decodes + preprocesses audio locally and ships the
//! resulting 24 kHz mono f32 waveform to the VM, which runs PyTorch +
//! MERT-v1-95M and returns a 768-dim vector.
//!
//! Wire format:
//!
//! - Request: `POST <base_url>/embed`
//!   - `Content-Type: application/octet-stream`
//!   - `Content-Encoding: zstd`
//!   - Header `X-Sample-Rate: 24000`
//!   - Body: zstd-compressed little-endian f32 samples (mono, 24 kHz)
//! - Response (200 OK): JSON `{ "vector": [f32; 768], "model": "mert-v1-95m" }`
//! - Response (4xx/5xx): JSON `{ "error": "..." }` — surfaced as
//!   [`IndexerError::Embedding`].
//!
//! Offline fallback: the indexer calls this client during the embedding
//! worker loop. If the POST fails (Tailnet down, VM down), the caller
//! flags the track `embedding_status = 'pending'`; the worker will retry
//! on the next run. No retry is done here — transient failure is an
//! upstream concern.

#![allow(dead_code)]

use crate::error::IndexerError;
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::Deserialize;
use std::fs::File;
use std::path::Path;
use std::time::Duration;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_FLAC};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;
use tracing::debug;

/// Target sample rate for MERT-v1-95M input.
const TARGET_SAMPLE_RATE: u32 = 24_000;

/// Maximum waveform length fed to the model, in samples at TARGET_SAMPLE_RATE.
/// 30 s gives enough context for style without exploding the payload
/// (30 s × 24 kHz × 4 bytes = 2.88 MB raw; ~30-50 % after zstd).
const MAX_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 30;

/// Zstd compression level for the audio payload. 3 is the default; faster
/// levels (1, 2) save maybe 5ms at the cost of ~15 % more bytes — not
/// worth it on gigabit Tailscale.
const ZSTD_LEVEL: i32 = 3;

/// HTTP client for the embedding service.
///
/// Cheap to construct, cheap to clone (just wraps a `ureq::Agent`).
#[derive(Clone, Debug)]
pub struct EmbedClient {
    agent: ureq::Agent,
    base_url: String,
}

impl EmbedClient {
    /// Construct a client pointing at `base_url` (e.g.
    /// `"https://extractlab.cormorant-alpha.ts.net:8448"`).
    pub fn new(base_url: impl Into<String>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_secs(60))
            .build();
        Self {
            agent,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// Full pipeline: decode FLAC → mono 24 kHz → zstd → POST → f32 vector.
    ///
    /// On success returns the server-provided embedding (already
    /// L2-normalized server-side). On failure returns
    /// [`IndexerError::Embedding`] with context; the caller is responsible
    /// for flagging the track `pending` so the next run retries.
    pub fn embed_file(&self, flac_path: &Path) -> Result<Vec<f32>, IndexerError> {
        let samples = decode_and_preprocess(flac_path)?;
        self.embed_samples(&samples)
    }

    /// Send already-preprocessed samples (24 kHz mono f32) to the server.
    /// Exposed separately so tests can inject synthetic audio without
    /// going through a real FLAC file.
    pub fn embed_samples(&self, samples: &[f32]) -> Result<Vec<f32>, IndexerError> {
        let bytes = samples_to_le_bytes(samples);
        let compressed = zstd::encode_all(bytes.as_slice(), ZSTD_LEVEL)
            .map_err(|e| IndexerError::Embedding(format!("zstd encode: {e}")))?;

        let url = format!("{}/embed", self.base_url);
        debug!(
            target: "library_indexer::embed_client",
            url, sample_count = samples.len(), compressed_bytes = compressed.len(),
            "POST /embed"
        );

        let response = self
            .agent
            .post(&url)
            .set("Content-Type", "application/octet-stream")
            .set("Content-Encoding", "zstd")
            .set("X-Sample-Rate", &TARGET_SAMPLE_RATE.to_string())
            .send_bytes(&compressed)
            .map_err(|e| IndexerError::Embedding(format!("POST /embed: {e}")))?;

        let parsed: EmbedResponse = response
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("bad response body: {e}")))?;

        if parsed.vector.is_empty() {
            return Err(IndexerError::Embedding(
                "server returned empty vector".into(),
            ));
        }
        Ok(parsed.vector)
    }

    /// Health probe. Returns the server's self-reported model name on 200,
    /// otherwise an error. Used by the coordinator to decide whether to
    /// even bother dispatching embedding work in this session.
    pub fn health(&self) -> Result<String, IndexerError> {
        let url = format!("{}/health", self.base_url);
        let response = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| IndexerError::Embedding(format!("GET /health: {e}")))?;
        let parsed: HealthResponse = response
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("bad /health body: {e}")))?;
        Ok(parsed.model)
    }
}

#[derive(Debug, Deserialize)]
struct EmbedResponse {
    vector: Vec<f32>,
    #[serde(default)]
    model: String,
}

#[derive(Debug, Deserialize)]
struct HealthResponse {
    model: String,
}

/// Decode a FLAC file, downmix to mono, resample to 24 kHz, trim to
/// [`MAX_SAMPLES`] (center window), return f32 samples.
fn decode_and_preprocess(path: &Path) -> Result<Vec<f32>, IndexerError> {
    let (samples, sample_rate, channels) = decode_flac(path)?;
    let mono = downmix_mono(&samples, channels);
    let resampled = resample_to_target(&mono, sample_rate)?;
    Ok(take_center_window(resampled, MAX_SAMPLES))
}

fn decode_flac(path: &Path) -> Result<(Vec<f32>, u32, u16), IndexerError> {
    let file = File::open(path).map_err(|e| IndexerError::Metadata {
        path: path.to_path_buf(),
        message: format!("open: {e}"),
    })?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    hint.with_extension("flac");

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions {
                limit_visual_bytes: Limit::Maximum(0),
                ..MetadataOptions::default()
            },
        )
        .map_err(|e| IndexerError::Metadata {
            path: path.to_path_buf(),
            message: format!("probe: {e}"),
        })?;

    let mut reader = probed.format;
    let track = reader
        .default_track()
        .ok_or_else(|| IndexerError::Metadata {
            path: path.to_path_buf(),
            message: "no default track".into(),
        })?;

    if track.codec_params.codec != CODEC_TYPE_FLAC {
        return Err(IndexerError::Metadata {
            path: path.to_path_buf(),
            message: "not a FLAC codec".into(),
        });
    }

    let sample_rate = track.codec_params.sample_rate.ok_or_else(|| {
        IndexerError::Metadata {
            path: path.to_path_buf(),
            message: "no sample rate".into(),
        }
    })?;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| IndexerError::Metadata {
            path: path.to_path_buf(),
            message: format!("codec: {e}"),
        })?;
    let track_id = track.id;

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match reader.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => {
                return Err(IndexerError::Metadata {
                    path: path.to_path_buf(),
                    message: format!("packet: {e}"),
                });
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => {
                return Err(IndexerError::Metadata {
                    path: path.to_path_buf(),
                    message: format!("decode: {e}"),
                });
            }
        };
        if sample_buf.is_none() {
            let spec = *decoded.spec();
            sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        if let Some(buf) = sample_buf.as_mut() {
            buf.copy_interleaved_ref(decoded);
            samples.extend_from_slice(buf.samples());
        }

        // Early termination: we only need the first ~60s of source audio
        // to eventually give us 30s at 24kHz. Saves I/O on long tracks.
        let frames_captured = samples.len() / channels as usize;
        if frames_captured >= sample_rate as usize * 60 {
            break;
        }
    }

    Ok((samples, sample_rate, channels))
}

fn downmix_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let n = channels as usize;
    let frames = interleaved.len() / n;
    let mut out = Vec::with_capacity(frames);
    let scale = 1.0 / n as f32;
    for f in 0..frames {
        let base = f * n;
        let mut sum = 0.0;
        for c in 0..n {
            sum += interleaved[base + c];
        }
        out.push(sum * scale);
    }
    out
}

fn resample_to_target(mono: &[f32], source_rate: u32) -> Result<Vec<f32>, IndexerError> {
    if source_rate == TARGET_SAMPLE_RATE {
        return Ok(mono.to_vec());
    }
    if mono.is_empty() {
        return Ok(Vec::new());
    }

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let ratio = f64::from(TARGET_SAMPLE_RATE) / f64::from(source_rate);
    let chunk_size = 4096.min(mono.len());

    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk_size, 1)
        .map_err(|e| IndexerError::Embedding(format!("resampler init: {e}")))?;

    let mut out: Vec<f32> = Vec::with_capacity((mono.len() as f64 * ratio) as usize + 32);
    let mut cursor = 0usize;

    while cursor + chunk_size <= mono.len() {
        let input = &mono[cursor..cursor + chunk_size];
        let output = resampler
            .process(&[input], None)
            .map_err(|e| IndexerError::Embedding(format!("resample: {e}")))?;
        out.extend_from_slice(&output[0]);
        cursor += chunk_size;
    }

    // Tail: process_partial flushes whatever is left.
    if cursor < mono.len() {
        let remainder: Vec<f32> = mono[cursor..].to_vec();
        let output = resampler
            .process_partial(Some(&[remainder.as_slice()]), None)
            .map_err(|e| IndexerError::Embedding(format!("resample tail: {e}")))?;
        out.extend_from_slice(&output[0]);
    }

    Ok(out)
}

fn take_center_window(mut samples: Vec<f32>, max_samples: usize) -> Vec<f32> {
    if samples.len() <= max_samples {
        return samples;
    }
    let start = (samples.len() - max_samples) / 2;
    samples.drain(..start);
    samples.truncate(max_samples);
    samples
}

fn samples_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_mono_preserves_mono() {
        let s = vec![0.1, 0.2, 0.3];
        assert_eq!(downmix_mono(&s, 1), s);
    }

    #[test]
    fn downmix_mono_averages_stereo() {
        // LR pairs: (1, -1) -> 0, (0.5, 0.5) -> 0.5
        let s = vec![1.0, -1.0, 0.5, 0.5];
        let mono = downmix_mono(&s, 2);
        assert_eq!(mono.len(), 2);
        assert!((mono[0] - 0.0).abs() < 1e-6);
        assert!((mono[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn take_center_window_no_op_if_shorter() {
        let v = vec![1.0, 2.0, 3.0];
        assert_eq!(take_center_window(v.clone(), 10), v);
    }

    #[test]
    fn take_center_window_centers_on_trim() {
        let v: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let out = take_center_window(v, 10);
        assert_eq!(out.len(), 10);
        // Center of 0..100 is 45..55.
        assert_eq!(out[0], 45.0);
        assert_eq!(out[9], 54.0);
    }

    #[test]
    fn samples_to_le_bytes_roundtrip() {
        let s = vec![1.0_f32, -0.5, 3.14];
        let bytes = samples_to_le_bytes(&s);
        assert_eq!(bytes.len(), s.len() * 4);
        let decoded: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        assert_eq!(decoded, s);
    }

    #[test]
    fn resample_noop_when_rates_match() {
        let s: Vec<f32> = (0..1000).map(|i| i as f32 * 0.001).collect();
        let out = resample_to_target(&s, TARGET_SAMPLE_RATE).unwrap();
        assert_eq!(out, s);
    }

    #[test]
    fn resample_44100_to_24000_approximates_expected_length() {
        let s: Vec<f32> = (0..44100).map(|_| 0.0_f32).collect();
        let out = resample_to_target(&s, 44100).unwrap();
        // 1s at 44.1kHz -> ~1s at 24kHz = ~24000 samples. Tolerate ±5%.
        let expected = 24_000_f64;
        let len = out.len() as f64;
        assert!(
            (len - expected).abs() / expected < 0.05,
            "got {} samples, expected ~{}",
            out.len(),
            24_000
        );
    }

    #[test]
    #[ignore = "requires rustify-embed service running on VM; manual test"]
    fn health_returns_model_name() {
        let client = EmbedClient::new("http://localhost:8448");
        let model = client.health().unwrap();
        assert!(!model.is_empty());
    }
}
