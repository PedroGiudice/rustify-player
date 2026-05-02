//! Read-side queries backed by Qdrant.
//!
//! Replaces the old `search.rs` module. Every function takes `&QdrantClient`
//! instead of `&rusqlite::Connection`.

#![allow(dead_code)]

use crate::error::IndexerError;
use crate::qdrant_client::QdrantClient;
use crate::types::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbeddingStatus, Genre,
    SearchResults, Track, TrackFilter, TrackOrder,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Payload → type conversion
// ---------------------------------------------------------------------------

pub(crate) fn payload_to_track(id: u64, p: &Value) -> Track {
    let cover_str = p["cover_path"].as_str().map(PathBuf::from);
    let lrc_str = p["lrc_path"].as_str().map(PathBuf::from);
    let tags = p["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let status = p["embedding_status"].as_str().unwrap_or("pending");

    Track {
        id,
        path: PathBuf::from(p["path"].as_str().unwrap_or("")),
        filename: p["filename"].as_str().unwrap_or("").to_string(),
        title: p["title"].as_str().unwrap_or("").to_string(),
        track_number: p["track_number"].as_i64().map(|v| v as i32),
        disc_number: p["disc_number"].as_i64().unwrap_or(1) as i32,
        duration_ms: p["duration_ms"].as_i64().unwrap_or(0),
        album_title: p["album_title"].as_str().filter(|s| !s.is_empty()).map(String::from),
        album_year: p["album_year"].as_i64().map(|v| v as i32),
        album_cover_path: cover_str,
        artist_name: p["artist"].as_str().filter(|s| !s.is_empty()).map(String::from),
        genre_name: p["genre"].as_str().filter(|s| !s.is_empty()).map(String::from),
        tags,
        sample_rate: p["sample_rate"].as_u64().unwrap_or(44100) as u32,
        bit_depth: p["bit_depth"].as_u64().unwrap_or(16) as u16,
        channels: p["channels"].as_u64().unwrap_or(2) as u16,
        rg_track_gain: p["rg_track_gain"].as_f64().map(|v| v as f32),
        rg_album_gain: p["rg_album_gain"].as_f64().map(|v| v as f32),
        rg_track_peak: p["rg_track_peak"].as_f64().map(|v| v as f32),
        rg_album_peak: p["rg_album_peak"].as_f64().map(|v| v as f32),
        embedding_status: EmbeddingStatus::parse(status).unwrap_or(EmbeddingStatus::Pending),
        play_count: p["play_count"].as_u64().unwrap_or(0) as u32,
        last_played: p["last_played"].as_i64(),
        liked_at: p["liked_at"].as_i64(),
        lrc_path: lrc_str,
    }
}

// ---------------------------------------------------------------------------
// Single track lookups
// ---------------------------------------------------------------------------

pub fn get_track(client: &QdrantClient, id: u64) -> Result<Option<Track>, IndexerError> {
    match client.get_point(id)? {
        Some(point) => {
            let payload = &point["payload"];
            Ok(Some(payload_to_track(id, payload)))
        }
        None => Ok(None),
    }
}

pub fn get_track_by_path(
    client: &QdrantClient,
    path: &std::path::Path,
) -> Result<Option<Track>, IndexerError> {
    let id = crate::types::path_to_id(path);
    get_track(client, id)
}

// ---------------------------------------------------------------------------
// List queries
// ---------------------------------------------------------------------------

pub fn list_tracks(
    client: &QdrantClient,
    filter: &TrackFilter,
) -> Result<Vec<Track>, IndexerError> {
    let qdrant_filter = build_track_filter(filter);
    let order_key = match filter.order {
        TrackOrder::RecentlyAdded => Some("indexed_at"),
        TrackOrder::LastPlayed => Some("last_played"),
        _ => None,
    };
    let limit = filter.limit.unwrap_or(500);

    let results = client.scroll_with_filter(qdrant_filter, order_key, limit, false)?;
    let mut tracks: Vec<Track> = results
        .iter()
        .map(|(id, payload)| payload_to_track(*id, payload))
        .collect();

    match filter.order {
        TrackOrder::AlbumDiscTrack => {
            tracks.sort_by(|a, b| {
                a.album_title
                    .cmp(&b.album_title)
                    .then(a.disc_number.cmp(&b.disc_number))
                    .then(a.track_number.cmp(&b.track_number))
                    .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            });
        }
        TrackOrder::TitleAsc => {
            tracks.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        }
        TrackOrder::Random => {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            tracks.sort_by(|a, b| {
                let mut ha = DefaultHasher::new();
                a.id.hash(&mut ha);
                let mut hb = DefaultHasher::new();
                b.id.hash(&mut hb);
                ha.finish().cmp(&hb.finish())
            });
        }
        _ => {}
    }

    Ok(tracks)
}

fn build_track_filter(filter: &TrackFilter) -> Option<Value> {
    let mut must: Vec<Value> = Vec::new();

    if let Some(genre) = &filter.genre {
        must.push(json!({"key": "genre", "match": {"value": genre}}));
    }
    if let Some(artist) = &filter.artist {
        must.push(json!({"key": "artist_exact", "match": {"value": artist}}));
    }
    if let Some(album) = &filter.album {
        must.push(json!({"key": "album_title_exact", "match": {"value": album}}));
    }
    for tag in &filter.tags {
        must.push(json!({"key": "tags", "match": {"value": tag}}));
    }

    if must.is_empty() {
        None
    } else {
        Some(json!({"must": must}))
    }
}

// ---------------------------------------------------------------------------
// Aggregation (albums, artists, genres)
// ---------------------------------------------------------------------------

pub fn list_genres(client: &QdrantClient) -> Result<Vec<Genre>, IndexerError> {
    let all = client.scroll_all_payloads(&["genre"])?;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for (_, payload) in &all {
        if let Some(g) = payload["genre"].as_str() {
            if !g.is_empty() {
                *counts.entry(g.to_string()).or_default() += 1;
            }
        }
    }
    let mut genres: Vec<Genre> = counts
        .into_iter()
        .map(|(name, track_count)| Genre { name, track_count })
        .collect();
    genres.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(genres)
}

pub fn list_albums(
    client: &QdrantClient,
    filter: &AlbumFilter,
) -> Result<Vec<Album>, IndexerError> {
    let fields = &[
        "album_title",
        "artist",
        "album_year",
        "cover_path",
        "genre",
    ];
    let all = client.scroll_all_payloads(fields)?;

    let mut album_map: HashMap<String, Album> = HashMap::new();
    for (_, payload) in &all {
        let title = match payload["album_title"].as_str() {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        let artist = payload["artist"].as_str().filter(|s| !s.is_empty()).map(String::from);
        let genre = payload["genre"].as_str().unwrap_or("");

        if let Some(f_genre) = &filter.genre {
            if genre != f_genre {
                continue;
            }
        }
        if let Some(f_artist) = &filter.artist {
            if artist.as_deref() != Some(f_artist.as_str()) {
                continue;
            }
        }

        let key = format!(
            "{}|{}",
            title.to_lowercase(),
            artist.as_deref().unwrap_or("")
        );
        let entry = album_map.entry(key).or_insert_with(|| Album {
            title: title.to_string(),
            artist_name: artist.clone(),
            year: payload["album_year"].as_i64().map(|v| v as i32),
            cover_path: payload["cover_path"].as_str().map(PathBuf::from),
            track_count: 0,
        });
        entry.track_count += 1;
    }

    let mut albums: Vec<Album> = album_map.into_values().collect();
    albums.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    if let Some(limit) = filter.limit {
        albums.truncate(limit);
    }
    Ok(albums)
}

pub fn list_artists(
    client: &QdrantClient,
    filter: &ArtistFilter,
) -> Result<Vec<Artist>, IndexerError> {
    let fields = &["artist", "album_title", "genre"];
    let all = client.scroll_all_payloads(fields)?;

    let mut artist_tracks: HashMap<String, u32> = HashMap::new();
    let mut artist_albums: HashMap<String, HashSet<String>> = HashMap::new();
    for (_, payload) in &all {
        let name = match payload["artist"].as_str() {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        if let Some(f_genre) = &filter.genre {
            if payload["genre"].as_str().unwrap_or("") != f_genre {
                continue;
            }
        }
        *artist_tracks.entry(name.to_string()).or_default() += 1;
        if let Some(album) = payload["album_title"].as_str() {
            if !album.is_empty() {
                artist_albums
                    .entry(name.to_string())
                    .or_default()
                    .insert(album.to_string());
            }
        }
    }

    let mut artists: Vec<Artist> = artist_tracks
        .into_iter()
        .map(|(name, track_count)| {
            let album_count = artist_albums
                .get(&name)
                .map(|s| s.len() as u32)
                .unwrap_or(0);
            Artist {
                name,
                sort_name: None,
                track_count,
                album_count,
            }
        })
        .collect();
    artists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if let Some(limit) = filter.limit {
        artists.truncate(limit);
    }
    Ok(artists)
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

pub fn search(
    client: &QdrantClient,
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

    let filter = json!({
        "should": [
            {"key": "title", "match": {"text": q}},
            {"key": "artist", "match": {"text": q}},
            {"key": "album_title", "match": {"text": q}}
        ]
    });

    let results = client.scroll_with_filter(Some(filter), None, limit * 3, false)?;
    let tracks: Vec<Track> = results
        .iter()
        .map(|(id, payload)| payload_to_track(*id, payload))
        .take(limit)
        .collect();

    let mut seen_albums = HashSet::new();
    let mut albums = Vec::new();
    let mut seen_artists = HashSet::new();
    let mut artists = Vec::new();

    for t in &tracks {
        if let Some(album) = &t.album_title {
            let key = album.to_lowercase();
            if seen_albums.insert(key) && albums.len() < 5 {
                albums.push(Album {
                    title: album.clone(),
                    artist_name: t.artist_name.clone(),
                    year: t.album_year,
                    cover_path: t.album_cover_path.clone(),
                    track_count: 0,
                });
            }
        }
        if let Some(artist) = &t.artist_name {
            let key = artist.to_lowercase();
            if seen_artists.insert(key) && artists.len() < 5 {
                artists.push(Artist {
                    name: artist.clone(),
                    sort_name: None,
                    track_count: 0,
                    album_count: 0,
                });
            }
        }
    }

    Ok(SearchResults {
        tracks,
        albums,
        artists,
    })
}

// ---------------------------------------------------------------------------
// Playback history & likes
// ---------------------------------------------------------------------------

pub fn record_play(client: &QdrantClient, track_id: u64) -> Result<(), IndexerError> {
    let point = client.get_point(track_id)?;
    let current_count = point
        .as_ref()
        .and_then(|p| p["payload"]["play_count"].as_u64())
        .unwrap_or(0);
    let now = unix_now();

    client.set_payload(
        &[track_id],
        json!({
            "play_count": current_count + 1,
            "last_played": now
        }),
    )
}

pub fn list_history(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "last_played", "range": {"gt": 0}}]
    });
    let results = client.scroll_with_filter(Some(filter), Some("last_played"), limit, false)?;
    Ok(results
        .iter()
        .map(|(id, p)| payload_to_track(*id, p))
        .collect())
}

