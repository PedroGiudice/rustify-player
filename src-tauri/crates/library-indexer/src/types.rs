//! Public types for the library indexer API.
//!
//! Mirrors the shape of the SQLite schema but adds derived fields (e.g.
//! resolved genre/artist names alongside IDs) so callers don't have to
//! re-query to render.

#![allow(dead_code)]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Top-level genre (curated seed, editable via Settings).
#[derive(Debug, Clone, PartialEq, Eq)]
#[derive(Serialize, Deserialize)]
pub struct Genre {
    pub id: i64,
    pub name: String,
    pub display_order: i32,
    pub track_count: Option<u32>,
}

/// Artist. Deduplicated case-insensitively.
#[derive(Debug, Clone, PartialEq, Eq)]
#[derive(Serialize, Deserialize)]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub sort_name: Option<String>,
    pub track_count: Option<u32>,
    pub album_count: Option<u32>,
}

/// Album. Unique per (title, album_artist).
#[derive(Debug, Clone, PartialEq, Eq)]
#[derive(Serialize, Deserialize)]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub album_artist_id: Option<i64>,
    pub album_artist_name: Option<String>,
    pub year: Option<i32>,
    pub cover_path: Option<PathBuf>,
    pub track_count: Option<u32>,
}

/// Open-ended per-track tag.
#[derive(Debug, Clone, PartialEq, Eq)]
#[derive(Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
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

/// Track row enriched with resolved album/artist/genre names for UI.
#[derive(Debug, Clone, PartialEq)]
#[derive(Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub path: PathBuf,
    pub filename: String,

    pub title: String,
    pub track_number: Option<i32>,
    pub disc_number: i32,
    pub duration_ms: i64,

    pub album_id: Option<i64>,
    pub album_title: Option<String>,
    pub album_year: Option<i32>,
    pub album_cover_path: Option<PathBuf>,

    pub artist_id: Option<i64>,
    pub artist_name: Option<String>,

    pub genre_id: Option<i64>,
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

    /// Path to a sidecar `.lrc` lyrics file, if one exists.
    pub lrc_path: Option<PathBuf>,
}

/// Filter applied to list_tracks queries.
#[derive(Debug, Clone, Default)]
pub struct TrackFilter {
    pub genre_id: Option<i64>,
    pub artist_id: Option<i64>,
    pub album_id: Option<i64>,
    pub tag_ids: Vec<i64>,
    pub limit: Option<usize>,
    pub order: TrackOrder,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TrackOrder {
    /// Canonical listen order: album, disc, track number.
    #[default]
    AlbumDiscTrack,
    TitleAsc,
    RecentlyAdded,
    LastPlayed,
    Random,
}

#[derive(Debug, Clone, Default)]
pub struct AlbumFilter {
    pub genre_id: Option<i64>,
    pub artist_id: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct ArtistFilter {
    pub genre_id: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
#[derive(Serialize, Deserialize)]
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
    /// Force a full re-walk of the music root, ignoring mtime caches.
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
    TrackRemoved(i64),
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
        track_id: i64,
    },
    Error(String),
}

/// Cheap status snapshot for the UI status bar.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
pub struct IndexerSnapshot {
    pub tracks_total: u64,
    pub embeddings_done: u64,
    pub embeddings_pending: u64,
    pub embeddings_failed: u64,
    pub scan_in_progress: bool,
}
