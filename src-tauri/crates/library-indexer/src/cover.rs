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

/// Extract a *vibrant* dominant color from a cover as a hex string.
///
/// v1 (resize-to-1x1 = global average) blends complementary hues into mud.
/// v2 quantized into hue×sat×light buckets, but vivid families still split
/// their vote across bucket boundaries — red wraps the hue circle (350°..10°
/// lands in two bins) and sat/light bands split further — so a busy vivid
/// cover could lose to one big washed-out bucket, and the winner's plain
/// mean diluted the color. v3 elects a HUE FAMILY first, then finds its
/// saturated core:
///
/// Pass 1 — 24 wrap-aware hue bins, smoothed with the neighbors
/// ([0.25, 0.5, 0.25]) so family votes re-merge across bin edges. Votes are
/// weighted by chroma (s^1.5) and mid-lightness. Achromatic pixels
/// (s < 0.08) vote in a separate "gray" party that only wins when nothing
/// chromatic has real presence — grayscale covers stay grayscale.
///
/// Pass 2 — representative INSIDE the family (winner bin ± 1, wrap-aware):
/// weighted mean with s² × mid-lightness, so the saturated core defines the
/// color and washed-out members stop diluting it.
pub fn dominant_color(source: &CoverSource) -> Option<String> {
    dominant_palette(source, 1)?.into_iter().next()
}

/// Bins do histograma de hue (15° cada) — compartilhado pelos 2 passes.
const HUE_BINS: usize = 24;
/// Saturação abaixo disto vota no partido acromático.
const ACHROMATIC_S: f64 = 0.08;
/// Separação mínima (em bins, wrap-aware) entre famílias da paleta: 3
/// bins = 45° — evita devolver três tons da mesma cor.
const PALETTE_MIN_HUE_DIST: usize = 3;
/// Piso de relevância de uma família extra: fração dos votos da
/// vencedora. Abaixo disto é detalhe/ruído, não cor da capa.
const PALETTE_VOTE_FLOOR: f64 = 0.22;

/// Paleta dominante da capa: até `max_colors` famílias de hue DISTINTAS,
/// ordenadas por densidade de voto (área × saturação^1.5 × luminância
/// útil). O item 0 reproduz `dominant_color` (mesma eleição, mesmo núcleo
/// saturado — `dominant_color` é wrapper com max_colors=1). Famílias
/// extras exigem separação de hue >= 45° e votos >= 22% da vencedora;
/// capas monocromáticas rendem 1 cor, bicromáticas 2, etc. Capa
/// essencialmente acromática rende 1 cinza (identidade preservada).
pub fn dominant_palette(source: &CoverSource, max_colors: usize) -> Option<Vec<String>> {
    if max_colors == 0 {
        return Some(Vec::new());
    }
    let img = load_source(source).ok()?;
    let small = img.resize_exact(48, 48, FilterType::Triangle).to_rgb8();

    let light_w = |l: f64| (1.0 - (l - 0.5).abs() * 1.6).max(0.10);

    // Pass 1: eleição das famílias de hue (+ partido acromático).
    let mut votes = [0f64; HUE_BINS];
    let mut gray = (0f64, 0f64, 0f64, 0f64); // (peso, r, g, b)
    for px in small.pixels() {
        let r = f64::from(px[0]) / 255.0;
        let g = f64::from(px[1]) / 255.0;
        let b = f64::from(px[2]) / 255.0;
        let (h, s, l) = rgb_to_hsl(r, g, b);
        if s < ACHROMATIC_S {
            let w = 0.15 * light_w(l);
            gray.0 += w;
            gray.1 += r * w;
            gray.2 += g * w;
            gray.3 += b * w;
        } else {
            let hb = ((h * HUE_BINS as f64) as usize).min(HUE_BINS - 1);
            votes[hb] += s.powf(1.5) * light_w(l);
        }
    }

    let mut smooth = [0f64; HUE_BINS];
    for i in 0..HUE_BINS {
        let prev = votes[(i + HUE_BINS - 1) % HUE_BINS];
        let next = votes[(i + 1) % HUE_BINS];
        smooth[i] = 0.25 * prev + 0.5 * votes[i] + 0.25 * next;
    }
    let (win, &win_votes) = smooth
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))?;

    // Sem presença cromática real: capa acromática fica acromática (1 cor).
    if win_votes * 4.0 < gray.0 || win_votes <= f64::EPSILON {
        if gray.0 <= f64::EPSILON {
            return None;
        }
        let to8 = |v: f64| ((v / gray.0) * 255.0).round().clamp(0.0, 255.0) as u8;
        return Some(vec![format!(
            "#{:02x}{:02x}{:02x}",
            to8(gray.1),
            to8(gray.2),
            to8(gray.3)
        )]);
    }

    // Eleição multi-pico: maior voto entre bins não excluídos; cada
    // vencedor exclui a vizinhança (< PALETTE_MIN_HUE_DIST, wrap-aware).
    let wrap_dist = |a: usize, b: usize| {
        let d = a.abs_diff(b);
        d.min(HUE_BINS - d)
    };
    let mut winners: Vec<usize> = vec![win];
    while winners.len() < max_colors {
        let cand = smooth
            .iter()
            .enumerate()
            .filter(|(i, _)| winners.iter().all(|w| wrap_dist(*i, *w) >= PALETTE_MIN_HUE_DIST))
            .max_by(|a, b| a.1.total_cmp(b.1));
        match cand {
            Some((i, &v)) if v >= win_votes * PALETTE_VOTE_FLOOR && v > f64::EPSILON => {
                winners.push(i);
            }
            _ => break,
        }
    }

    // Pass 2 por família: núcleo saturado (win ± 1, com wrap).
    let mut accs = vec![(0f64, 0f64, 0f64, 0f64); winners.len()];
    for px in small.pixels() {
        let r = f64::from(px[0]) / 255.0;
        let g = f64::from(px[1]) / 255.0;
        let b = f64::from(px[2]) / 255.0;
        let (h, s, l) = rgb_to_hsl(r, g, b);
        if s < ACHROMATIC_S {
            continue;
        }
        let hb = ((h * HUE_BINS as f64) as usize).min(HUE_BINS - 1);
        if let Some(fi) = winners.iter().position(|w| wrap_dist(hb, *w) <= 1) {
            let w = s * s * light_w(l);
            let acc = &mut accs[fi];
            acc.0 += w;
            acc.1 += r * w;
            acc.2 += g * w;
            acc.3 += b * w;
        }
    }

    let palette: Vec<String> = accs
        .into_iter()
        .filter(|acc| acc.0 > f64::EPSILON)
        .map(|acc| {
            let to8 = |v: f64| ((v / acc.0) * 255.0).round().clamp(0.0, 255.0) as u8;
            format!("#{:02x}{:02x}{:02x}", to8(acc.1), to8(acc.2), to8(acc.3))
        })
        .collect();
    if palette.is_empty() {
        return None;
    }
    Some(palette)
}

