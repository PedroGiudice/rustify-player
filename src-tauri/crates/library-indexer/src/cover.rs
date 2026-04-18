//! Cover art processing and caching.
//!
//! Takes a cover source (either raw bytes from a Vorbis PICTURE block or a
//! path to a sidecar file like `cover.jpg`) and produces a 600x600 WebP in
//! the cover cache directory. One cover per album.
//!
//! ## Resize strategy
//!
//! Target is a fixed 600x600 square. We resize the input to *fit* the square
//! (aspect-preserving, so the shorter axis hits 600), then center-crop to
//! 600x600. This is deliberate:
//!
//! - Album art in the wild is almost always already square (CD/LP scans,
//!   streaming service art). Resizing square-to-square is a no-op crop.
//! - When art is slightly off-square (rare rips with a thin border), a
//!   center-crop removes the border noise without distorting the image.
//! - Letterboxing (pad to square with a solid color) produces visible
//!   borders in the UI grid and is avoided.
//!
//! ## Encoding
//!
//! The `image` crate 0.25 ships a pure-Rust WebP encoder that only supports
//! **lossless** output. We use it as-is: no C libwebp dependency, no extra
//! build complexity. Lossless 600x600 cover WebPs land around 100-200KB each
//! for a library of ~100 albums — trivial on disk.
//!
//! ## Idempotency
//!
//! The cached filename is deterministic (SHA-1 of the `album_id`). If the
//! target file already exists and is non-empty, we short-circuit and return
//! its path without re-decoding or re-encoding. This matters for fs-watch
//! events that fire repeatedly for the same album during a rescan.
//!
//! ## Atomicity
//!
//! We encode to `<file>.tmp` and rename into place. If the process dies
//! mid-encode, the cache is left in a coherent state (either the old file
//! survives or nothing new appears — no partial WebP is ever observed).

#![allow(dead_code)]

use crate::error::IndexerError;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat};
use sha1::{Digest, Sha1};
use std::fs;
use std::path::{Path, PathBuf};

/// Target dimension for cached cover art. Square.
const TARGET_DIM: u32 = 600;

/// Where a cover image's bytes come from when processing.
#[derive(Debug, Clone)]
pub enum CoverSource {
    /// Raw image bytes, typically from the FLAC Vorbis `PICTURE` block.
    /// `mime_hint` comes from the PICTURE header (e.g. `"image/jpeg"`) and
    /// is only used for diagnostics — the actual format is auto-detected
    /// from the magic bytes by `image::load_from_memory`.
    EmbeddedBytes { data: Vec<u8>, mime_hint: String },
    /// Path to a sidecar image file discovered by
    /// [`crate::metadata::find_folder_cover`] (`cover.jpg`, `folder.png`, ...).
    FolderFile(PathBuf),
}

/// Compute the deterministic filename used to cache an album's cover.
///
/// Returns `<sha1-hex>.webp` where the hash is taken over the ASCII-decimal
/// representation of `album_id`. Always 40 hex chars + `".webp"` = 45 chars.
///
/// Using SHA-1 of the id (rather than the id itself) spreads files across
/// prefix buckets — useful if a future iteration shards the cover cache,
/// and cheap enough that there's no reason to revisit.
pub fn cover_filename(album_id: i64) -> String {
    let mut hasher = Sha1::new();
    hasher.update(album_id.to_string().as_bytes());
    let digest = hasher.finalize();
    format!("{:x}.webp", digest)
}

/// Process a cover image into a cached 600x600 WebP under
/// `<cache_dir>/covers/` and return the absolute path to the cached file.
///
/// Idempotent: if the target file already exists and is non-empty, returns
/// the existing path without decoding or re-encoding. See the module docs
/// for the resize and encoding strategy.
pub fn process_album_cover(
    album_id: i64,
    source: CoverSource,
    cache_dir: &Path,
) -> Result<PathBuf, IndexerError> {
    let covers_dir = cache_dir.join("covers");
    fs::create_dir_all(&covers_dir)?;

    let target_path = covers_dir.join(cover_filename(album_id));

    if let Ok(meta) = fs::metadata(&target_path) {
        if meta.is_file() && meta.len() > 0 {
            return Ok(target_path);
        }
    }

    let img = load_source(&source)?;
    let processed = fit_and_crop(img, TARGET_DIM);

    let tmp_path = target_path.with_extension("webp.tmp");
    {
        let mut out = fs::File::create(&tmp_path)?;
        processed
            .write_to(&mut out, ImageFormat::WebP)
            .map_err(IndexerError::from)?;
    }
    fs::rename(&tmp_path, &target_path)?;

    Ok(target_path)
}

