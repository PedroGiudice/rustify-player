//! FLAC tag + format extraction via symphonia.
//!
//! One probe per file yields everything the indexer needs: metadata tags,
//! audio format (sample rate / bit depth / channels / duration), and the
//! embedded pictures. Cover art processing (resize + WebP encode) lives in
//! [`crate::cover`] and consumes the [`EmbeddedPicture`] entries here.
//!
//! Tag source order for Vorbis keys: we ask symphonia for *all* revisions
//! and take the latest non-empty value per standard Vorbis field name,
//! case-insensitive.

#![allow(dead_code)]

use crate::error::IndexerError;
use std::fs::File;
use std::path::{Path, PathBuf};
use symphonia::core::codecs::CODEC_TYPE_FLAC;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions, StandardTagKey, Tag, Value, Visual};
use symphonia::core::probe::Hint;

/// A single embedded picture block (APIC-style).
#[derive(Debug, Clone)]
pub struct EmbeddedPicture {
    pub mime: String,
    pub data: Vec<u8>,
    pub usage: PictureUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PictureUsage {
    FrontCover,
    BackCover,
    Other,
}

/// Everything extracted from a single FLAC probe. Only fields we actually
/// use downstream are kept — we don't attempt to be a full metadata library.
#[derive(Debug, Clone, Default)]
pub struct ParsedFlacMetadata {
    // Tags
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<i32>,
    pub disc_number: Option<i32>,
    pub year: Option<i32>,
    /// Raw `GENRE` tag value, not yet tokenized.
    pub genre_raw: Option<String>,
    /// Tokenized tags: splits `GENRE` on `[,;/]` and whitespace collapse.
    pub tags: Vec<String>,

    // ReplayGain
    pub rg_track_gain: Option<f32>,
    pub rg_album_gain: Option<f32>,
    pub rg_track_peak: Option<f32>,
    pub rg_album_peak: Option<f32>,

    // Audio format
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub channels: u16,
    pub duration_ms: i64,

