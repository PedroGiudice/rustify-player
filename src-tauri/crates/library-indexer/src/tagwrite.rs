//! Escrita de tags Vorbis e capa em FLAC com `lofty`.
//!
//! Tudo que veio do upload é apagado antes (artista = URL do ripper etc.):
//! as tags finais são as confirmadas pelo CEO no card do Crate.

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag, TagType};
use std::path::Path;

pub struct TagSet<'a> {
    pub artist: &'a str,
    pub album_artist: &'a str,
    pub album: &'a str,
    pub title: &'a str,
    pub year: Option<u32>,
    pub track_no: u32,
    pub track_total: u32,
    pub genre: &'a str,
    pub label: Option<&'a str>,
    pub comment: Option<&'a str>,
}

pub fn write_tags(path: &Path, t: &TagSet<'_>, cover_jpeg: Option<&[u8]>) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| format!("lofty read: {e}"))?;
    // apaga tudo que veio do upload (artista = URL do ripper etc.)
    for tt in [TagType::VorbisComments, TagType::Id3v2, TagType::Id3v1, TagType::Ape] {
        tagged.remove(tt);
    }
    let mut tag = Tag::new(TagType::VorbisComments);
    tag.set_artist(t.artist.to_string());
    tag.insert_text(ItemKey::AlbumArtist, t.album_artist.to_string());
    tag.set_album(t.album.to_string());
    tag.set_title(t.title.to_string());
    // lofty 0.25 não tem `set_year`: o ano vai como DATE (ItemKey::RecordingDate),
    // que é o que `parse_flac` lê primeiro.
    if let Some(y) = t.year {
        tag.insert_text(ItemKey::RecordingDate, y.to_string());
    }
    tag.set_track(t.track_no);
    tag.set_track_total(t.track_total);
    tag.set_genre(t.genre.to_string());
    if let Some(l) = t.label {
        tag.insert_text(ItemKey::Label, l.to_string());
        tag.insert_text(ItemKey::Publisher, l.to_string());
    }
    if let Some(c) = t.comment {
        tag.set_comment(c.to_string());
    }
    if let Some(bytes) = cover_jpeg {
        tag.push_picture(
            Picture::unchecked(bytes.to_vec())
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Jpeg)
                .build(),
        );
    }
    tagged.insert_tag(tag);
    tagged.save_to_path(path, WriteOptions::default()).map_err(|e| format!("lofty save: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn write_tags_reescreve_tudo_e_embute_capa() {
        if !crate::transcode::ffmpeg_available() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let flac = tmp.path().join("t.flac");
        let st = std::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "artist=www.ripper.com", "-metadata", "title=LIXO", "-c:a", "flac"]).arg(&flac).status().unwrap();
        assert!(st.success());
        let cover = crate::resize_cover_jpeg(&solid_png(64, 64), 1500).unwrap();
        let tags = TagSet { artist: "DJ Arana", album_artist: "DJ Arana", album: "Festa do Pente Rala", title: "Festa do Pente Rala", year: Some(2024), track_no: 1, track_total: 1, genre: "Funk Brasileiro", label: None, comment: Some("source: lossy mp3") };
        write_tags(&flac, &tags, Some(&cover)).unwrap();
        let md = crate::parse_flac(&flac).unwrap();
        assert_eq!(md.artist.as_deref(), Some("DJ Arana"));
        assert_eq!(md.album_artist.as_deref(), Some("DJ Arana"));
        assert_eq!(md.title.as_deref(), Some("Festa do Pente Rala"));
        assert_eq!(md.year, Some(2024));
        assert_eq!(md.track_number, Some(1));
        assert_eq!(md.genre_raw.as_deref(), Some("Funk Brasileiro"));
        assert_eq!(md.pictures.len(), 1);
        assert_eq!(md.pictures[0].mime, "image/jpeg");
    }

    fn solid_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([30, 60, 140]));
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }
}
