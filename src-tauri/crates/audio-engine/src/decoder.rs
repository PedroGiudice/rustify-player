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
use symphonia::core::meta::{Limit, MetadataOptions, StandardTagKey, Tag, Value};
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

        let mut reader = probed.format;

        let replaygain = extract_replaygain(reader.as_mut());

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
        let channel_count = u16::try_from(channels.count())
            .map_err(|_| EngineError::Decode("channel count does not fit in u16".to_string()))?;

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

        let bit_depth = codec_params.bits_per_sample;

        let info = TrackInfo {
            handle,
            path: path.to_path_buf(),
            sample_rate,
            channels: channel_count,
            bit_depth,
            total_frames,
            duration,
            track_gain_db: replaygain.track_gain_db,
            album_gain_db: replaygain.album_gain_db,
            track_peak: replaygain.track_peak,
            album_peak: replaygain.album_peak,
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
    pub(crate) fn next_chunk(&mut self, out: &mut Vec<f32>) -> Result<Option<usize>, EngineError> {
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

/// ReplayGain tag values extracted from the FLAC's Vorbis comments.
///
/// All fields are optional — a file may carry any subset. Gains are `dB`,
/// peaks are linear samples (well-behaved masters stay `<= 1.0` but some
/// taggers emit values `> 1.0` when intersample peaks exceed full-scale).
#[derive(Debug, Default, Clone, Copy)]
struct ReplayGainTags {
    track_gain_db: Option<f32>,
    album_gain_db: Option<f32>,
    track_peak: Option<f32>,
    album_peak: Option<f32>,
}

/// Walk every metadata revision exposed by the reader and pull the
/// ReplayGain tags. Tolerant of exotic taggers that skip symphonia's
/// `StandardTagKey` mapping by also matching raw Vorbis keys
/// (`REPLAYGAIN_TRACK_GAIN`, etc.) case-insensitively.
///
/// Total: never panics, never errors; missing tags remain `None`.
fn extract_replaygain(reader: &mut dyn FormatReader) -> ReplayGainTags {
    let mut rg = ReplayGainTags::default();

    let mut meta = reader.metadata();
    // Walk from oldest to newest: `current()` is the latest revision; older
    // revisions are reached by `pop()`. Later revisions overwrite earlier
    // ones so the newest value wins.
    let mut revisions: Vec<Vec<Tag>> = Vec::new();
    if let Some(rev) = meta.current() {
        revisions.push(rev.tags().to_vec());
    }
    while meta.pop().is_some() {
        if let Some(rev) = meta.current() {
            revisions.push(rev.tags().to_vec());
        }
    }

    // Apply oldest-first so newer revisions win on overwrite.
    for tags in revisions.into_iter().rev() {
        apply_replaygain_tags(&mut rg, &tags);
    }

    rg
}

fn apply_replaygain_tags(rg: &mut ReplayGainTags, tags: &[Tag]) {
    for tag in tags {
        let value = match &tag.value {
            Value::String(s) => s.clone(),
            Value::Float(f) => f.to_string(),
            Value::SignedInt(i) => i.to_string(),
            Value::UnsignedInt(u) => u.to_string(),
            _ => continue,
        };
        if value.trim().is_empty() {
            continue;
        }

        // Prefer StandardTagKey when symphonia recognizes it.
        if let Some(std_key) = tag.std_key {
            match std_key {
                StandardTagKey::ReplayGainTrackGain => {
                    if let Some(v) = parse_db(&value) {
                        rg.track_gain_db = Some(v);
                    }
                    continue;
                }
                StandardTagKey::ReplayGainAlbumGain => {
                    if let Some(v) = parse_db(&value) {
                        rg.album_gain_db = Some(v);
                    }
                    continue;
                }
                StandardTagKey::ReplayGainTrackPeak => {
                    if let Ok(v) = value.trim().parse::<f32>() {
                        rg.track_peak = Some(v);
                    }
                    continue;
                }
                StandardTagKey::ReplayGainAlbumPeak => {
                    if let Ok(v) = value.trim().parse::<f32>() {
                        rg.album_peak = Some(v);
                    }
                    continue;
                }
                _ => {}
            }
        }

        // Fallback: raw Vorbis key, case-insensitive. Only apply if the
        // standard-key branch did not already fill the slot in this tag.
        let key = tag.key.to_ascii_uppercase();
        match key.as_str() {
            "REPLAYGAIN_TRACK_GAIN" if rg.track_gain_db.is_none() => {
                if let Some(v) = parse_db(&value) {
                    rg.track_gain_db = Some(v);
                }
            }
            "REPLAYGAIN_ALBUM_GAIN" if rg.album_gain_db.is_none() => {
                if let Some(v) = parse_db(&value) {
                    rg.album_gain_db = Some(v);
                }
            }
            "REPLAYGAIN_TRACK_PEAK" if rg.track_peak.is_none() => {
                if let Ok(v) = value.trim().parse::<f32>() {
                    rg.track_peak = Some(v);
                }
            }
            "REPLAYGAIN_ALBUM_PEAK" if rg.album_peak.is_none() => {
                if let Ok(v) = value.trim().parse::<f32>() {
                    rg.album_peak = Some(v);
                }
            }
            _ => {}
        }
    }
}

/// Parse ReplayGain dB values like `"-6.28 dB"`, `"-6.28"`, `"+2.00 dB"`.
/// Tolerates case variants (`dB`, `db`, `DB`) and surrounding whitespace.
fn parse_db(s: &str) -> Option<f32> {
    let cleaned = s
        .trim()
        .trim_end_matches("dB")
        .trim_end_matches("db")
        .trim_end_matches("DB")
        .trim();
    cleaned.parse::<f32>().ok()
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