/// RGB (0..1) → HSL (all 0..1). Hue 0..1 wraps the circle.
fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f64::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if (max - r).abs() < f64::EPSILON {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
    } else if (max - g).abs() < f64::EPSILON {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    (h, s, l)
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

    fn png_bytes(img: &RgbImage) -> Vec<u8> {
        let mut buf = Vec::new();
        PngEncoder::new(&mut buf)
            .write_image(img, img.width(), img.height(), ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    fn hex_rgb(hex: &str) -> (i32, i32, i32) {
        (
            i32::from_str_radix(&hex[1..3], 16).unwrap(),
            i32::from_str_radix(&hex[3..5], 16).unwrap(),
            i32::from_str_radix(&hex[5..7], 16).unwrap(),
        )
    }

    #[test]
    fn dominant_palette_two_color_cover_yields_two_families_by_density() {
        // 55% vermelho + 35% azul + 10% cinza: duas famílias reais,
        // vermelho mais denso → [vermelho, azul].
        let mut img = RgbImage::from_pixel(60, 60, Rgb([128, 128, 128]));
        for y in 0..60 {
            for x in 0..33 {
                img.put_pixel(x, y, Rgb([200, 30, 30]));
            }
            for x in 33..54 {
                img.put_pixel(x, y, Rgb([30, 60, 200]));
            }
        }
        let palette = dominant_palette(
            &CoverSource::EmbeddedBytes { data: png_bytes(&img), mime_hint: String::new() },
            3,
        )
        .expect("paleta extraída");
        assert_eq!(palette.len(), 2, "esperava 2 famílias, veio {palette:?}");
        let (r0, g0, b0) = hex_rgb(&palette[0]);
        assert!(r0 > 150 && g0 < 90 && b0 < 90, "palette[0] devia ser vermelho: {palette:?}");
        let (r1, _g1, b1) = hex_rgb(&palette[1]);
        assert!(b1 > 120 && r1 < 100, "palette[1] devia ser azul: {palette:?}");
    }

    #[test]
    fn dominant_palette_same_hue_gradient_collapses_to_one() {
        // Tons do MESMO azul (luminâncias variadas) → 1 família, não 3.
        let mut img = RgbImage::new(60, 60);
        for y in 0..60 {
            for x in 0..60 {
                let l = 60 + ((x * 2) as u8);
                img.put_pixel(x, y, Rgb([l / 4, l / 2, l]));
            }
        }
        let palette = dominant_palette(
            &CoverSource::EmbeddedBytes { data: png_bytes(&img), mime_hint: String::new() },
            3,
        )
        .expect("paleta extraída");
        assert_eq!(palette.len(), 1, "gradiente monocromático devia render 1 cor: {palette:?}");
    }

    #[test]
    fn dominant_palette_first_item_matches_dominant_color() {
        let mut img = RgbImage::from_pixel(60, 60, Rgb([128, 128, 128]));
        for y in 0..60 {
            for x in 0..18 {
                img.put_pixel(x, y, Rgb([200, 30, 30]));
            }
        }
        let src = CoverSource::EmbeddedBytes { data: png_bytes(&img), mime_hint: String::new() };
        let single = dominant_color(&src).expect("cor");
        let palette = dominant_palette(&src, 3).expect("paleta");
        assert_eq!(palette[0], single, "palette[0] deve reproduzir dominant_color");
    }

    #[test]
    fn dominant_palette_grayscale_yields_single_gray() {
        let img = RgbImage::from_pixel(60, 60, Rgb([90, 90, 90]));
        let palette = dominant_palette(
            &CoverSource::EmbeddedBytes { data: png_bytes(&img), mime_hint: String::new() },
            3,
        )
        .expect("paleta extraída");
        assert_eq!(palette.len(), 1);
        let (r, g, b) = hex_rgb(&palette[0]);
        assert!((r - g).abs() <= 6 && (g - b).abs() <= 6, "cinza devia ficar cinza: {palette:?}");
    }

    #[test]
    fn dominant_palette_weak_speck_below_floor_is_ignored() {
        // 92% vermelho + ~4% verde: o verde fica abaixo do piso de
        // relevância (fração dos votos da vencedora) → 1 cor só.
        let mut img = RgbImage::from_pixel(60, 60, Rgb([200, 30, 30]));
        for y in 0..60 {
            for x in 0..2 {
                img.put_pixel(x, y, Rgb([30, 200, 40]));
            }
        }
        let palette = dominant_palette(
            &CoverSource::EmbeddedBytes { data: png_bytes(&img), mime_hint: String::new() },
            3,
        )
        .expect("paleta extraída");
        assert_eq!(palette.len(), 1, "verde de 4% não é família: {palette:?}");
    }

    #[test]
    fn dominant_color_prefers_saturated_over_gray_majority() {
        // 70% cinza médio + 30% vermelho saturado. A média global daria um
        // marrom-acinzentado; o extractor v2 deve devolver o VERMELHO (a cor
        // de identidade da capa), não o blend.
        let mut img = RgbImage::from_pixel(60, 60, Rgb([128, 128, 128]));
        for y in 0..60 {
            for x in 0..18 {
                img.put_pixel(x, y, Rgb([200, 30, 30]));
            }
        }
        let mut buf = Vec::new();
        PngEncoder::new(&mut buf)
            .write_image(&img, 60, 60, ExtendedColorType::Rgb8)
            .unwrap();
        let hex = dominant_color(&CoverSource::EmbeddedBytes {
            data: buf,
            mime_hint: String::new(),
        })
        .expect("cor extraída");
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap();
        let g = u8::from_str_radix(&hex[3..5], 16).unwrap();
        let b = u8::from_str_radix(&hex[5..7], 16).unwrap();
        assert!(
            r > 150 && g < 90 && b < 90,
            "esperava vermelho dominante, veio {hex}"
        );
    }

    #[test]
    fn dominant_color_grayscale_cover_stays_gray() {
        let img = RgbImage::from_pixel(60, 60, Rgb([90, 90, 90]));
        let mut buf = Vec::new();
        PngEncoder::new(&mut buf)
            .write_image(&img, 60, 60, ExtendedColorType::Rgb8)
            .unwrap();
        let hex = dominant_color(&CoverSource::EmbeddedBytes {
            data: buf,
            mime_hint: String::new(),
        })
        .expect("cor extraída");
        let r = i32::from_str_radix(&hex[1..3], 16).unwrap();
        let g = i32::from_str_radix(&hex[3..5], 16).unwrap();
        let b = i32::from_str_radix(&hex[5..7], 16).unwrap();
        assert!(
            (r - g).abs() <= 6 && (g - b).abs() <= 6,
            "capa cinza deve continuar cinza, veio {hex}"
        );
    }

    #[test]
    fn dominant_color_red_family_survives_hue_wrap() {
        // 80% cinza + 10% vermelho h≈357° + 10% vermelho h≈8°. Na v2 o
        // vermelho dividia o voto em dois buckets (wrap do círculo de hue)
        // e o cinza vencia; a v3 re-funde a família via smoothing wrap-aware.
        let mut img = RgbImage::from_pixel(60, 60, Rgb([128, 128, 128]));
        for y in 0..60 {
            for x in 0..6 {
                img.put_pixel(x, y, Rgb([200, 30, 40])); // h ≈ 357°
            }
            for x in 6..12 {
                img.put_pixel(x, y, Rgb([200, 50, 30])); // h ≈ 8°
            }
        }
        let mut buf = Vec::new();
        PngEncoder::new(&mut buf)
            .write_image(&img, 60, 60, ExtendedColorType::Rgb8)
            .unwrap();
        let hex = dominant_color(&CoverSource::EmbeddedBytes {
            data: buf,
            mime_hint: String::new(),
        })
        .expect("cor extraída");
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap();
        let g = u8::from_str_radix(&hex[3..5], 16).unwrap();
        assert!(
            r > 150 && g < 90,
            "família vermelha devia vencer o cinza majoritário, veio {hex}"
        );
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
