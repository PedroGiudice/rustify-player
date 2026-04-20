//! Library indexer for rustify-player.
//!
//! Walks a music root directory, parses FLAC metadata, extracts cover art,
//! and requests MERT audio embeddings (from the Tailnet `rustify-embed`
//! service) for similarity-based continuity. Persists everything in a
//! single SQLite file with FTS5 indexes.
//!
//! The crate has no dependency on Tauri. Consumers (CLI, Tauri app, tests)
//! drive it via [`IndexerCommand`] messages and observe state via
//! [`IndexerEvent`] events, plus synchronous read queries via
//! [`IndexerHandle`].

#![allow(dead_code)]

pub mod error;
pub mod types;

mod db;
mod scan;
mod metadata;
mod cover;
mod watch;
mod search;
mod embed_client;
mod pipeline;

pub mod lyrics;

pub use embed_client::EmbedClient;
pub use error::IndexerError;
pub use lyrics::LyricLine;
pub use search::FolderPlaylist;
pub use types::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbeddingStatus, Genre, IndexerCommand,
    IndexerEvent, IndexerSnapshot, SearchResults, Tag, Track, TrackFilter, TrackOrder,
};

use crossbeam_channel::{Receiver, Sender};
use std::path::PathBuf;
use std::sync::Arc;

/// Configuration passed to [`Indexer::open`].
#[derive(Debug, Clone)]
pub struct IndexerConfig {
    /// Path to the SQLite database file. Will be created if absent.
    /// Recommended: `~/.local/share/rustify-player/library.db`.
    pub db_path: PathBuf,
    /// Root folder containing FLAC files (recursive).
    /// Recommended: `~/Music`.
    pub music_root: PathBuf,
    /// Cache directory for cover thumbnails.
    /// Recommended: `~/.cache/rustify-player`.
    pub cache_dir: PathBuf,
    /// Optional embedding client. When `None`, tracks land with
    /// `embedding_status = 'pending'` and similarity queries degrade
    /// gracefully (similar() returns an empty vec for anchors with no
    /// embedding). Pass `Some(EmbedClient::new(url))` to enable.
    pub embed_client: Option<EmbedClient>,
}

/// Entry point. Stateless; calling [`Indexer::open`] spawns threads.
pub struct Indexer;

impl Indexer {
    /// Opens (or initializes) the library at `config.db_path`, applies
    /// migrations, and spawns the coordinator + embedding worker threads.
    pub fn open(config: IndexerConfig) -> Result<IndexerHandle, IndexerError> {
        let db = db::open_and_migrate(&config.db_path)?;
        let pipeline_cfg = pipeline::PipelineConfig {
            music_root: config.music_root.clone(),
            cache_dir: config.cache_dir.clone(),
            embed_client: config.embed_client.clone(),
        };
        let (cmd_tx, evt_rx, state, pool, _handles) = pipeline::start(db, pipeline_cfg);
        Ok(IndexerHandle {
            inner: Arc::new(HandleInner {
                cmd_tx,
                evt_rx,
                state,
                pool,
            }),
        })
    }
}

struct HandleInner {
    cmd_tx: Sender<IndexerCommand>,
    evt_rx: Receiver<IndexerEvent>,
    state: Arc<pipeline::SharedState>,
    pool: db::ReadPool,
}

/// Handle to a running indexer. Clone-able, Send-safe.
#[derive(Clone)]
pub struct IndexerHandle {
    inner: Arc<HandleInner>,
}

impl IndexerHandle {
    pub fn send(&self, cmd: IndexerCommand) -> Result<(), IndexerError> {
        self.inner
            .cmd_tx
            .send(cmd)
            .map_err(|_| IndexerError::Shutdown)
    }

    pub fn subscribe(&self) -> Receiver<IndexerEvent> {
        self.inner.evt_rx.clone()
    }

    pub fn snapshot(&self) -> IndexerSnapshot {
        self.inner.state.snapshot()
    }

    // --- Read queries -----------------------------------------------------

    pub fn track(&self, id: i64) -> Result<Option<Track>, IndexerError> {
        self.inner.pool.with(|conn| search::get_track(conn, id))
    }

    pub fn album(&self, id: i64) -> Result<Option<Album>, IndexerError> {
        self.inner.pool.with(|conn| search::get_album(conn, id))
    }

    pub fn artist(&self, id: i64) -> Result<Option<Artist>, IndexerError> {
        self.inner.pool.with(|conn| search::get_artist(conn, id))
    }

    pub fn list_genres(&self) -> Result<Vec<Genre>, IndexerError> {
        self.inner.pool.with(search::list_genres)
    }

    pub fn list_tracks(&self, filter: TrackFilter) -> Result<Vec<Track>, IndexerError> {
        self.inner
            .pool
            .with(|conn| search::list_tracks(conn, &filter))
    }

    pub fn list_albums(&self, filter: AlbumFilter) -> Result<Vec<Album>, IndexerError> {
        self.inner
            .pool
            .with(|conn| search::list_albums(conn, &filter))
    }

    pub fn list_artists(&self, filter: ArtistFilter) -> Result<Vec<Artist>, IndexerError> {
        self.inner
            .pool
            .with(|conn| search::list_artists(conn, &filter))
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<SearchResults, IndexerError> {
        self.inner
            .pool
            .with(|conn| search::search(conn, query, limit))
    }

    pub fn similar(
        &self,
        track_id: i64,
        limit: usize,
    ) -> Result<Vec<(Track, f32)>, IndexerError> {
        self.inner
            .pool
            .with(|conn| search::similar(conn, track_id, limit))
    }

    pub fn shuffle(
        &self,
        filter: TrackFilter,
        seed: u64,
        limit: usize,
    ) -> Result<Vec<Track>, IndexerError> {
        self.inner
            .pool
            .with(|conn| search::shuffle(conn, &filter, seed, limit))
    }

    pub fn list_folders(&self, music_root: &str) -> Result<Vec<search::FolderPlaylist>, IndexerError> {
        self.inner.pool.with(|conn| search::list_folders(conn, music_root))
    }

    pub fn list_folder_tracks(&self, music_root: &str, folder: &str) -> Result<Vec<Track>, IndexerError> {
        self.inner.pool.with(|conn| search::list_folder_tracks(conn, music_root, folder))
    }

    pub fn get_lyrics(&self, track_id: i64) -> Result<Vec<LyricLine>, IndexerError> {
        self.inner.pool.with(|conn| search::get_lyrics(conn, track_id))
    }

    pub fn record_play(&self, track_id: i64) -> Result<(), IndexerError> {
        self.inner.pool.with(|conn| search::record_play(conn, track_id))
    }

    pub fn list_history(&self, limit: usize) -> Result<Vec<Track>, IndexerError> {
        self.inner.pool.with(|conn| search::list_history(conn, limit))
    }

    /// True when migration 003 has been applied during a previous or the
    /// current open and tracks indexed before it need backfilling of the
    /// new `embedded_lyrics` column. The coordinator clears the flag on
    /// the next successful scan.
    pub fn needs_embedded_lyrics_scan(&self) -> bool {
        self.inner
            .pool
            .with(|conn| {
                Ok(db::meta_get(conn, db::META_NEEDS_EMBEDDED_LYRICS_SCAN)?
                    .as_deref()
                    == Some("1"))
            })
            .unwrap_or(false)
    }
}
