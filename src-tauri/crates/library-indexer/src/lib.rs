//! Library indexer for rustify-player.
//!
//! Walks a music root directory, parses FLAC metadata, extracts cover art,
//! and produces MERT audio embeddings for similarity-based continuity.
//! Persists everything in a single SQLite file with FTS5 indexes.
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
// Future modules (stubs added in subsequent tasks):
// mod cover;
// mod embedding;
// mod watch;
// mod pipeline;
// mod search;
// mod model_download;

pub use error::IndexerError;
pub use types::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbeddingStatus, Genre, IndexerCommand,
    IndexerEvent, IndexerSnapshot, SearchResults, Tag, Track, TrackFilter, TrackOrder,
};

use std::path::PathBuf;

/// Configuration passed to [`Indexer::open`].
#[derive(Debug, Clone)]
pub struct IndexerConfig {
    /// Path to the SQLite database file. Will be created if absent.
    /// Recommended: `~/.local/share/rustify-player/library.db`.
    pub db_path: PathBuf,
    /// Root folder containing FLAC files (recursive).
    /// Recommended: `~/Music`.
    pub music_root: PathBuf,
    /// Cache directory for cover thumbnails and downloaded models.
    /// Recommended: `~/.cache/rustify-player`.
    pub cache_dir: PathBuf,
    /// Skip embedding extraction. Useful for fast scan-only smoke tests.
    pub enable_embedding: bool,
}

/// Entry point. Stateless; calling [`Indexer::open`] spawns threads.
pub struct Indexer;

impl Indexer {
    /// Opens (or initializes) the library at `config.db_path` and spawns the
    /// coordinator thread. Returns an [`IndexerHandle`] for further control.
    pub fn open(_config: IndexerConfig) -> Result<IndexerHandle, IndexerError> {
        // Stub — wired up in pipeline.rs task.
        Err(IndexerError::ModelUnavailable(
            "Indexer::open not yet implemented".into(),
        ))
    }
}

/// Handle to a running indexer. Clone-able, Send-safe.
#[derive(Clone)]
pub struct IndexerHandle {
    // Fields will be populated in pipeline.rs task.
    _placeholder: (),
}

impl IndexerHandle {
    // Stubs to pin the API surface. Real impls land with their respective
    // modules (pipeline, search).
}
