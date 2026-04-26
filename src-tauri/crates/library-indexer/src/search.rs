//! Read-side queries for the library index.
//!
//! This module is the single source of truth for how the UI pulls data out
//! of the SQLite index. Every function takes an already-opened
//! [`rusqlite::Connection`] — the caller (usually the UI thread) borrows it
//! from [`crate::db::ReadPool::with`] or [`crate::db::ReadPool::spawn_read_conn`].
//! Keeping all query construction here means the SQL lives next to the
//! shape of [`Track`]/[`Album`]/[`Artist`] and we only pay the JOIN cost
//! in one place.
//!
//! ## FTS note
//!
//! The schema defines `tracks_fts` as a contentless FTS5 table
//! (`content=''`), so its `rowid` is NOT auto-synchronized with
//! `tracks.id`. The pipeline (see `pipeline.rs`) is responsible for
//! inserting matching rows into `tracks_fts` using the track's id as
//! the fts rowid whenever a track is upserted. The [`search`] function
//! below assumes that contract holds: it matches against `tracks_fts`,
//! takes the rowid, and treats it as a `tracks.id`. For album/artist
//! search we fall back to diacritic-insensitive `LIKE` over
//! `albums.title` / `artists.name` — FTS overhead for ~hundreds of
//! albums/artists is not worth it at MVP scale.
//!
//! ## Similarity note
//!
//! Embeddings are stored as little-endian `f32` BLOBs and are already
//! L2-normalized at ingest time, so cosine similarity reduces to a dot
//! product. We load all `embedding_status = 'done'` blobs into memory,
//! compute dot products against the anchor, sort, and fetch the
//! enriched [`Track`] rows for the top-K. Memory budget for 10k tracks
//! × 1024 × 4 bytes ≈ 40 MB — acceptable for MVP. If the library grows
//! past ~50k tracks, switch to the `sqlite-vec` extension. That's
//! explicitly outside this task's scope.

#![allow(dead_code)]

use rusqlite::{params, params_from_iter, Connection, Row};

use crate::error::IndexerError;
use crate::types::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbeddingStatus, Genre, MoodPlaylist,
    SearchResults, Track, TrackFilter, TrackOrder,
};

// ---------------------------------------------------------------------------
// SELECT templates
// ---------------------------------------------------------------------------

const TRACK_SELECT: &str = "
    SELECT t.id, t.path, t.filename,
           t.title, t.track_number, t.disc_number, t.duration_ms,
           t.album_id, al.title, al.year, al.cover_path,
           t.artist_id, ar.name,
           t.genre_id, g.name,
           t.sample_rate, t.bit_depth, t.channels,
           t.rg_track_gain, t.rg_album_gain, t.rg_track_peak, t.rg_album_peak,
           t.embedding_status, t.play_count, t.last_played, t.liked_at,
           (SELECT group_concat(tg.name, '||')
              FROM track_tags tt
              JOIN tags tg ON tg.id = tt.tag_id
             WHERE tt.track_id = t.id) AS tags_concat,
           t.lrc_path
      FROM tracks t
 LEFT JOIN albums  al ON al.id = t.album_id
 LEFT JOIN artists ar ON ar.id = t.artist_id
 LEFT JOIN genres  g  ON g.id  = t.genre_id
";