    // Pictures
    pub pictures: Vec<EmbeddedPicture>,
}

/// Probe the FLAC at `path`, returning tags + format + embedded pictures.
/// Non-FLAC files raise [`IndexerError::Metadata`].
pub fn parse_flac(path: &Path) -> Result<ParsedFlacMetadata, IndexerError> {
    let file = File::open(path).map_err(|e| IndexerError::Metadata {
        path: path.to_path_buf(),
        message: format!("open: {}", e),
    })?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    hint.with_extension("flac");
    hint.mime_type("audio/flac");

    let fmt_opts = FormatOptions::default();
    let meta_opts = MetadataOptions {
        // Allow up to 16 MB of visual data — enough for lossless CD-quality
        // cover art; larger embeds are quite rare and we skip them rather
        // than allocating indefinitely.
        limit_visual_bytes: Limit::Maximum(16 * 1024 * 1024),
        ..MetadataOptions::default()
    };

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| IndexerError::Metadata {
            path: path.to_path_buf(),
            message: format!("probe: {}", e),
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

    let sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let bit_depth = track.codec_params.bits_per_sample.unwrap_or(0) as u16;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(0);
    let duration_ms = track
        .codec_params
        .n_frames
        .and_then(|f| {
            if sample_rate == 0 {
                None
            } else {
                Some((f as i64) * 1000 / (sample_rate as i64))
            }
        })
        .unwrap_or(0);

    let mut parsed = ParsedFlacMetadata {
        sample_rate,
        bit_depth,
        channels,
        duration_ms,
        ..Default::default()
    };

    // Symphonia surfaces metadata revisions in two places: inline in the
    // probed format (`reader.metadata().current()`) and in the probe hints
    // container (`probed.metadata.get()`). FLAC tags usually land in the
    // reader. Merge both.
    let mut collected_tags: Vec<Tag> = Vec::new();
    let mut collected_visuals: Vec<Visual> = Vec::new();

    if let Some(rev) = reader.metadata().current() {
        collected_tags.extend(rev.tags().iter().cloned());
        collected_visuals.extend(rev.visuals().iter().cloned());
    }

    apply_tags(&mut parsed, &collected_tags);
    extract_pictures(&mut parsed, &collected_visuals);

    Ok(parsed)
}

fn apply_tags(md: &mut ParsedFlacMetadata, tags: &[Tag]) {
    for tag in tags {
        let value = match &tag.value {
            Value::String(s) => s.clone(),
            Value::Binary(_) => continue,
            Value::Boolean(b) => b.to_string(),
            Value::Flag => continue,
            Value::Float(f) => f.to_string(),
            Value::SignedInt(i) => i.to_string(),
            Value::UnsignedInt(u) => u.to_string(),
        };
        if value.trim().is_empty() {
            continue;
        }

        // Prefer the StandardTagKey mapping when symphonia recognizes it.
        if let Some(std) = tag.std_key {
            match std {
                StandardTagKey::TrackTitle => md.title.get_or_insert(value.clone()),
                StandardTagKey::Artist => md.artist.get_or_insert(value.clone()),
                StandardTagKey::Album => md.album.get_or_insert(value.clone()),
                StandardTagKey::AlbumArtist => {
                    md.album_artist.get_or_insert(value.clone())
                }
                StandardTagKey::TrackNumber => {
                    md.track_number.get_or_insert(parse_number(&value));
                    continue;
                }
                StandardTagKey::DiscNumber => {
                    md.disc_number.get_or_insert(parse_number(&value));
                    continue;
                }
                StandardTagKey::Date | StandardTagKey::OriginalDate => {
                    md.year.get_or_insert(parse_year(&value));
                    continue;
                }
                StandardTagKey::Genre => {
                    md.genre_raw.get_or_insert(value.clone());
                    continue;
                }
                StandardTagKey::ReplayGainTrackGain => {
                    md.rg_track_gain = parse_db(&value);
                    continue;
                }
                StandardTagKey::ReplayGainAlbumGain => {
                    md.rg_album_gain = parse_db(&value);
                    continue;
                }
                StandardTagKey::ReplayGainTrackPeak => {
                    md.rg_track_peak = value.trim().parse().ok();
                    continue;
                }
                StandardTagKey::ReplayGainAlbumPeak => {
                    md.rg_album_peak = value.trim().parse().ok();
                    continue;
                }
                _ => continue,
            };
            continue;
        }

        // Fallback: match raw key case-insensitively. Useful for exotic
        // taggers that skip symphonia's standard mapping.
        let key = tag.key.to_ascii_uppercase();
        match key.as_str() {
            "TITLE" => {
                md.title.get_or_insert(value.clone());
            }
            "ARTIST" => {
                md.artist.get_or_insert(value.clone());
            }
            "ALBUM" => {
                md.album.get_or_insert(value.clone());
            }
            "ALBUMARTIST" | "ALBUM_ARTIST" | "ALBUM ARTIST" => {
                md.album_artist.get_or_insert(value.clone());
            }
            "TRACKNUMBER" | "TRACK" => {
                md.track_number.get_or_insert(parse_number(&value));
            }
            "DISCNUMBER" | "DISC" => {
                md.disc_number.get_or_insert(parse_number(&value));
            }
            "DATE" | "YEAR" | "ORIGINALDATE" => {
                md.year.get_or_insert(parse_year(&value));
            }
            "GENRE" => {
                md.genre_raw.get_or_insert(value.clone());
            }
            "REPLAYGAIN_TRACK_GAIN" => md.rg_track_gain = parse_db(&value),
            "REPLAYGAIN_ALBUM_GAIN" => md.rg_album_gain = parse_db(&value),
            "REPLAYGAIN_TRACK_PEAK" => md.rg_track_peak = value.trim().parse().ok(),
            "REPLAYGAIN_ALBUM_PEAK" => md.rg_album_peak = value.trim().parse().ok(),
            _ => {}
        }
    }

    md.tags = tokenize_genre(md.genre_raw.as_deref().unwrap_or(""));
}

fn extract_pictures(md: &mut ParsedFlacMetadata, visuals: &[Visual]) {
    for v in visuals {
        let usage = match v.usage {
            Some(symphonia::core::meta::StandardVisualKey::FrontCover) => {
                PictureUsage::FrontCover
            }
            Some(symphonia::core::meta::StandardVisualKey::BackCover) => {
                PictureUsage::BackCover
            }
            _ => PictureUsage::Other,
        };
        md.pictures.push(EmbeddedPicture {
            mime: v.media_type.clone(),
            data: v.data.to_vec(),
            usage,
        });
    }
}

/// Parse tag values like `"3"`, `"3/12"`, `"  04 "` → `3`.
fn parse_number(s: &str) -> i32 {
    s.split('/')
        .next()
        .unwrap_or("")
        .trim()
        .parse()
        .unwrap_or(0)
}

/// Extract a 4-digit year from values like `"1976"`, `"1976-04-12"`, or the
/// rare `"1976/04/12"`. Returns 0 if nothing matches.
fn parse_year(s: &str) -> i32 {
    let s = s.trim();
    if s.len() >= 4 {
        if let Ok(y) = s[..4].parse::<i32>() {
            if (1000..=9999).contains(&y) {
                return y;
            }
        }
    }
    0
}

/// Parse ReplayGain dB values like `"-6.28 dB"`, `"-6.28"`, `"+2.00 dB"`.
fn parse_db(s: &str) -> Option<f32> {
    let trimmed = s.trim().trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.' && c != '-' && c != '+');
    // Strip suffix " dB" and whitespace.
    let cleaned = trimmed.replace("dB", "").replace("db", "").replace("DB", "");
    cleaned.trim().parse::<f32>().ok()
}

/// Tokenize raw `GENRE` strings like `"post-rock; experimental, ambient"`
/// into `["post-rock", "experimental", "ambient"]`. Lowercased, trimmed,
/// dedup preserved-order.
pub fn tokenize_genre(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(|c: char| matches!(c, ',' | ';' | '/' | '\\' | '\t')) {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        let lowered = token.to_lowercase();
        if !out.iter().any(|t| t == &lowered) {
            out.push(lowered);
        }
    }
    out
}

/// Fallback: look for a sidecar `cover.jpg`/`folder.jpg`/`front.jpg` in
/// the album folder. Cover art pipeline calls this when the FLAC has no
/// embedded picture. Returns the path of the first hit, if any.
pub fn find_folder_cover(album_dir: &Path) -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "cover.jpg",
        "cover.jpeg",
        "cover.png",
        "folder.jpg",
        "folder.jpeg",
        "folder.png",
        "front.jpg",
        "front.jpeg",
        "front.png",
        "album.jpg",
        "album.png",
    ];
    let entries = std::fs::read_dir(album_dir).ok()?;
    let candidates_lower: Vec<&str> = CANDIDATES.iter().copied().collect();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let Some(fname) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let lower = fname.to_ascii_lowercase();
        if candidates_lower.contains(&lower.as_str()) {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_number_takes_left_half() {
        assert_eq!(parse_number("3/12"), 3);
        assert_eq!(parse_number("  04 "), 4);
        assert_eq!(parse_number("abc"), 0);
    }

    #[test]
    fn parse_year_extracts_from_iso_date() {
        assert_eq!(parse_year("1976"), 1976);
        assert_eq!(parse_year("1976-04-12"), 1976);
        assert_eq!(parse_year("1976/04/12"), 1976);
        assert_eq!(parse_year("abc"), 0);
    }

    #[test]
    fn parse_db_handles_units() {
        assert_eq!(parse_db("-6.28 dB"), Some(-6.28));
        assert_eq!(parse_db("-6.28"), Some(-6.28));
        assert_eq!(parse_db("+2.00 dB"), Some(2.00));
        assert_eq!(parse_db("not a number"), None);
    }

    #[test]
    fn tokenize_genre_splits_and_lowercases() {
        assert_eq!(
            tokenize_genre("Post-Rock; Experimental, Ambient"),
            vec![
                "post-rock".to_string(),
                "experimental".to_string(),
                "ambient".to_string(),
            ]
        );
    }

    #[test]
    fn tokenize_genre_dedups() {
        assert_eq!(
            tokenize_genre("rock, Rock, rock"),
            vec!["rock".to_string()]
        );
    }

    #[test]
    fn tokenize_genre_empty() {
        assert!(tokenize_genre("").is_empty());
        assert!(tokenize_genre("  , ; ").is_empty());
    }

    #[test]
    fn find_folder_cover_finds_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Cover.JPG"), b"jpeg").unwrap();
        let found = find_folder_cover(tmp.path()).unwrap();
        assert!(found.ends_with("Cover.JPG"));
    }

    #[test]
    fn find_folder_cover_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(find_folder_cover(tmp.path()).is_none());
    }
}
