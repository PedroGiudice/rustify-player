//! Escrita de tags Vorbis e capa em FLAC com `lofty`.
//!
//! Substitui os blocos VORBIS_COMMENT e PICTURE do arquivo inteiros (artista =
//! URL do ripper etc. some junto): as tags finais são as confirmadas pelo CEO
//! no card do Crate. Um prefixo ID3v2 que o FLAC de origem traga não é tocado
//! (o lofty não o remove ao salvar FLAC); o leitor do app o ignora.
//!
//! As chaves são gravadas cruas em `VorbisComments` porque o `Tag` genérico do
//! lofty 0.25 não produz ORGANIZATION (vira LABEL) e grava PUBLISHER no lugar.

use lofty::config::WriteOptions;
use lofty::ogg::tag::VorbisComments;
use lofty::ogg::OggPictureStorage;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
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
    let mut vc = VorbisComments::default();
    let mut put = |k: &str, v: String| vc.push(k.to_string(), v);
    put("ARTIST", t.artist.to_string());
    put("ALBUMARTIST", t.album_artist.to_string());
    put("ALBUM", t.album.to_string());
    put("TITLE", t.title.to_string());
    if let Some(y) = t.year {
        put("DATE", y.to_string());
    }
    put("TRACKNUMBER", t.track_no.to_string());
    put("TRACKTOTAL", t.track_total.to_string());
    put("GENRE", t.genre.to_string());
    if let Some(l) = t.label {
        put("LABEL", l.to_string());
        put("ORGANIZATION", l.to_string());
    }
    if let Some(c) = t.comment {
        put("COMMENT", c.to_string());
    }
    if let Some(bytes) = cover_jpeg {
        let pic = Picture::unchecked(bytes.to_vec())
            .pic_type(PictureType::CoverFront)
            .mime_type(MimeType::Jpeg)
            .build();
        vc.insert_picture(pic, None).map_err(|e| format!("capa: {e}"))?;
    }
    vc.save_to_path(path, WriteOptions::default()).map_err(|e| format!("lofty save: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcode::{ffmpeg_available, Tools};

    fn raw_comments(path: &Path) -> Vec<(String, String)> {
        use lofty::config::ParseOptions;
        use lofty::file::AudioFile;
        let mut f = std::fs::File::open(path).unwrap();
        let flac = lofty::flac::FlacFile::read_from(&mut f, ParseOptions::new()).unwrap();
        flac.vorbis_comments()
            .map(|vc| vc.items().map(|(k, v)| (k.to_string(), v.to_string())).collect())
            .unwrap_or_default()
    }

    fn get<'a>(items: &'a [(String, String)], k: &str) -> Vec<&'a str> {
        items.iter().filter(|(kk, _)| kk.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str()).collect()
    }

    #[test]
    fn write_tags_reescreve_tudo_e_embute_capa() {
        if !ffmpeg_available(&Tools::default()) { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        // origem com tags de ripper E capa anexada: no fim deve restar 1 PICTURE só.
        let old_cover = tmp.path().join("velha.jpg");
        std::fs::write(&old_cover, crate::resize_cover_jpeg(&solid_png(32, 32), 1500).unwrap()).unwrap();
        let flac = tmp.path().join("t.flac");
        let st = std::process::Command::new("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-i"])
            .arg(&old_cover)
            .args(["-map", "0:a", "-map", "1:v", "-c:a", "flac", "-c:v", "copy", "-disposition:v", "attached_pic",
                   "-metadata", "artist=www.ripper.com", "-metadata", "title=LIXO", "-metadata", "publisher=Lixo"])
            .arg(&flac).status().unwrap();
        assert!(st.success());
        assert_eq!(crate::parse_flac(&flac).unwrap().pictures.len(), 1, "fixture precisa ter capa prévia");
        let cover = crate::resize_cover_jpeg(&solid_png(64, 64), 1500).unwrap();
        let tags = TagSet { artist: "DJ Arana", album_artist: "DJ Arana", album: "Festa do Pente Rala", title: "Festa do Pente Rala", year: Some(2024), track_no: 1, track_total: 3, genre: "Funk Brasileiro", label: Some("Selo X"), comment: Some("source: lossy mp3") };
        write_tags(&flac, &tags, Some(&cover)).unwrap();
        let md = crate::parse_flac(&flac).unwrap();
        assert_eq!(md.artist.as_deref(), Some("DJ Arana"));
        assert_eq!(md.album_artist.as_deref(), Some("DJ Arana"));
        assert_eq!(md.title.as_deref(), Some("Festa do Pente Rala"));
        assert_eq!(md.year, Some(2024));
        assert_eq!(md.track_number, Some(1));
        assert_eq!(md.genre_raw.as_deref(), Some("Funk Brasileiro"));
        assert_eq!(md.pictures.len(), 1, "capa velha substituída, não somada");
        assert_eq!(md.pictures[0].mime, "image/jpeg");
        assert_eq!(md.pictures[0].data.len(), cover.len(), "a capa que ficou é a nova");

        let raw = raw_comments(&flac);
        assert_eq!(get(&raw, "ALBUM"), ["Festa do Pente Rala"]);
        assert_eq!(get(&raw, "COMMENT"), ["source: lossy mp3"]);
        assert_eq!(get(&raw, "TRACKTOTAL"), ["3"]);
        assert_eq!(get(&raw, "LABEL"), ["Selo X"]);
        assert_eq!(get(&raw, "ORGANIZATION"), ["Selo X"]);
        assert!(get(&raw, "PUBLISHER").is_empty(), "{raw:?}");
        assert_eq!(get(&raw, "ARTIST"), ["DJ Arana"], "artista do ripper não pode sobrar");
    }

    #[test]
    fn write_tags_sem_selo_nem_comentario_omite_as_chaves() {
        if !ffmpeg_available(&Tools::default()) { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let flac = tmp.path().join("t.flac");
        let st = std::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "flac"]).arg(&flac).status().unwrap();
        assert!(st.success());
        let tags = TagSet { artist: "A", album_artist: "A", album: "B", title: "C", year: None, track_no: 2, track_total: 2, genre: "G", label: None, comment: None };
        write_tags(&flac, &tags, None).unwrap();
        let raw = raw_comments(&flac);
        for k in ["LABEL", "ORGANIZATION", "COMMENT", "DATE"] {
            assert!(get(&raw, k).is_empty(), "{k} não deveria existir: {raw:?}");
        }
        assert_eq!(crate::parse_flac(&flac).unwrap().pictures.len(), 0);
    }

    fn solid_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([30, 60, 140]));
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }
}