const ALBUM_SELECT: &str = "
    SELECT al.id, al.title, al.album_artist_id, ar.name, al.year, al.cover_path,
           (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count
      FROM albums al
 LEFT JOIN artists ar ON ar.id = al.album_artist_id
";

const ARTIST_SELECT: &str = "
    SELECT ar.id, ar.name, ar.sort_name,
           (SELECT COUNT(*) FROM tracks t  WHERE t.artist_id = ar.id)        AS track_count,
           (SELECT COUNT(*) FROM albums al WHERE al.album_artist_id = ar.id) AS album_count
      FROM artists ar
";

fn map_track(row: &Row<'_>) -> rusqlite::Result<Track> {
    let path_str: String = row.get(1)?;
    let cover_path_str: Option<String> = row.get(10)?;
    let embedding_status_str: String = row.get(22)?;
    let embedding_status = EmbeddingStatus::parse(&embedding_status_str)
        .unwrap_or(EmbeddingStatus::Pending);

    let tags_concat: Option<String> = row.get(26)?;
    let tags = tags_concat
        .as_deref()
        .map(|s| {
            s.split("||")
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let lrc_path_str: Option<String> = row.get(27)?;

    Ok(Track {
        id: row.get(0)?,
        path: path_str.into(),
        filename: row.get(2)?,

        title: row.get(3)?,
        track_number: row.get(4)?,
        disc_number: row.get(5)?,
        duration_ms: row.get(6)?,

        album_id: row.get(7)?,
        album_title: row.get(8)?,
        album_year: row.get(9)?,
        album_cover_path: cover_path_str.map(Into::into),

        artist_id: row.get(11)?,
        artist_name: row.get(12)?,

        genre_id: row.get(13)?,
        genre_name: row.get(14)?,

        tags,

        sample_rate: row.get::<_, i64>(15)? as u32,
        bit_depth: row.get::<_, i64>(16)? as u16,
        channels: row.get::<_, i64>(17)? as u16,

        rg_track_gain: row.get(18)?,
        rg_album_gain: row.get(19)?,
        rg_track_peak: row.get(20)?,
        rg_album_peak: row.get(21)?,

        embedding_status,
        play_count: row.get::<_, i64>(23)? as u32,
        last_played: row.get(24)?,
        liked_at: row.get(25)?,
        lrc_path: lrc_path_str.map(Into::into),
    })
}

fn map_album(row: &Row<'_>) -> rusqlite::Result<Album> {
    let cover_path_str: Option<String> = row.get(5)?;
    Ok(Album {
        id: row.get(0)?,
        title: row.get(1)?,
        album_artist_id: row.get(2)?,
        album_artist_name: row.get(3)?,
        year: row.get(4)?,
        cover_path: cover_path_str.map(Into::into),
        track_count: row.get::<_, Option<i64>>(6)?.map(|v| v as u32),
    })
}

fn map_artist(row: &Row<'_>) -> rusqlite::Result<Artist> {
    Ok(Artist {
        id: row.get(0)?,
        name: row.get(1)?,
        sort_name: row.get(2)?,
        track_count: row.get::<_, Option<i64>>(3)?.map(|v| v as u32),
        album_count: row.get::<_, Option<i64>>(4)?.map(|v| v as u32),
    })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn search(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<SearchResults, IndexerError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults {
            tracks: Vec::new(),
            albums: Vec::new(),
            artists: Vec::new(),
        });
    }

    let fts_query = build_fts_query(q);
    let mut track_ids: Vec<i64> = Vec::new();
    if !fts_query.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ? ORDER BY rank LIMIT ?",
        )?;
        let rows = stmt.query_map(params![fts_query, limit as i64], |r| r.get::<_, i64>(0))?;
        for id in rows {
            track_ids.push(id?);
        }
    }

    let tracks = if track_ids.is_empty() {
        Vec::new()
    } else {
        let fetched = fetch_tracks_by_ids(conn, &track_ids)?;
        let mut by_id: std::collections::HashMap<i64, Track> =
            fetched.into_iter().map(|t| (t.id, t)).collect();
        let mut out = Vec::with_capacity(track_ids.len());
        for id in &track_ids {
            if let Some(t) = by_id.remove(id) {
                out.push(t);
            }
        }
        out
    };

    let like = format!("%{}%", escape_like(q));
    let prefix_like = format!("{}%", escape_like(q));

    let albums = {
        let sql = format!(
            "{ALBUM_SELECT} WHERE al.title LIKE ? ESCAPE '\\' \
             ORDER BY (al.title LIKE ? ESCAPE '\\') DESC, al.title COLLATE NOCASE \
             LIMIT ?",
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                params![like, prefix_like, limit as i64],
                map_album,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let artists = {
        let sql = format!(
            "{ARTIST_SELECT} WHERE ar.name LIKE ? ESCAPE '\\' \
             ORDER BY (ar.name LIKE ? ESCAPE '\\') DESC, ar.name COLLATE NOCASE \
             LIMIT ?",
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                params![like, prefix_like, limit as i64],
                map_artist,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    Ok(SearchResults {
        tracks,
        albums,
        artists,
    })
}

pub fn list_tracks(
    conn: &Connection,
    filter: &TrackFilter,
) -> Result<Vec<Track>, IndexerError> {
    if filter.order == TrackOrder::Random {
        let seed = time_seed();
        let limit = filter.limit.unwrap_or(usize::MAX);
        return shuffle(conn, filter, seed, limit);
    }

    let (where_sql, params_vec) = build_track_where(filter);
    let order_sql = track_order_sql(filter.order);
    let limit_sql = match filter.limit {
        Some(n) => format!(" LIMIT {n}"),
        None => String::new(),
    };

    let sql = format!("{TRACK_SELECT}{where_sql}{order_sql}{limit_sql}");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params_vec.iter()), map_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_albums(
    conn: &Connection,
    filter: &AlbumFilter,
) -> Result<Vec<Album>, IndexerError> {
    let mut where_clauses: Vec<&'static str> = Vec::new();
    let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(genre_id) = filter.genre_id {
        where_clauses.push(
            "al.id IN (SELECT DISTINCT t.album_id FROM tracks t WHERE t.genre_id = ?)",
        );
        sql_params.push(Box::new(genre_id));
    }
    if let Some(artist_id) = filter.artist_id {
        where_clauses.push("al.album_artist_id = ?");
        sql_params.push(Box::new(artist_id));
    }

    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clauses.join(" AND "))
    };
    let limit_sql = match filter.limit {
        Some(n) => format!(" LIMIT {n}"),
        None => String::new(),
    };
    let sql = format!(
        "{ALBUM_SELECT}{where_sql} \
         ORDER BY al.year IS NULL, al.year DESC, al.title COLLATE NOCASE{limit_sql}",
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(sql_params.iter()), map_album)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_artists(
    conn: &Connection,
    filter: &ArtistFilter,
) -> Result<Vec<Artist>, IndexerError> {
    let mut where_clauses: Vec<&'static str> = Vec::new();
    let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(genre_id) = filter.genre_id {
        where_clauses.push(
            "ar.id IN (SELECT DISTINCT t.artist_id FROM tracks t WHERE t.genre_id = ?)",
        );
        sql_params.push(Box::new(genre_id));
    }

    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clauses.join(" AND "))
    };
    let limit_sql = match filter.limit {
        Some(n) => format!(" LIMIT {n}"),
        None => String::new(),
    };
    let sql = format!(
        "{ARTIST_SELECT}{where_sql} \
         ORDER BY COALESCE(ar.sort_name, ar.name) COLLATE NOCASE{limit_sql}",
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(sql_params.iter()), map_artist)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_genres(conn: &Connection) -> Result<Vec<Genre>, IndexerError> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, g.display_order,
                (SELECT COUNT(*) FROM tracks t WHERE t.genre_id = g.id) AS track_count
           FROM genres g
          ORDER BY g.display_order, g.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Genre {
                id: row.get(0)?,
                name: row.get(1)?,
                display_order: row.get::<_, i64>(2)? as i32,
                track_count: row.get::<_, Option<i64>>(3)?.map(|v| v as u32),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_track(conn: &Connection, id: i64) -> Result<Option<Track>, IndexerError> {
    let sql = format!("{TRACK_SELECT} WHERE t.id = ? LIMIT 1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(map_track(row)?)),
        None => Ok(None),
    }
}

/// Look up a track by its absolute filesystem path.
///
/// Used by the player bootstrap to enrich the engine's `TrackInfo`
/// (path + format only) with library metadata (title, artist, cover
/// path, lyrics path, ...) when a new track starts playing.
pub fn get_track_by_path(
    conn: &Connection,
    path: &std::path::Path,
) -> Result<Option<Track>, IndexerError> {
    let sql = format!("{TRACK_SELECT} WHERE t.path = ?1 LIMIT 1");
    let mut stmt = conn.prepare(&sql)?;
    let path_str = path.to_string_lossy().into_owned();
    let mut rows = stmt.query(params![path_str])?;
    match rows.next()? {
        Some(row) => Ok(Some(map_track(row)?)),
        None => Ok(None),
    }
}

pub fn get_album(conn: &Connection, id: i64) -> Result<Option<Album>, IndexerError> {
    let sql = format!("{ALBUM_SELECT} WHERE al.id = ? LIMIT 1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(map_album(row)?)),
        None => Ok(None),
    }
}

pub fn get_artist(conn: &Connection, id: i64) -> Result<Option<Artist>, IndexerError> {
    let sql = format!("{ARTIST_SELECT} WHERE ar.id = ? LIMIT 1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(map_artist(row)?)),
        None => Ok(None),
    }
}

pub fn similar(
    conn: &Connection,
    track_id: i64,
    limit: usize,
) -> Result<Vec<(Track, f32)>, IndexerError> {
    let anchor_blob: Option<Vec<u8>> = conn
        .query_row(
            "SELECT embedding FROM tracks \
             WHERE id = ? AND embedding_status = 'done'",
            params![track_id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .ok()
        .flatten();

    let Some(anchor_bytes) = anchor_blob else {
        return Ok(Vec::new());
    };
    let anchor = bytes_to_f32(&anchor_bytes);
    if anchor.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT id, embedding FROM tracks \
         WHERE embedding_status = 'done' AND id != ? AND embedding IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![track_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    let mut scored: Vec<(i64, f32)> = Vec::new();
    for row in rows {
        let (id, blob) = row?;
        let vec = bytes_to_f32(&blob);
        if vec.len() != anchor.len() {
            continue;
        }
        let score = dot(&anchor, &vec);
        scored.push((id, score));
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    if scored.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<i64> = scored.iter().map(|(id, _)| *id).collect();
    let tracks = fetch_tracks_by_ids(conn, &ids)?;

    let mut by_id: std::collections::HashMap<i64, Track> =
        tracks.into_iter().map(|t| (t.id, t)).collect();
    let mut out = Vec::with_capacity(scored.len());
    for (id, score) in scored {
        if let Some(track) = by_id.remove(&id) {
            out.push((track, score));
        }
    }
    Ok(out)
}

pub fn shuffle(
    conn: &Connection,
    filter: &TrackFilter,
    seed: u64,
    limit: usize,
) -> Result<Vec<Track>, IndexerError> {
    let (where_sql, params_vec) = build_track_where(filter);
    let sql = format!("SELECT t.id FROM tracks t{where_sql} ORDER BY t.id");
    let mut stmt = conn.prepare(&sql)?;
    let mut ids: Vec<i64> = stmt
        .query_map(params_from_iter(params_vec.iter()), |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    fisher_yates(&mut ids, seed);
    if ids.len() > limit {
        ids.truncate(limit);
    }

    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let tracks = fetch_tracks_by_ids(conn, &ids)?;
    let mut by_id: std::collections::HashMap<i64, Track> =
        tracks.into_iter().map(|t| (t.id, t)).collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(track) = by_id.remove(&id) {
            out.push(track);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Folder-based playlists
// ---------------------------------------------------------------------------

/// A folder inside the music root that contains tracks.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FolderPlaylist {
    /// Folder name relative to music_root (e.g. "Eletronica"). Empty string for root.
    pub name: String,
    pub track_count: u32,
}

/// List top-level subdirectories under `music_root` that contain indexed tracks.
pub fn list_folders(
    conn: &Connection,
    music_root: &str,
) -> Result<Vec<FolderPlaylist>, IndexerError> {
    let prefix = if music_root.ends_with('/') {
        music_root.to_string()
    } else {
        format!("{}/", music_root)
    };
    let prefix_len = prefix.len() as i64;

    let sql = "
        SELECT
            CASE
                WHEN instr(substr(path, ?1 + 1), '/') > 0
                THEN substr(substr(path, ?1 + 1), 1, instr(substr(path, ?1 + 1), '/') - 1)
                ELSE ''
            END as folder,
            count(*) as cnt
        FROM tracks
        WHERE path LIKE ?2 || '%'
        GROUP BY folder
        ORDER BY folder
    ";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(rusqlite::params![prefix_len, prefix], |row| {
            let name: String = row.get(0)?;
            let count: u32 = row.get(1)?;
            Ok(FolderPlaylist {
                name,
                track_count: count,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// List tracks inside a specific folder (relative to music_root).
/// Pass empty string for root-level tracks.
pub fn list_folder_tracks(
    conn: &Connection,
    music_root: &str,
    folder: &str,
) -> Result<Vec<Track>, IndexerError> {
    let prefix = if music_root.ends_with('/') {
        music_root.to_string()
    } else {
        format!("{}/", music_root)
    };

    let pattern = if folder.is_empty() {
        // Root: files directly in music_root (no subfolder)
        format!("{}%", prefix)
    } else {
        format!("{}{}/%", prefix, folder)
    };

    // For root, exclude files in subfolders
    let sql = if folder.is_empty() {
        format!(
            "{TRACK_SELECT} WHERE path LIKE ?1 AND instr(substr(path, ?2 + 1), '/') = 0 \
             ORDER BY t.title COLLATE NOCASE"
        )
    } else {
        format!(
            "{TRACK_SELECT} WHERE path LIKE ?1 \
             ORDER BY t.track_number, t.title COLLATE NOCASE"
        )
    };

    let mut stmt = conn.prepare(&sql)?;
    let prefix_len = prefix.len() as i64;
    let rows: Vec<Track> = if folder.is_empty() {
        stmt.query_map(rusqlite::params![pattern, prefix_len], map_track)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(rusqlite::params![pattern], map_track)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Playlist search (FTS + folder grouping)
// ---------------------------------------------------------------------------

/// A folder playlist with the matching tracks inside it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistSearchResult {
    pub folder: String,
    pub tracks: Vec<Track>,
}

/// Search tracks via FTS5 and group results by top-level folder relative to
/// `music_root`. Returns one [`PlaylistSearchResult`] per folder that has at
/// least one matching track.
pub fn search_playlists(
    conn: &Connection,
    music_root: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<PlaylistSearchResult>, IndexerError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let fts_query = build_fts_query(q);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let prefix = if music_root.ends_with('/') {
        music_root.to_string()
    } else {
        format!("{}/", music_root)
    };
    let prefix_len = prefix.len();

    // Find matching track IDs via FTS
    let mut stmt = conn.prepare(
        "SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ? ORDER BY rank LIMIT ?",
    )?;
    let track_ids: Vec<i64> = stmt
        .query_map(params![fts_query, limit as i64], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    if track_ids.is_empty() {
        return Ok(Vec::new());
    }

    let tracks = fetch_tracks_by_ids(conn, &track_ids)?;

    // Group by top-level folder
    let mut folder_map: std::collections::BTreeMap<String, Vec<Track>> =
        std::collections::BTreeMap::new();
    for track in tracks {
        let path_str = track.path.to_string_lossy();
        let folder = if path_str.starts_with(&prefix) {
            let rest = &path_str[prefix_len..];
            match rest.find('/') {
                Some(idx) => rest[..idx].to_string(),
                None => String::new(),
            }
        } else {
            String::new()
        };
        folder_map.entry(folder).or_default().push(track);
    }

    let results: Vec<PlaylistSearchResult> = folder_map
        .into_iter()
        .map(|(folder, tracks)| PlaylistSearchResult { folder, tracks })
        .collect();

    Ok(results)
}

// ---------------------------------------------------------------------------
// Playback history
// ---------------------------------------------------------------------------

/// Increment play count and set last_played to current unix timestamp.
pub fn record_play(conn: &Connection, track_id: i64) -> Result<(), IndexerError> {
    conn.execute(
        "UPDATE tracks SET play_count = play_count + 1, last_played = unixepoch() WHERE id = ?",
        [track_id],
    )?;
    Ok(())
}

/// Return recently played tracks, ordered by last_played DESC.
pub fn list_history(conn: &Connection, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let sql = format!(
        "{TRACK_SELECT} WHERE t.last_played IS NOT NULL ORDER BY t.last_played DESC LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([limit as i64], map_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Likes / Favorites
// ---------------------------------------------------------------------------

pub fn toggle_like(conn: &Connection, track_id: i64) -> Result<bool, IndexerError> {
    let currently_liked: bool = conn.query_row(
        "SELECT liked_at IS NOT NULL FROM tracks WHERE id = ?",
        [track_id],
        |row| row.get(0),
    )?;

    if currently_liked {
        conn.execute("UPDATE tracks SET liked_at = NULL WHERE id = ?", [track_id])?;
        Ok(false)
    } else {
        conn.execute(
            "UPDATE tracks SET liked_at = unixepoch() WHERE id = ?",
            [track_id],
        )?;
        Ok(true)
    }
}

pub fn list_liked(conn: &Connection, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let sql = format!(
        "{TRACK_SELECT} WHERE t.liked_at IS NOT NULL ORDER BY t.liked_at DESC LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([limit as i64], map_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn is_liked(conn: &Connection, track_id: i64) -> Result<bool, IndexerError> {
    let liked: bool = conn.query_row(
        "SELECT liked_at IS NOT NULL FROM tracks WHERE id = ?",
        [track_id],
        |row| row.get(0),
    )?;
    Ok(liked)
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/// Recommendations payload for the home view.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Recommendations {
    /// Tracks with highest play_count.
    pub most_played: Vec<Track>,
    /// Tracks similar to the most-played (excluding the seeds themselves).
    pub based_on_top: Vec<Track>,
    /// Unplayed tracks that are similar to user's favorites (discovery).
    pub discover: Vec<Track>,
}

/// Generate personalized recommendations from play history and embeddings.
pub fn recommendations(conn: &Connection) -> Result<Recommendations, IndexerError> {
    // Most played (top 10)
    let most_played_sql = format!(
        "{TRACK_SELECT} WHERE t.play_count > 0 ORDER BY t.play_count DESC LIMIT 10"
    );
    let most_played: Vec<Track> = conn
        .prepare(&most_played_sql)?
        .query_map([], map_track)?
        .collect::<Result<Vec<_>, _>>()?;

    // Build seed pool: liked tracks first (explicit signal), then top played
    let liked_ids: Vec<i64> = conn
        .prepare("SELECT id FROM tracks WHERE liked_at IS NOT NULL ORDER BY liked_at DESC LIMIT 10")?
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut seed_set: std::collections::HashSet<i64> = liked_ids.iter().copied().collect();
    let mut seed_ids: Vec<i64> = liked_ids;
    for t in most_played.iter().take(5) {
        if seed_set.insert(t.id) {
            seed_ids.push(t.id);
        }
    }
    seed_ids.truncate(10);

    let mut based_on_ids: std::collections::HashSet<i64> =
        seed_ids.iter().copied().collect();
    let mut based_on_top: Vec<Track> = Vec::new();

    for &seed_id in &seed_ids {
        if let Ok(sim) = similar(conn, seed_id, 5) {
            for (track, _score) in sim {
                if based_on_ids.insert(track.id) {
                    based_on_top.push(track);
                }
            }
        }
        if based_on_top.len() >= 10 {
            break;
        }
    }
    based_on_top.truncate(10);

    // Discover: unplayed tracks with embeddings, similar to top played
    let mut discover: Vec<Track> = Vec::new();
    let mut discover_ids: std::collections::HashSet<i64> =
        seed_ids.iter().copied().collect();
    for &seed_id in &seed_ids {
        if let Ok(sim) = similar(conn, seed_id, 10) {
            for (track, _score) in sim {
                if track.play_count == 0 && discover_ids.insert(track.id) {
                    discover.push(track);
                }
            }
        }
        if discover.len() >= 10 {
            break;
        }
    }
    discover.truncate(10);

    Ok(Recommendations {
        most_played,
        based_on_top,
        discover,
    })
}

// ---------------------------------------------------------------------------
// Mood Playlists
// ---------------------------------------------------------------------------

pub fn list_moods(conn: &Connection) -> Result<Vec<MoodPlaylist>, IndexerError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, track_count, accent_color, cover_path, created_at, updated_at \
         FROM mood_playlists ORDER BY name",
    )?;
    let rows = stmt
        .query_map([], |row| {
            let cover_str: Option<String> = row.get(4)?;
            Ok(MoodPlaylist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get::<_, i64>(2)? as u32,
                accent_color: row.get(3)?,
                cover_path: cover_str.map(Into::into),
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_mood_tracks(conn: &Connection, mood_id: i64) -> Result<Vec<Track>, IndexerError> {
    let sql = format!(
        "{TRACK_SELECT} \
         JOIN mood_playlist_tracks mpt ON mpt.track_id = t.id \
         WHERE mpt.mood_playlist_id = ? \
         ORDER BY mpt.distance ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([mood_id], map_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

/// Look up lyrics for a track. Preference order:
///
/// 1. LRC sidecar file at `lrc_path` (timed lyrics).
/// 2. `embedded_lyrics` text (one `LyricLine` per line, all `t == 0.0`).
///    The `t == 0.0` invariant signals "no timing" to the frontend.
/// 3. Empty vec.
pub fn get_lyrics(
    conn: &Connection,
    track_id: i64,
) -> Result<Vec<crate::lyrics::LyricLine>, IndexerError> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT lrc_path, embedded_lyrics FROM tracks WHERE id = ?",
            params![track_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .ok();

    let Some((lrc_path, embedded_lyrics)) = row else {
        return Ok(Vec::new());
    };

    // 1. Prefer sidecar LRC (timed).
    if let Some(p) = lrc_path {
        let path = std::path::Path::new(&p);
        if path.is_file() {
            return crate::lyrics::parse_lrc_file(path);
        }
    }

    // 2. Fall back to embedded lyrics (untimed).
    if let Some(text) = embedded_lyrics {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            let lines = trimmed
                .lines()
                .map(|line| crate::lyrics::LyricLine {
                    t: 0.0,
                    line: line.to_string(),
                    header: false,
                })
                .collect::<Vec<_>>();
            return Ok(lines);
        }
    }

    // 3. Nothing available.
    Ok(Vec::new())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn fetch_tracks_by_ids(
    conn: &Connection,
    ids: &[i64],
) -> Result<Vec<Track>, IndexerError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("{TRACK_SELECT} WHERE t.id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), map_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn build_track_where(filter: &TrackFilter) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(genre_id) = filter.genre_id {
        clauses.push("t.genre_id = ?".into());
        sql_params.push(Box::new(genre_id));
    }
    if let Some(artist_id) = filter.artist_id {
        clauses.push("t.artist_id = ?".into());
        sql_params.push(Box::new(artist_id));
    }
    if let Some(album_id) = filter.album_id {
        clauses.push("t.album_id = ?".into());
        sql_params.push(Box::new(album_id));
    }
    if !filter.tag_ids.is_empty() {
        let placeholders = vec!["?"; filter.tag_ids.len()].join(",");
        clauses.push(format!(
            "t.id IN (SELECT tt.track_id FROM track_tags tt \
             WHERE tt.tag_id IN ({placeholders}) \
             GROUP BY tt.track_id HAVING COUNT(DISTINCT tt.tag_id) = {})",
            filter.tag_ids.len()
        ));
        for tag_id in &filter.tag_ids {
            sql_params.push(Box::new(*tag_id));
        }
    }

    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (sql, sql_params)
}

fn track_order_sql(order: TrackOrder) -> &'static str {
    match order {
        TrackOrder::AlbumDiscTrack => {
            " ORDER BY t.album_id, t.disc_number, t.track_number, t.title COLLATE NOCASE"
        }
        TrackOrder::TitleAsc => " ORDER BY t.title COLLATE NOCASE",
        TrackOrder::RecentlyAdded => " ORDER BY t.indexed_at DESC",
        TrackOrder::LastPlayed => {
            " ORDER BY t.last_played IS NULL, t.last_played DESC"
        }
        TrackOrder::Random => {
            " ORDER BY t.album_id, t.disc_number, t.track_number"
        }
    }
}

fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn build_fts_query(query: &str) -> String {
    let cleaned: String = query
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.is_empty() {
        return String::new();
    }
    let (last, head) = tokens.split_last().expect("non-empty tokens");
    let mut parts: Vec<String> = head.iter().map(|t| (*t).to_owned()).collect();
    parts.push(format!("{last}*"));
    parts.join(" ")
}

fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    if bytes.len() % 4 != 0 {
        return Vec::new();
    }
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn xorshift64(state: &mut u64) -> u64 {
    if *state == 0 {
        *state = 0x9E37_79B9_7F4A_7C15;
    }
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

fn fisher_yates<T>(slice: &mut [T], seed: u64) {
    let mut state = seed;
    let n = slice.len();
    if n < 2 {
        return;
    }
    for i in (1..n).rev() {
        let r = xorshift64(&mut state);
        let j = (r % (i as u64 + 1)) as usize;
        slice.swap(i, j);
    }
}

fn time_seed() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| {
            let nanos = u64::from(d.subsec_nanos());
            d.as_secs()
                .wrapping_mul(1_000_000_007)
                .wrapping_add(nanos)
        })
        .unwrap_or(0x1234_5678_9ABC_DEF0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_and_migrate, upsert_album, upsert_artist, upsert_genre, upsert_tag};
    use rusqlite::{params, Connection};
    use tempfile::TempDir;

    fn fresh_db() -> (Connection, TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("library.db");
        let opened = open_and_migrate(&db_path).unwrap();
        (opened.writer, tmp)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_track(
        conn: &Connection,
        id: i64,
        title: &str,
        album_id: Option<i64>,
        artist_id: Option<i64>,
        genre_id: Option<i64>,
        track_number: Option<i32>,
        indexed_at: i64,
        embedding: Option<&[f32]>,
    ) {
        let (blob, status): (Option<Vec<u8>>, &str) = match embedding {
            Some(e) => {
                let mut bytes = Vec::with_capacity(e.len() * 4);
                for v in e {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
                (Some(bytes), "done")
            }
            None => (None, "pending"),
        };
        conn.execute(
            "INSERT INTO tracks
             (id, path, filename, mtime, size_bytes, title,
              track_number, disc_number, duration_ms,
              album_id, artist_id, genre_id,
              sample_rate, bit_depth, channels,
              embedding, embedding_status, indexed_at)
             VALUES
             (?, ?, ?, 0, 0, ?,
              ?, 1, 300000,
              ?, ?, ?,
              44100, 16, 2,
              ?, ?, ?)",
            params![
                id,
                format!("/tmp/{id}.flac"),
                format!("{id}.flac"),
                title,
                track_number,
                album_id,
                artist_id,
                genre_id,
                blob,
                status,
                indexed_at,
            ],
        )
        .unwrap();
    }

    fn attach_tag(conn: &Connection, track_id: i64, tag_id: i64) {
        conn.execute(
            "INSERT INTO track_tags (track_id, tag_id) VALUES (?, ?)",
            params![track_id, tag_id],
        )
        .unwrap();
    }

    #[test]
    fn list_tracks_empty_filter_returns_all() {
        let (conn, _tmp) = fresh_db();
        let artist = upsert_artist(&conn, "Artist A").unwrap();
        let album = upsert_album(&conn, "Album A", Some(artist), Some(2020)).unwrap();
        insert_track(&conn, 1, "T1", Some(album), Some(artist), None, Some(1), 10, None);
        insert_track(&conn, 2, "T2", Some(album), Some(artist), None, Some(2), 20, None);

        let filter = TrackFilter::default();
        let tracks = list_tracks(&conn, &filter).unwrap();
        assert_eq!(tracks.len(), 2);
    }

    #[test]
    fn list_tracks_filters_by_genre_and_artist() {
        let (conn, _tmp) = fresh_db();
        let rock = upsert_genre(&conn, "_Rock").unwrap();
        let jazz = upsert_genre(&conn, "_Jazz").unwrap();
        let a1 = upsert_artist(&conn, "A1").unwrap();
        let a2 = upsert_artist(&conn, "A2").unwrap();
        insert_track(&conn, 1, "R1", None, Some(a1), Some(rock), None, 1, None);
        insert_track(&conn, 2, "R2", None, Some(a2), Some(rock), None, 2, None);
        insert_track(&conn, 3, "J1", None, Some(a1), Some(jazz), None, 3, None);

        let only_rock = list_tracks(
            &conn,
            &TrackFilter {
                genre_id: Some(rock),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_rock.len(), 2);

        let only_a1 = list_tracks(
            &conn,
            &TrackFilter {
                artist_id: Some(a1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_a1.len(), 2);

        let rock_and_a1 = list_tracks(
            &conn,
            &TrackFilter {
                genre_id: Some(rock),
                artist_id: Some(a1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rock_and_a1.len(), 1);
        assert_eq!(rock_and_a1[0].title, "R1");
    }

    #[test]
    fn list_tracks_filters_by_tags_and() {
        let (conn, _tmp) = fresh_db();
        insert_track(&conn, 1, "T1", None, None, None, Some(1), 10, None);
        insert_track(&conn, 2, "T2", None, None, None, Some(2), 20, None);
        let ambient = upsert_tag(&conn, "ambient").unwrap();
        let chill = upsert_tag(&conn, "chill").unwrap();
        attach_tag(&conn, 1, ambient);
        attach_tag(&conn, 1, chill);
        attach_tag(&conn, 2, ambient);

        let both = list_tracks(
            &conn,
            &TrackFilter {
                tag_ids: vec![ambient, chill],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(both.len(), 1);
        assert_eq!(both[0].id, 1);
        assert!(both[0].tags.contains(&"ambient".to_string()));
        assert!(both[0].tags.contains(&"chill".to_string()));
    }

    #[test]
    fn list_tracks_respects_limit_and_title_order() {
        let (conn, _tmp) = fresh_db();
        insert_track(&conn, 1, "Charlie", None, None, None, None, 10, None);
        insert_track(&conn, 2, "Alpha", None, None, None, None, 20, None);
        insert_track(&conn, 3, "Bravo", None, None, None, None, 30, None);

        let tracks = list_tracks(
            &conn,
            &TrackFilter {
                order: TrackOrder::TitleAsc,
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Alpha");
        assert_eq!(tracks[1].title, "Bravo");
    }

    #[test]
    fn list_albums_orders_by_year_desc() {
        let (conn, _tmp) = fresh_db();
        let artist = upsert_artist(&conn, "Artist A").unwrap();
        let _old = upsert_album(&conn, "Old", Some(artist), Some(1990)).unwrap();
        let _new = upsert_album(&conn, "New", Some(artist), Some(2023)).unwrap();
        let _mid = upsert_album(&conn, "Mid", Some(artist), Some(2005)).unwrap();
        let _no_year = upsert_album(&conn, "NoYear", Some(artist), None).unwrap();

        let albums = list_albums(&conn, &AlbumFilter::default()).unwrap();
        let titles: Vec<_> = albums.iter().map(|a| a.title.as_str()).collect();
        assert_eq!(titles, vec!["New", "Mid", "Old", "NoYear"]);
    }

    #[test]
    fn list_artists_orders_alphabetically() {
        let (conn, _tmp) = fresh_db();
        upsert_artist(&conn, "Charlie").unwrap();
        upsert_artist(&conn, "alpha").unwrap();
        upsert_artist(&conn, "Bravo").unwrap();

        let artists = list_artists(&conn, &ArtistFilter::default()).unwrap();
        let names: Vec<_> = artists.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Bravo", "Charlie"]);
    }

    #[test]
    fn get_track_returns_none_for_missing_id() {
        let (conn, _tmp) = fresh_db();
        assert!(get_track(&conn, 9999).unwrap().is_none());
    }

    #[test]
    fn get_track_enriches_album_artist_genre_tags() {
        let (conn, _tmp) = fresh_db();
        let artist = upsert_artist(&conn, "Artist A").unwrap();
        let album = upsert_album(&conn, "Album A", Some(artist), Some(2020)).unwrap();
        let genre = upsert_genre(&conn, "_Rock").unwrap();
        insert_track(
            &conn,
            1,
            "Title",
            Some(album),
            Some(artist),
            Some(genre),
            Some(3),
            10,
            None,
        );
        let tag = upsert_tag(&conn, "loud").unwrap();
        attach_tag(&conn, 1, tag);

        let t = get_track(&conn, 1).unwrap().unwrap();
        assert_eq!(t.title, "Title");
        assert_eq!(t.album_title.as_deref(), Some("Album A"));
        assert_eq!(t.album_year, Some(2020));
        assert_eq!(t.artist_name.as_deref(), Some("Artist A"));
        assert_eq!(t.genre_name.as_deref(), Some("_Rock"));
        assert_eq!(t.tags, vec!["loud"]);
    }

    #[test]
    fn list_genres_returns_seeded_with_counts() {
        let (conn, _tmp) = fresh_db();
        let rock = upsert_genre(&conn, "_Rock").unwrap();
        insert_track(&conn, 1, "T1", None, None, Some(rock), None, 10, None);
        insert_track(&conn, 2, "T2", None, None, Some(rock), None, 20, None);

        let genres = list_genres(&conn).unwrap();
        assert_eq!(genres.len(), 16);
        let rock_row = genres.iter().find(|g| g.id == rock).unwrap();
        assert_eq!(rock_row.track_count, Some(2));
    }

    #[test]
    fn similar_returns_nearest_first() {
        let (conn, _tmp) = fresh_db();
        let anchor: Vec<f32> = vec![1.0, 0.0, 0.0, 0.0];
        let close: Vec<f32> = {
            let mut v = vec![0.9_f32, 0.1, 0.0, 0.0];
            let norm = (v.iter().map(|x| x * x).sum::<f32>()).sqrt();
            for x in &mut v {
                *x /= norm;
            }
            v
        };
        let far: Vec<f32> = vec![0.0, 1.0, 0.0, 0.0];
        insert_track(&conn, 1, "Anchor", None, None, None, Some(1), 10, Some(&anchor));
        insert_track(&conn, 2, "Close", None, None, None, Some(2), 20, Some(&close));
        insert_track(&conn, 3, "Far", None, None, None, Some(3), 30, Some(&far));

        let results = similar(&conn, 1, 10).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0.id, 2, "close track should rank first");
        assert_eq!(results[1].0.id, 3, "far track should rank last");
        assert!(results[0].1 > results[1].1);
    }

    #[test]
    fn similar_returns_empty_when_anchor_missing_embedding() {
        let (conn, _tmp) = fresh_db();
        insert_track(&conn, 1, "NoEmbed", None, None, None, None, 10, None);
        let results = similar(&conn, 1, 5).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn shuffle_is_deterministic_for_same_seed() {
        let (conn, _tmp) = fresh_db();
        for i in 1..=20 {
            insert_track(&conn, i, &format!("T{i}"), None, None, None, None, i, None);
        }
        let filter = TrackFilter::default();
        let a = shuffle(&conn, &filter, 42, 20).unwrap();
        let b = shuffle(&conn, &filter, 42, 20).unwrap();
        let ids_a: Vec<i64> = a.iter().map(|t| t.id).collect();
        let ids_b: Vec<i64> = b.iter().map(|t| t.id).collect();
        assert_eq!(ids_a, ids_b);
    }

    #[test]
    fn shuffle_different_seeds_give_different_orders() {
        let (conn, _tmp) = fresh_db();
        for i in 1..=20 {
            insert_track(&conn, i, &format!("T{i}"), None, None, None, None, i, None);
        }
        let filter = TrackFilter::default();
        let a = shuffle(&conn, &filter, 1, 20).unwrap();
        let b = shuffle(&conn, &filter, 99, 20).unwrap();
        let ids_a: Vec<i64> = a.iter().map(|t| t.id).collect();
        let ids_b: Vec<i64> = b.iter().map(|t| t.id).collect();
        assert_ne!(ids_a, ids_b, "two seeds should almost never collide");
    }

    #[test]
    fn shuffle_respects_limit_and_filter() {
        let (conn, _tmp) = fresh_db();
        let a1 = upsert_artist(&conn, "A1").unwrap();
        let a2 = upsert_artist(&conn, "A2").unwrap();
        for i in 1..=10 {
            insert_track(&conn, i, &format!("A{i}"), None, Some(a1), None, None, i, None);
        }
        for i in 11..=15 {
            insert_track(&conn, i, &format!("B{i}"), None, Some(a2), None, None, i, None);
        }
        let filter = TrackFilter {
            artist_id: Some(a1),
            ..Default::default()
        };
        let out = shuffle(&conn, &filter, 7, 3).unwrap();
        assert_eq!(out.len(), 3);
        for t in &out {
            assert_eq!(t.artist_id, Some(a1));
        }
    }

    #[test]
    fn bytes_to_f32_roundtrip() {
        let v = vec![1.0_f32, -0.5, 3.14, 0.0];
        let mut bytes = Vec::new();
        for x in &v {
            bytes.extend_from_slice(&x.to_le_bytes());
        }
        let decoded = bytes_to_f32(&bytes);
        assert_eq!(decoded, v);
    }

    #[test]
    fn bytes_to_f32_rejects_bad_length() {
        assert!(bytes_to_f32(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn escape_like_escapes_wildcards() {
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("a\\b"), "a\\\\b");
    }

    #[test]
    fn build_fts_query_appends_prefix_star() {
        assert_eq!(build_fts_query("hello world"), "hello world*");
        assert_eq!(build_fts_query("foo"), "foo*");
        assert_eq!(build_fts_query("  "), "");
    }
}