pub fn toggle_like(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    let point = client.get_point(track_id)?.ok_or_else(|| {
        IndexerError::Embedding(format!("track {track_id} not found"))
    })?;
    let currently_liked = point["payload"]["liked_at"].as_i64().is_some();

    if currently_liked {
        client.set_payload(&[track_id], json!({"liked_at": null}))?;
        Ok(false)
    } else {
        let now = unix_now();
        client.set_payload(&[track_id], json!({"liked_at": now}))?;
        Ok(true)
    }
}

pub fn list_liked(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "liked_at", "range": {"gt": 0}}]
    });
    let results = client.scroll_with_filter(Some(filter), Some("liked_at"), limit, false)?;
    Ok(results
        .iter()
        .map(|(id, p)| payload_to_track(*id, p))
        .collect())
}

pub fn is_liked(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    match client.get_point(track_id)? {
        Some(point) => Ok(point["payload"]["liked_at"].as_i64().is_some()),
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct Recommendations {
    pub most_played: Vec<Track>,
    pub based_on_top: Vec<Track>,
    pub discover: Vec<Track>,
}

pub fn recommendations(client: &QdrantClient) -> Result<Recommendations, IndexerError> {
    let filter = json!({"must": [{"key": "play_count", "range": {"gt": 0}}]});
    let results = client.scroll_with_filter(Some(filter), Some("play_count"), 10, false)?;
    let most_played: Vec<Track> = results
        .iter()
        .map(|(id, p)| payload_to_track(*id, p))
        .collect();

    let liked_filter = json!({"must": [{"key": "liked_at", "range": {"gt": 0}}]});
    let liked = client.scroll_with_filter(Some(liked_filter), Some("liked_at"), 10, false)?;
    let mut seed_ids: Vec<u64> = liked.iter().map(|(id, _)| *id).collect();
    for t in most_played.iter().take(5) {
        if !seed_ids.contains(&t.id) {
            seed_ids.push(t.id);
        }
    }
    seed_ids.truncate(10);

    let based_on_top = if !seed_ids.is_empty() {
        let positive: Vec<i64> = seed_ids.iter().map(|id| *id as i64).collect();
        let rec_ids = client.recommend(&positive, &[], 10)?;
        let mut tracks = Vec::new();
        for (tid, _score) in rec_ids {
            if let Some(t) = get_track(client, tid as u64)? {
                if !seed_ids.contains(&t.id) {
                    tracks.push(t);
                }
            }
        }
        tracks
    } else {
        Vec::new()
    };

    let discover = if !seed_ids.is_empty() {
        let positive: Vec<i64> = seed_ids.iter().map(|id| *id as i64).collect();
        let rec_ids = client.recommend(&positive, &[], 20)?;
        let mut tracks = Vec::new();
        for (tid, _score) in rec_ids {
            if let Some(t) = get_track(client, tid as u64)? {
                if t.play_count == 0 && !seed_ids.contains(&t.id) {
                    tracks.push(t);
                }
            }
        }
        tracks.truncate(10);
        tracks
    } else {
        Vec::new()
    };

    Ok(Recommendations {
        most_played,
        based_on_top,
        discover,
    })
}

// ---------------------------------------------------------------------------
// Similar, shuffle, folders
// ---------------------------------------------------------------------------

pub fn similar(
    client: &QdrantClient,
    track_id: u64,
    limit: usize,
) -> Result<Vec<(Track, f32)>, IndexerError> {
    let recs = client.recommend(&[track_id as i64], &[], limit)?;
    let mut results = Vec::new();
    for (tid, score) in recs {
        if let Some(t) = get_track(client, tid as u64)? {
            results.push((t, score as f32));
        }
    }
    Ok(results)
}

pub fn shuffle(
    client: &QdrantClient,
    filter: &TrackFilter,
    seed: u64,
    limit: usize,
) -> Result<Vec<Track>, IndexerError> {
    let fetch_filter = TrackFilter {
        limit: Some(limit * 3),
        genre: filter.genre.clone(),
        artist: filter.artist.clone(),
        album: filter.album.clone(),
        tags: filter.tags.clone(),
        order: TrackOrder::AlbumDiscTrack,
    };
    let mut tracks = list_tracks(client, &fetch_filter)?;
    let mut rng = seed;
    for i in (1..tracks.len()).rev() {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let j = (rng as usize) % (i + 1);
        tracks.swap(i, j);
    }
    tracks.truncate(limit);
    Ok(tracks)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FolderPlaylist {
    pub folder: String,
    pub track_count: u32,
    pub cover_path: Option<PathBuf>,
}

pub fn list_folders(
    client: &QdrantClient,
    music_root: &str,
) -> Result<Vec<FolderPlaylist>, IndexerError> {
    let all = client.scroll_all_payloads(&["path", "cover_path"])?;
    let mut folder_map: HashMap<String, (u32, Option<PathBuf>)> = HashMap::new();
    let root = std::path::Path::new(music_root);

    for (_, payload) in &all {
        let path_str = payload["path"].as_str().unwrap_or("");
        let path = std::path::Path::new(path_str);
        if let Ok(rel) = path.strip_prefix(root) {
            if let Some(parent) = rel.parent() {
                let folder = parent.to_string_lossy().to_string();
                if !folder.is_empty() {
                    let entry = folder_map.entry(folder).or_insert((0, None));
                    entry.0 += 1;
                    if entry.1.is_none() {
                        entry.1 = payload["cover_path"].as_str().map(PathBuf::from);
                    }
                }
            }
        }
    }

    let mut folders: Vec<FolderPlaylist> = folder_map
        .into_iter()
        .map(|(folder, (track_count, cover_path))| FolderPlaylist {
            folder,
            track_count,
            cover_path,
        })
        .collect();
    folders.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(folders)
}

pub fn list_folder_tracks(
    client: &QdrantClient,
    music_root: &str,
    folder: &str,
) -> Result<Vec<Track>, IndexerError> {
    let prefix = format!("{}/{}", music_root.trim_end_matches('/'), folder);
    let all = client.scroll_all_payloads(&[
        "path",
        "filename",
        "title",
        "track_number",
        "disc_number",
        "duration_ms",
        "album_title",
        "album_year",
        "cover_path",
        "artist",
        "genre",
        "tags",
        "sample_rate",
        "bit_depth",
        "channels",
        "rg_track_gain",
        "rg_album_gain",
        "rg_track_peak",
        "rg_album_peak",
        "embedding_status",
        "play_count",
        "last_played",
        "liked_at",
        "lrc_path",
    ])?;

    let mut tracks: Vec<Track> = all
        .iter()
        .filter(|(_, p)| {
            p["path"]
                .as_str()
                .map(|s| s.starts_with(&prefix))
                .unwrap_or(false)
        })
        .map(|(id, p)| payload_to_track(*id, p))
        .collect();
    tracks.sort_by(|a, b| {
        a.disc_number
            .cmp(&b.disc_number)
            .then(a.track_number.cmp(&b.track_number))
            .then(a.title.cmp(&b.title))
    });
    Ok(tracks)
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

pub fn get_lyrics(
    client: &QdrantClient,
    track_id: u64,
) -> Result<Vec<crate::lyrics::LyricLine>, IndexerError> {
    let point = match client.get_point(track_id)? {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let payload = &point["payload"];

    if let Some(lrc) = payload["lrc_path"].as_str() {
        let path = std::path::Path::new(lrc);
        if path.is_file() {
            return crate::lyrics::parse_lrc_file(path);
        }
    }

    if let Some(text) = payload["embedded_lyrics"].as_str() {
        if !text.trim().is_empty() {
            let lines = text
                .trim()
                .lines()
                .map(|line| crate::lyrics::LyricLine {
                    t: 0.0,
                    line: line.to_string(),
                    header: false,
                })
                .collect();
            return Ok(lines);
        }
    }

    Ok(Vec::new())
}

// ---------------------------------------------------------------------------
// Autoplay
// ---------------------------------------------------------------------------

pub fn autoplay_next(
    client: &QdrantClient,
    seed_track_id: u64,
    exclude_ids: &[u64],
    limit: usize,
) -> Result<Vec<(u64, f64)>, IndexerError> {
    let neg: Vec<i64> = exclude_ids.iter().map(|id| *id as i64).collect();
    let recs = client.recommend(&[seed_track_id as i64], &neg, limit)?;
    Ok(recs.iter().map(|(id, score)| (*id as u64, *score)).collect())
}

// ---------------------------------------------------------------------------
// Playlist search (folder-based)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistSearchResult {
    pub folder: String,
    pub tracks: Vec<Track>,
}

pub fn search_playlists(
    client: &QdrantClient,
    music_root: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<PlaylistSearchResult>, IndexerError> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let folders = list_folders(client, music_root)?;
    let matching: Vec<&FolderPlaylist> = folders
        .iter()
        .filter(|f| f.folder.to_lowercase().contains(&q))
        .take(limit)
        .collect();

    let mut results = Vec::new();
    for f in matching {
        let tracks = list_folder_tracks(client, music_root, &f.folder)?;
        results.push(PlaylistSearchResult {
            folder: f.folder.clone(),
            tracks,
        });
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
