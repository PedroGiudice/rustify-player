//! Public types for the library indexer API.
//!
//! Denormalized model backed by Qdrant payloads. No integer foreign keys —
//! artist, album, genre are string fields on each track point.

#![allow(dead_code)]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Top-level genre, aggregated from track payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Genre {
    pub name: String,
    pub track_count: u32,
}

/// Artist, aggregated from track payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artist {
    pub name: String,
    pub sort_name: Option<String>,
    pub track_count: u32,
    pub album_count: u32,
}

/// Album, aggregated from track payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Album {
    pub title: String,
    pub artist_name: Option<String>,
    pub year: Option<i32>,
    pub cover_path: Option<PathBuf>,
    pub track_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingStatus {
    Pending,
    Done,
    Failed,
}

impl EmbeddingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            EmbeddingStatus::Pending => "pending",
            EmbeddingStatus::Done => "done",
            EmbeddingStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Track point from Qdrant with denormalized metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    #[serde(serialize_with = "serialize_u64_as_string", deserialize_with = "deserialize_u64_from_string")]
    pub id: u64,
    pub path: PathBuf,
    pub filename: String,

    pub title: String,
    pub track_number: Option<i32>,
    pub disc_number: i32,
    pub duration_ms: i64,

    pub album_title: Option<String>,
    pub album_year: Option<i32>,
    pub album_cover_path: Option<PathBuf>,

    pub artist_name: Option<String>,

    pub genre_name: Option<String>,

    pub tags: Vec<String>,

    pub sample_rate: u32,
    pub bit_depth: u16,
    pub channels: u16,

    pub rg_track_gain: Option<f32>,
    pub rg_album_gain: Option<f32>,
    pub rg_track_peak: Option<f32>,
    pub rg_album_peak: Option<f32>,

    pub embedding_status: EmbeddingStatus,
    pub play_count: u32,
    pub last_played: Option<i64>,
    pub liked_at: Option<i64>,

    pub lrc_path: Option<PathBuf>,
}

/// Filter applied to list_tracks queries.
#[derive(Debug, Clone, Default)]
pub struct TrackFilter {
    pub genre: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub tags: Vec<String>,
    pub limit: Option<usize>,
    pub order: TrackOrder,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TrackOrder {
    #[default]
    AlbumDiscTrack,
    TitleAsc,
    RecentlyAdded,
    LastPlayed,
    Random,
}

#[derive(Debug, Clone, Default)]
pub struct AlbumFilter {
    pub genre: Option<String>,
    pub artist: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct ArtistFilter {
    pub genre: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub artists: Vec<Artist>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoodPlaylist {
    pub id: i64,
    pub name: String,
    pub track_count: u32,
    pub accent_color: Option<String>,
    pub cover_path: Option<PathBuf>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Commands driving the indexer.
#[derive(Debug, Clone)]
pub enum IndexerCommand {
    Rescan,
    Shutdown,
}

/// Events broadcast by the indexer coordinator.
#[derive(Debug, Clone)]
pub enum IndexerEvent {
    ScanStarted,
    ScanProgress {
        processed: u64,
        total: u64,
    },
    ScanDone {
        added: u64,
        updated: u64,
        removed: u64,
    },
    TrackAdded(Box<Track>),
    TrackUpdated(Box<Track>),
    TrackRemoved(u64),
    ModelDownloadStarted {
        url: String,
        bytes_total: Option<u64>,
    },
    ModelDownloadProgress {
        bytes_done: u64,
        bytes_total: Option<u64>,
    },
    ModelDownloadDone,
    EmbeddingProgress {
        done: u64,
        pending: u64,
    },
    EmbeddingDone {
        track_id: u64,
    },
    Error(String),
}

/// Cheap status snapshot for the UI status bar.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct IndexerSnapshot {
    pub tracks_total: u64,
    pub embeddings_done: u64,
    pub embeddings_pending: u64,
    pub embeddings_failed: u64,
    pub scan_in_progress: bool,
}

fn serialize_u64_as_string<S: serde::Serializer>(val: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&val.to_string())
}

fn deserialize_u64_from_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let s = String::deserialize(d)?;
    s.parse::<u64>().map_err(serde::de::Error::custom)
}

/// Deterministic point ID from filesystem path.
pub fn path_to_id(path: &std::path::Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}
