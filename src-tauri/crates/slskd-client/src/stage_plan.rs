//! stage_plan.rs — destino canônico de staging. PURO: só manipulação de
//! `Path`/`String`, nenhuma I/O de disco (a etapa de mover de fato, com
//! detecção de colisão, mora em `src-tauri/src/slsk/stage.rs`, Etapa C).
//!
//! Layout: `<root>/<Playlist>/<Artist>/<YYYY - Album>/<NN - Title>.flac`.
//! É o layout que `scan.rs:7` documenta como canônico — corrige na origem
//! o bug de `artist = www.ftpdjemilio.com` que o `canonical_dest` de
//! 3 níveis do script antigo produzia (spec §5.4, P2).

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct TrackMeta {
    pub artist: Option<String>,
    pub album: Option<String>,
    pub title: Option<String>,
    pub track_no: Option<u32>,
    pub year: Option<u32>,
}

/// Constrói o destino canônico de 4 níveis. Fallbacks: sem álbum -> pasta
/// `Singles` sob o artista; sem artista -> pasta `_Compilations`; sem
/// título -> usa `fallback_basename` (o nome remoto original) como nome
/// final do arquivo, intacto.
pub fn canonical_dest(
    music_root: &Path,
    playlist: &str,
    md: &TrackMeta,
    fallback_basename: &str,
) -> PathBuf {
    let mut path = music_root.to_path_buf();
    path.push(sanitize_component(playlist));

    let artist_component = match non_empty(md.artist.as_deref()) {
        Some(artist) => sanitize_component(artist),
        None => "_Compilations".to_string(),
    };
    path.push(artist_component);

    let album_component = match non_empty(md.album.as_deref()) {
        Some(album) => {
            let label = match md.year {
                Some(year) => format!("{year} - {album}"),
                None => album.to_string(),
            };
            sanitize_component(&label)
        }
        None => "Singles".to_string(),
    };
    path.push(album_component);

    let filename = match non_empty(md.title.as_deref()) {
        Some(title) => {
            let stem = match md.track_no {
                Some(n) => format!("{n:02} - {title}"),
                None => title.to_string(),
            };
            format!("{}.flac", sanitize_component(&stem))
        }
        None => fallback_basename.to_string(),
    };
    path.push(filename);

    path
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// Remove `/`, `\` e `\0` (substituídos por espaço, depois colapsados —
/// evita colar palavras como "AC/DC" -> "ACDC"), trim, colapsa espaços,
/// capa em 120 bytes respeitando fronteira UTF-8.
pub fn sanitize_component(s: &str) -> String {
    let replaced: String = s
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | '\0') { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    cap_utf8_bytes(&collapsed, 120)
}

fn cap_utf8_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_dest_builds_four_level_path() {
        let root = Path::new("/home/cmr-auto/Music");
        let md = TrackMeta {
            artist: Some("Travis Scott".to_string()),
            album: Some("ASTROWORLD".to_string()),
            title: Some("SICKO MODE".to_string()),
            track_no: Some(3),
            year: Some(2018),
        };
        let dest = canonical_dest(root, "Rap & Hip-Hop", &md, "fallback.flac");
        assert_eq!(
            dest,
            PathBuf::from(
                "/home/cmr-auto/Music/Rap & Hip-Hop/Travis Scott/2018 - ASTROWORLD/03 - SICKO MODE.flac"
            )
        );
    }

    #[test]
    fn canonical_dest_singles_when_no_album() {
        let root = Path::new("/home/cmr-auto/Music");
        let md = TrackMeta {
            artist: Some("Robert Miles".to_string()),
            album: None,
            title: Some("Children".to_string()),
            track_no: None,
            year: None,
        };
        let dest = canonical_dest(root, "Trance", &md, "fallback.flac");
        assert_eq!(
            dest,
            PathBuf::from("/home/cmr-auto/Music/Trance/Robert Miles/Singles/Children.flac")
        );
    }

    #[test]
    fn canonical_dest_compilations_when_no_artist() {
        let root = Path::new("/home/cmr-auto/Music");
        let md = TrackMeta {
            artist: None,
            album: Some("Various Vol. 1".to_string()),
            title: Some("Track X".to_string()),
            track_no: Some(5),
            year: Some(2020),
        };
        let dest = canonical_dest(root, "Variety", &md, "fallback.flac");
        assert_eq!(
            dest,
            PathBuf::from(
                "/home/cmr-auto/Music/Variety/_Compilations/2020 - Various Vol. 1/05 - Track X.flac"
            )
        );
    }

    #[test]
    fn sanitize_component_slash_empty_unicode_cap() {
        assert_eq!(sanitize_component("AC/DC"), "AC DC");
        assert_eq!(sanitize_component("   "), "");
        assert_eq!(sanitize_component(""), "");

        let with_forbidden = "Café  Müller\\Bâtard\0";
        assert_eq!(sanitize_component(with_forbidden), "Café Müller Bâtard");

        let long = "a".repeat(200);
        let capped = sanitize_component(&long);
        assert_eq!(capped.len(), 120);
        assert_eq!(capped, "a".repeat(120));

        // Cap precisa cair em fronteira UTF-8 válida mesmo com multi-byte.
        let long_unicode = "é".repeat(100); // 200 bytes (cada 'é' = 2 bytes)
        let capped_unicode = sanitize_component(&long_unicode);
        assert!(capped_unicode.len() <= 120);
        assert!(std::str::from_utf8(capped_unicode.as_bytes()).is_ok());
    }
}
