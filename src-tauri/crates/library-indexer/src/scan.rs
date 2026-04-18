//! Filesystem walker + path-based genre/artist/album extraction.
//!
//! The indexer primary source of genre is the folder structure under
//! `music_root`, following the canonical layout:
//!
//! ```text
//! <music_root>/<Genre>/<Artist>/<YYYY - Album>/NN - Title.flac
//! ```
//!
//! Compilations use `_Compilations` as the artist segment.
//!
//! Non-canonical paths (tracks at the root, tracks one level deep, etc.)
//! are still walked and returned — the pipeline then falls back to parsing
//! Vorbis tags.

#![allow(dead_code)]

use crate::error::IndexerError;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tracing::warn;
use walkdir::WalkDir;

/// One discovered FLAC file with optional path-derived metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct FileEntry {
    pub path: PathBuf,
    pub mtime: u64,
    pub size: u64,
    pub genre_from_path: Option<String>,
    pub album_artist_from_path: Option<String>,
    pub album_from_path: Option<String>,
    pub year_from_path: Option<i32>,
    pub is_compilation: bool,
}

/// Walk the music root and yield one [`FileEntry`] per `.flac` file.
/// Hidden directories (starting with `.`) are skipped. Dead symlinks are
/// skipped with a warning.
pub fn walk_music_root(
    music_root: &Path,
) -> Result<impl Iterator<Item = FileEntry>, IndexerError> {
    if !music_root.exists() {
        return Err(IndexerError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("music_root does not exist: {}", music_root.display()),
        )));
    }

    let root = music_root.to_path_buf();
    let iter = WalkDir::new(&root)
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        // Skip hidden dirs (.quarentena, .Trash-1000, etc) but always allow
        // the root itself — it may live under a hidden parent (e.g. tempdirs
        // on Linux create under `/tmp/.tmpXXXXXX`).
        .filter_entry(|e| e.depth() == 0 || !is_hidden(e.path()))
        .filter_map(move |res| match res {
            Ok(entry) => {
                if !entry.file_type().is_file() {
                    return None;
                }
                let path = entry.path();
                if !is_flac(path) {
                    return None;
                }
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(e) => {
                        warn!(target: "library_indexer::scan", ?path, error = %e, "metadata read failed");
                        return None;
                    }
                };
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let parts = extract_path_parts(&root, path);
                Some(FileEntry {
                    path: path.to_path_buf(),
                    mtime,
                    size: meta.len(),
                    genre_from_path: parts.genre,
                    album_artist_from_path: parts.album_artist,
                    album_from_path: parts.album_title,
                    year_from_path: parts.year,
                    is_compilation: parts.is_compilation,
                })
            }
            Err(e) => {
                warn!(target: "library_indexer::scan", error = %e, "walkdir entry failed");
                None
            }
        });
    Ok(iter)
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

fn is_flac(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("flac"))
        .unwrap_or(false)
}

struct PathParts {
    genre: Option<String>,
    album_artist: Option<String>,
    album_title: Option<String>,
    year: Option<i32>,
    is_compilation: bool,
}

fn extract_path_parts(root: &Path, file: &Path) -> PathParts {
    let rel = match file.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => {
            return PathParts {
                genre: None,
                album_artist: None,
                album_title: None,
                year: None,
                is_compilation: false,
            };
        }
    };

    // Components excluding the filename itself.
    let comps: Vec<&str> = rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    // comps = [Genre, Artist, YYYY - Album, filename] in canonical case.
    // But we tolerate shorter/longer paths.
    let dir_comps = if comps.is_empty() {
        &[][..]
    } else {
        &comps[..comps.len() - 1]
    };

    let genre = dir_comps.first().map(|s| s.to_string());
    let album_artist_raw = dir_comps.get(1).map(|s| s.to_string());
    let is_compilation = album_artist_raw
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("_Compilations"))
        .unwrap_or(false);
    let album_artist = if is_compilation {
        None
    } else {
        album_artist_raw
    };

    let (year, album_title) = dir_comps
        .get(2)
        .map(|s| parse_album_folder(s))
        .unwrap_or((None, None));

    PathParts {
        genre,
        album_artist,
        album_title,
        year,
        is_compilation,
    }
}

