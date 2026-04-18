//! FLAC decoder wrapping `symphonia`.
//!
//! Thin, allocation-conscious wrapper over `symphonia`'s probe/decoder APIs.
//! The engine thread calls [`FlacDecoder::next_chunk`] in a tight loop; every
//! allocation here shows up in the hot path, so we:
//!
//! * allocate the internal `SampleBuffer<f32>` exactly once (in `open`), sized
//!   for the codec's declared `max_frames_per_packet`;
//! * never clear the caller's output vector — they manage capacity;
//! * drop embedded cover art during probing (`limit_visual_bytes = 0`) so we
//!   never spend time decoding artwork the library indexer will re-parse
//!   separately.
//!
//! Only FLAC is accepted; anything else returns [`EngineError::UnsupportedFormat`].

#![allow(dead_code)]

use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;

use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_FLAC};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use crate::error::EngineError;
use crate::types::{SampleFormat, StreamFormat, TrackHandle, TrackInfo};

/// Upper bound used to size the internal `SampleBuffer` when a codec does not
/// advertise `max_frames_per_packet`. FLAC tops out at 16384 frames per block.
const FALLBACK_MAX_FRAMES_PER_PACKET: u64 = 16_384;

/// Handle to an opened FLAC file ready to decode samples on demand.
pub(crate) struct FlacDecoder {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    sample_buf: SampleBuffer<f32>,
    info: TrackInfo,
    stream_format: StreamFormat,
    track_id: u32,
    position_samples: u64,
}

impl FlacDecoder {
    /// Open `path`, validate the container is FLAC, probe metadata, and
    /// instantiate the matching decoder. No audio packets are decoded here —
    /// the first packet is only consumed when `next_chunk` is called.
    ///
    /// Visual metadata (embedded cover art) is discarded during probe; that
    /// responsibility belongs to the library indexer, not the audio engine.
    pub(crate) fn open(handle: TrackHandle, path: &Path) -> Result<Self, EngineError> {
        let file = File::open(path).map_err(|source| EngineError::FileOpen {
            path: path.to_path_buf(),
            source,
        })?;

        let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            hint.with_extension(ext);
        }

        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions {
            // Drop embedded artwork entirely — subsystem B owns cover art.
            limit_visual_bytes: Limit::Maximum(0),
            limit_metadata_bytes: Limit::Maximum(64 * 1024),
        };

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)
            .map_err(|err| map_probe_error(err, path))?;

        let reader = probed.format;

        let track = reader
            .default_track()
            .ok_or(EngineError::UnsupportedFormat)?;

        if track.codec_params.codec != CODEC_TYPE_FLAC {
            return Err(EngineError::UnsupportedFormat);
        }

        let track_id = track.id;
        let codec_params = track.codec_params.clone();

        let sample_rate = codec_params
            .sample_rate
            .ok_or(EngineError::UnsupportedFormat)?;
        let channels = codec_params
            .channels
            .ok_or(EngineError::UnsupportedFormat)?;
        let channel_count = u16::try_from(channels.count()).map_err(|_| {
            EngineError::Decode("channel count does not fit in u16".to_string())
        })?;

        let total_frames = codec_params.n_frames;
        let duration = total_frames.map(|n| {
            // sample_rate > 0 enforced above via Option::ok_or. Use f64 to avoid
            // truncating on long tracks or exotic sample rates.
            Duration::from_secs_f64(n as f64 / f64::from(sample_rate))
        });

        let max_frames_per_packet = codec_params
            .max_frames_per_packet
            .unwrap_or(FALLBACK_MAX_FRAMES_PER_PACKET);

        let spec = SignalSpec::new(sample_rate, channels);
        let sample_buf = SampleBuffer::<f32>::new(max_frames_per_packet, spec);

        let decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(EngineError::from)?;

        let info = TrackInfo {
            handle,
            path: path.to_path_buf(),
            sample_rate,
            channels: channel_count,
            total_frames,
            duration,
        };

        let stream_format = StreamFormat {
            sample_rate,
            source_channels: channel_count,
            output_channels: channel_count,
            sample_format: SampleFormat::F32,
        };

        tracing::info!(
            path = %path.display(),
            sample_rate,
            channels = channel_count,
            total_frames = ?total_frames,
            "opened FLAC decoder"
        );

        Ok(Self {
            reader,
            decoder,
            sample_buf,
            info,
            stream_format,
            track_id,
            position_samples: 0,
        })
    }

    pub(crate) fn info(&self) -> &TrackInfo {
        &self.info
    }

    pub(crate) fn stream_format(&self) -> StreamFormat {
        self.stream_format
    }

    /// Decode the next packet and append its f32 interleaved samples to `out`.
    ///
    /// Returns `Ok(Some(n))` with the number of samples appended (always a
    /// multiple of channel count), `Ok(None)` on end-of-stream, and propagates
    /// any other error. Recoverable `ResetRequired` from symphonia is handled
    /// transparently by resetting the decoder and trying the next packet.
    pub(crate) fn next_chunk(
        &mut self,
        out: &mut Vec<f32>,
    ) -> Result<Option<usize>, EngineError> {
        let channels = u64::from(self.info.channels);

        loop {
            let packet = match self.reader.next_packet() {
                Ok(p) => p,
                Err(SymphoniaError::IoError(io)) if io.kind() == ErrorKind::UnexpectedEof => {
                    return Ok(None);
                }
                Err(SymphoniaError::ResetRequired) => {
                    tracing::warn!("decoder reset required mid-stream; resetting");
                    self.decoder.reset();
                    continue;
                }
                Err(err) => return Err(err.into()),
            };

            // Skip packets for other tracks in multi-track containers (uncommon
            // for FLAC, but cheap insurance).
            if packet.track_id() != self.track_id {
                continue;
            }

            let audio_buf = match self.decoder.decode(&packet) {
                Ok(buf) => buf,
                Err(SymphoniaError::DecodeError(msg)) => {
                    // Per symphonia docs, DecodeError is recoverable — the
                    // packet is bad but the stream can continue. Skip it.
                    tracing::warn!(error = %msg, "decode error on packet; skipping");
                    continue;
                }
                Err(SymphoniaError::ResetRequired) => {
                    tracing::warn!("decoder reset required after decode; resetting");
                    self.decoder.reset();
                    continue;
                }
                Err(err) => return Err(err.into()),
            };

            // Empty packet — ask for the next one instead of returning 0.
            if audio_buf.frames() == 0 {
                continue;
            }

            self.sample_buf.copy_interleaved_ref(audio_buf);
            let samples = self.sample_buf.samples();
            if samples.is_empty() {
                continue;
            }

            out.extend_from_slice(samples);
            let appended = samples.len();
            self.position_samples = self
                .position_samples
                .saturating_add(appended as u64 / channels);

            #[cfg(debug_assertions)]
            debug_assert!(
                appended as u64 % channels == 0,
                "sample count ({appended}) not a multiple of channel count ({channels})"
            );

            return Ok(Some(appended));
        }
    }

    /// Seek to `position_samples` frames from the start (coarse — symphonia may
    /// land a frame or two early; the engine tolerates that).
    pub(crate) fn seek(&mut self, position_samples: u64) -> Result<(), EngineError> {
        let sr = u64::from(self.info.sample_rate);
        let seconds = position_samples / sr;
        let frac = (position_samples % sr) as f64 / sr as f64;
        let target = Time::new(seconds, frac);

        tracing::debug!(position_samples, seconds, frac, "seeking");

        let seeked = self.reader.seek(
            SeekMode::Coarse,
            SeekTo::Time {
                time: target,
                track_id: Some(self.track_id),
            },
        )?;

        // Flush any state the codec built up from the previous position.
        self.decoder.reset();

        // Convert the actual landed timestamp back into sample frames.
        // FLAC's timebase is always 1 / sample_rate, so ts == frames. We still
        // derive it defensively via the track's time_base if present.
        let actual_frames = self
            .reader
            .tracks()
            .iter()
            .find(|t| t.id == self.track_id)
            .and_then(|t| t.codec_params.time_base)
            .map_or(seeked.actual_ts, |tb| {
                let time = tb.calc_time(seeked.actual_ts);
                let secs = time.seconds as f64 + time.frac;
                (secs * f64::from(self.info.sample_rate)) as u64
            });

        self.position_samples = actual_frames;
        Ok(())
    }

    pub(crate) fn position_samples(&self) -> u64 {
        self.position_samples
    }
}

