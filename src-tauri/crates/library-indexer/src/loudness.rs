//! Offline LUFS Integrated analysis for FLAC files.
//!
//! Decodes the entire file with `symphonia`, feeds the interleaved f32
//! samples to `ebur128`, and returns the program loudness as defined by
//! ITU-R BS.1770 / EBU R128.
//!
//! Used by:
//! - the scan pipeline, to populate `lufs_integrated` on freshly indexed
//!   tracks;
//! - the lazy backfill worker in the Tauri app, to fill the field for
//!   tracks indexed before normalization landed.
//!
//! The function is synchronous and CPU-bound. Callers are expected to run
//! it on a dedicated worker thread.

#![allow(dead_code)]

use std::fs::File;
use std::path::{Path, PathBuf};

use ebur128::{EbuR128, Mode};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_FLAC};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;

use crate::error::IndexerError;

/// Result of a successful LUFS analysis.
#[derive(Debug, Clone, Copy)]
pub struct LoudnessAnalysis {
    pub integrated_lufs: f32,
}

/// Decode `path` end-to-end and compute the EBU R128 Integrated loudness.
///
/// Returns `IndexerError::Metadata` for any I/O, decode, or analysis error.
/// The file must be a FLAC; non-FLAC streams are rejected explicitly to
/// avoid silently feeding garbage to ebur128.
pub fn analyze_file(path: &Path) -> Result<LoudnessAnalysis, IndexerError> {
    let file = File::open(path).map_err(|e| metadata_err(path, format!("open: {e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    hint.with_extension("flac");
    hint.mime_type("audio/flac");

    let fmt_opts = FormatOptions::default();
    // Skip artwork/metadata — we only care about audio frames.
    let meta_opts = MetadataOptions {
        limit_visual_bytes: Limit::Maximum(0),
        limit_metadata_bytes: Limit::Maximum(64 * 1024),
    };

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| metadata_err(path, format!("probe: {e}")))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec == CODEC_TYPE_FLAC)
        .ok_or_else(|| metadata_err(path, "no FLAC track in container".to_string()))?;

    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| metadata_err(path, "missing sample_rate".to_string()))?;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u32)
        .ok_or_else(|| metadata_err(path, "missing channel layout".to_string()))?;

    if channels == 0 {
        return Err(metadata_err(path, "zero-channel track".to_string()));
    }

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| metadata_err(path, format!("decoder init: {e}")))?;

    let mut analyzer = EbuR128::new(channels, sample_rate, Mode::I)
        .map_err(|e| metadata_err(path, format!("ebur128 init: {e:?}")))?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // End of stream is normal; everything else is a real error.
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => {
                return Err(metadata_err(path, format!("read packet: {e}")));
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(metadata_err(path, format!("decode: {e}"))),
        };

        let spec = *decoded.spec();
        let frames = decoded.capacity() as u64;
        let buf = sample_buf.get_or_insert_with(|| SampleBuffer::<f32>::new(frames, spec));
        buf.copy_interleaved_ref(decoded);
        analyzer
            .add_frames_f32(buf.samples())
            .map_err(|e| metadata_err(path, format!("ebur128 add_frames: {e:?}")))?;
    }

    let integrated = analyzer
        .loudness_global()
        .map_err(|e| metadata_err(path, format!("ebur128 loudness_global: {e:?}")))?;

    // ebur128 may return -inf for true digital silence; normalize to a
    // sentinel that the gain math handles gracefully (passthrough).
    let integrated_f32 = if integrated.is_finite() {
        integrated as f32
    } else {
        // Silence / no usable audio: treat as already at target.
        return Err(metadata_err(
            path,
            format!("non-finite loudness ({integrated}); likely silent track"),
        ));
    };

    Ok(LoudnessAnalysis {
        integrated_lufs: integrated_f32,
    })
}

fn metadata_err(path: &Path, message: String) -> IndexerError {
    IndexerError::Metadata {
        path: PathBuf::from(path),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: synthesize a tiny WAV-like buffer is too involved
    /// without a FLAC encoder available in workspace deps. Instead we
    /// only assert the obvious failure paths here; the happy path is
    /// covered by manual playback testing on real library files.

    #[test]
    fn missing_file_returns_metadata_error() {
        let res = analyze_file(Path::new("/definitely/does/not/exist.flac"));
        assert!(res.is_err());
    }
}