/// Parse an album folder name of the form `"YYYY - Title"` or
/// `"YYYY-Title"`. Returns `(Some(year), Some(title))` on match, or
/// `(None, Some(title))` when the folder name is just a title without a
/// year prefix.
pub fn parse_album_folder(name: &str) -> (Option<i32>, Option<String>) {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return (None, None);
    }

    // Prefix of 4 digits, optional whitespace, '-', optional whitespace, rest.
    let bytes = trimmed.as_bytes();
    if bytes.len() < 5 || !bytes[..4].iter().all(|b| b.is_ascii_digit()) {
        return (None, Some(trimmed.to_string()));
    }

    let year: i32 = match trimmed[..4].parse() {
        Ok(y) if (1000..=9999).contains(&y) => y,
        _ => return (None, Some(trimmed.to_string())),
    };

    let rest = trimmed[4..].trim_start();
    if !rest.starts_with('-') {
        return (None, Some(trimmed.to_string()));
    }
    let title = rest[1..].trim().to_string();
    if title.is_empty() {
        return (Some(year), None);
    }
    (Some(year), Some(title))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_canonical_album_folder() {
        assert_eq!(
            parse_album_folder("1976 - Alucinação"),
            (Some(1976), Some("Alucinação".to_string()))
        );
        assert_eq!(
            parse_album_folder("2018 - Bluesman"),
            (Some(2018), Some("Bluesman".to_string()))
        );
    }

    #[test]
    fn parse_album_folder_without_year() {
        assert_eq!(
            parse_album_folder("Greatest Hits"),
            (None, Some("Greatest Hits".to_string()))
        );
    }

    #[test]
    fn parse_album_folder_with_tight_hyphen() {
        assert_eq!(
            parse_album_folder("1999-Millennium"),
            (Some(1999), Some("Millennium".to_string()))
        );
    }

    #[test]
    fn parse_album_folder_ignores_fake_year_prefix() {
        assert_eq!(
            parse_album_folder("123 - NotAYear"),
            (None, Some("123 - NotAYear".to_string()))
        );
    }

    #[test]
    fn parse_album_folder_handles_empty() {
        assert_eq!(parse_album_folder(""), (None, None));
        assert_eq!(parse_album_folder("   "), (None, None));
    }

    #[test]
    fn walk_extracts_canonical_path_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let album_dir = root.join("Rap & Hip-Hop/Baco Exu do Blues/2018 - Bluesman");
        fs::create_dir_all(&album_dir).unwrap();
        let file = album_dir.join("01 - Queima Minha Pele.flac");
        fs::write(&file, b"fake flac").unwrap();

        // Decoy non-flac file.
        fs::write(album_dir.join("cover.jpg"), b"jpg").unwrap();

        let entries: Vec<_> = walk_music_root(root).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.path, file);
        assert_eq!(e.genre_from_path.as_deref(), Some("Rap & Hip-Hop"));
        assert_eq!(
            e.album_artist_from_path.as_deref(),
            Some("Baco Exu do Blues")
        );
        assert_eq!(e.album_from_path.as_deref(), Some("Bluesman"));
        assert_eq!(e.year_from_path, Some(2018));
        assert!(!e.is_compilation);
    }

    #[test]
    fn walk_detects_compilations() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let comp_dir = root.join("Eletrônica/_Compilations/2023 - Best of Ibiza");
        fs::create_dir_all(&comp_dir).unwrap();
        fs::write(comp_dir.join("01 - Track.flac"), b"fake").unwrap();

        let entries: Vec<_> = walk_music_root(root).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert!(e.is_compilation);
        assert_eq!(e.album_artist_from_path, None);
        assert_eq!(e.album_from_path.as_deref(), Some("Best of Ibiza"));
    }

    #[test]
    fn walk_skips_hidden_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".quarentena/2026-04-18")).unwrap();
        fs::write(
            root.join(".quarentena/2026-04-18/broken.flac"),
            b"fake",
        )
        .unwrap();
        // Good file at root just to verify we iterate at all.
        fs::create_dir_all(root.join("Rock/Artist/2000 - Album")).unwrap();
        fs::write(
            root.join("Rock/Artist/2000 - Album/01 - Song.flac"),
            b"fake",
        )
        .unwrap();

        let entries: Vec<_> = walk_music_root(root).unwrap().collect();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].path.to_string_lossy().contains("Rock"));
    }

    #[test]
    fn walk_handles_tracks_at_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("orphan.flac"), b"fake").unwrap();

        let entries: Vec<_> = walk_music_root(root).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.genre_from_path, None);
        assert_eq!(e.album_artist_from_path, None);
        assert_eq!(e.album_from_path, None);
        assert_eq!(e.year_from_path, None);
    }
}