/// Classifies probe errors: an `Unsupported` coming from the format probe is
/// an "unknown container" (not FLAC), not a transient decode failure.
fn map_probe_error(err: SymphoniaError, _path: &Path) -> EngineError {
    match err {
        SymphoniaError::Unsupported(_) => EngineError::UnsupportedFormat,
        // IoError at probe time almost always means "we read enough to know
        // this isn't a container we handle" — the stream surfaces a synthetic
        // UnexpectedEof once every probe descriptor is exhausted.
        SymphoniaError::IoError(ref io) if io.kind() == ErrorKind::UnexpectedEof => {
            EngineError::UnsupportedFormat
        }
        other => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "rustify-decoder-test-{}-{name}",
            std::process::id()
        ));
        p
    }

    #[test]
    fn open_nonexistent_file_returns_file_open_error() {
        let missing = tmp_path("does-not-exist.flac");
        // Ensure the path really does not exist.
        let _ = std::fs::remove_file(&missing);

        let result = FlacDecoder::open(TrackHandle(1), &missing);
        match result {
            Err(EngineError::FileOpen { path, source }) => {
                assert_eq!(path, missing);
                assert_eq!(source.kind(), ErrorKind::NotFound);
            }
            Err(other) => panic!("expected FileOpen, got {other:?}"),
            Ok(_) => panic!("opening a missing file should not succeed"),
        }
    }

    #[test]
    fn open_non_flac_returns_unsupported() {
        let path = tmp_path("garbage.txt");
        {
            let mut f = std::fs::File::create(&path).expect("create temp file");
            // Deliberately random-ish bytes that don't match any container
            // magic symphonia knows about.
            f.write_all(b"this is not a flac file, just plain ASCII garbage\n")
                .expect("write");
            f.write_all(&[0u8; 256]).expect("pad");
        }

        let result = FlacDecoder::open(TrackHandle(42), &path);
        let _ = std::fs::remove_file(&path);

        match result {
            Err(EngineError::UnsupportedFormat) => { /* expected */ }
            Err(other) => panic!("expected UnsupportedFormat, got {other:?}"),
            Ok(_) => panic!("opening a non-FLAC file should not succeed"),
        }
    }
}