fn load_source(source: &CoverSource) -> Result<DynamicImage, IndexerError> {
    match source {
        CoverSource::EmbeddedBytes { data, .. } => {
            image::load_from_memory(data).map_err(IndexerError::from)
        }
        CoverSource::FolderFile(path) => {
            let bytes = fs::read(path)?;
            image::load_from_memory(&bytes).map_err(IndexerError::from)
        }
    }
}

/// Resize `img` to fit a `target × target` square (aspect-preserving, so the
/// shorter axis becomes `target`) and center-crop to exactly `target × target`.
fn fit_and_crop(img: DynamicImage, target: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return DynamicImage::new_rgb8(target, target);
    }

    // Scale so the shorter edge equals `target`. The longer edge becomes
    // strictly greater than (or equal to) `target`, giving us material to
    // crop. Lanczos3 is the reference-quality downscaler for photographic
    // content.
    let scale = f64::from(target) / f64::from(w.min(h));
    let new_w = ((f64::from(w) * scale).round() as u32).max(target);
    let new_h = ((f64::from(h) * scale).round() as u32).max(target);
    let resized = img.resize_exact(new_w, new_h, FilterType::Lanczos3);

    let x = new_w.saturating_sub(target) / 2;
    let y = new_h.saturating_sub(target) / 2;
    resized.crop_imm(x, y, target, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder, Rgb, RgbImage};
    use std::thread;
    use std::time::Duration;

    fn synth_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(w, h, Rgb([180, 90, 40]));
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, 85)
            .encode(&img, w, h, ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    fn synth_png(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(w, h, Rgb([40, 140, 200]));
        let mut buf = Vec::new();
        PngEncoder::new(&mut buf)
            .write_image(&img, w, h, ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    #[test]
    fn cover_filename_is_deterministic() {
        let a = cover_filename(42);
        let b = cover_filename(42);
        assert_eq!(a, b);
        assert!(a.ends_with(".webp"));
        assert_eq!(a.len(), 45); // 40 hex + ".webp"
        let stem = a.trim_end_matches(".webp");
        assert_eq!(stem.len(), 40);
        assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn cover_filename_differs_across_ids() {
        assert_ne!(cover_filename(1), cover_filename(2));
        assert_ne!(cover_filename(42), cover_filename(4200));
    }

    #[test]
    fn process_embedded_jpeg_produces_600_webp() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = synth_jpeg(800, 600);
        let out = process_album_cover(
            7,
            CoverSource::EmbeddedBytes {
                data: bytes,
                mime_hint: "image/jpeg".into(),
            },
            tmp.path(),
        )
        .unwrap();

        assert!(out.exists());
        assert!(out.starts_with(tmp.path().join("covers")));

        let decoded = image::open(&out).unwrap();
        assert_eq!(decoded.dimensions(), (TARGET_DIM, TARGET_DIM));
    }

    #[test]
    fn process_folder_file_png_produces_600_webp() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("cover.png");
        fs::write(&src, synth_png(1024, 1024)).unwrap();

        let out = process_album_cover(13, CoverSource::FolderFile(src), tmp.path()).unwrap();

        assert!(out.exists());
        let decoded = image::open(&out).unwrap();
        assert_eq!(decoded.dimensions(), (TARGET_DIM, TARGET_DIM));
    }

    #[test]
    fn process_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = synth_jpeg(700, 700);

        let first = process_album_cover(
            99,
            CoverSource::EmbeddedBytes {
                data: bytes.clone(),
                mime_hint: "image/jpeg".into(),
            },
            tmp.path(),
        )
        .unwrap();

        let mtime1 = fs::metadata(&first).unwrap().modified().unwrap();

        // Some filesystems have 1s mtime granularity; sleep past it so a
        // hypothetical re-encode would be observable.
        thread::sleep(Duration::from_millis(1100));

        let second = process_album_cover(
            99,
            CoverSource::EmbeddedBytes {
                data: bytes,
                mime_hint: "image/jpeg".into(),
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(first, second);
        let mtime2 = fs::metadata(&second).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "second call must not rewrite the file");
    }

    #[test]
    fn fit_and_crop_wide_input() {
        let wide = DynamicImage::new_rgb8(1200, 600);
        let out = fit_and_crop(wide, TARGET_DIM);
        assert_eq!(out.dimensions(), (TARGET_DIM, TARGET_DIM));
    }

    #[test]
    fn fit_and_crop_tall_input() {
        let tall = DynamicImage::new_rgb8(600, 1200);
        let out = fit_and_crop(tall, TARGET_DIM);
        assert_eq!(out.dimensions(), (TARGET_DIM, TARGET_DIM));
    }

    #[test]
    fn fit_and_crop_exact_square() {
        let sq = DynamicImage::new_rgb8(TARGET_DIM, TARGET_DIM);
        let out = fit_and_crop(sq, TARGET_DIM);
        assert_eq!(out.dimensions(), (TARGET_DIM, TARGET_DIM));
    }
}
