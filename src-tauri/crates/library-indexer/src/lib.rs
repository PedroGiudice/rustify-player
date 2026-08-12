//! Library indexer for rustify-player.
//!
//! Walks a music root directory, parses FLAC metadata, and stores everything
//! in Qdrant (metadata as payloads, MERT embeddings as named vectors).
//!
//! The crate has no dependency on Tauri. Consumers (CLI, Tauri app, tests)
//! drive it via [`IndexerCommand`] messages and observe state via
//! [`IndexerEvent`] events, plus synchronous read queries via
//! [`IndexerHandle`].

#![allow(dead_code)]

pub mod error;
pub mod types;

mod scan;
pub mod metadata;
mod cover;
mod watch;
mod retry;
pub mod query;
mod pipeline;
pub mod dedup;

pub mod loudness;
pub mod lyrics;
pub mod lyrics_fetch;
pub mod qdrant_client;
pub mod rerank;

mod embed_client;
pub use embed_client::{EmbedClient, LyricsEmbedClient};
pub use qdrant_client::{MoodFilters, QdrantClient, ACTIVITY_VOCAB, MOOD_VOCAB};
pub use cover::{CoverSource, dominant_color, dominant_palette};
pub use dedup::{OwnedIndex, OwnedVerdict};
pub use error::IndexerError;
pub use lyrics::LyricLine;
pub use metadata::{parse_flac, ParsedFlacMetadata};
pub use query::{FolderPlaylist, PlaylistSearchResult, Recommendations};
pub use rerank::{cap_per_artist, hybrid_rerank, vibe_from_enrichment, VibeProfile};
pub use types::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbeddingStatus, Genre, IndexerCommand,
    IndexerEvent, IndexerSnapshot, IngestOutcome, MoodPlaylist, SearchResults, Track,
    TrackFilter, TrackOrder,
};

use crossbeam_channel::{Receiver, Sender};
use std::path::PathBuf;
use std::sync::Arc;

/// Configuration passed to [`Indexer::open`].
#[derive(Debug, Clone)]
pub struct IndexerConfig {
    /// Qdrant HTTP base URL (e.g. `"http://localhost:6333"`).
    pub qdrant_url: String,
    /// Root folder containing FLAC files (recursive).
    pub music_root: PathBuf,
    /// Cache directory for cover thumbnails.
    pub cache_dir: PathBuf,
    /// Optional embedding client for MERT vectors.
    pub embed_client: Option<EmbedClient>,
    /// Optional text-embedding client (cogmem BGE-M3) for `lyrics` vectors.
    /// When present, the indexer runs the lyrics backfill on startup.
    pub lyrics_client: Option<LyricsEmbedClient>,
}

/// Entry point. Stateless; calling [`Indexer::open`] spawns threads.
pub struct Indexer;

impl Indexer {
    /// Opens (or initializes) the library, ensures Qdrant collections exist,
    /// and spawns the coordinator + embedding worker threads.
    pub fn open(config: IndexerConfig) -> Result<IndexerHandle, IndexerError> {
        let client = QdrantClient::new(&config.qdrant_url);
        client.ensure_collection()?;
        client.ensure_play_events_collection()?;
        client.ensure_enrichments_collection()?;

        let pipeline_cfg = pipeline::PipelineConfig {
            music_root: config.music_root.clone(),
            cache_dir: config.cache_dir.clone(),
            embed_client: config.embed_client.clone(),
            lyrics_client: config.lyrics_client.clone(),
        };
        let (cmd_tx, evt_rx, state, client, _handles) = pipeline::start(client, pipeline_cfg);
        Ok(IndexerHandle {
            inner: Arc::new(HandleInner {
                cmd_tx,
                evt_rx,
                state,
                client,
                lyrics_client: config.lyrics_client,
            }),
        })
    }
}

struct HandleInner {
    cmd_tx: Sender<IndexerCommand>,
    evt_rx: Receiver<IndexerEvent>,
    state: Arc<pipeline::SharedState>,
    client: QdrantClient,
    lyrics_client: Option<LyricsEmbedClient>,
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

    /// Access the underlying QdrantClient for direct operations.
    pub fn client(&self) -> &QdrantClient {
        &self.inner.client
    }

    /// Sink de letras para o worker do Crate (`slsk-lyrics`): grava payload +
    /// vetor `lyrics` assim que a letra chega, sem esperar o backfill do
    /// próximo boot. `None` quando não há cliente de embedding de texto
    /// configurado — nesse caso o worker segue só gravando o sidecar.
    pub fn lyrics_sink(&self) -> Option<Arc<dyn lyrics_fetch::LyricsSink>> {
        let embedder = self.inner.lyrics_client.clone()?;
        Some(Arc::new(pipeline::QdrantLyricsSink::new(
            self.inner.client.clone(),
            embedder,
        )))
    }

    // --- Read queries ---------------------------------------------------------

    pub fn track(&self, id: u64) -> Result<Option<Track>, IndexerError> {
        query::get_track(&self.inner.client, id)
    }

    pub fn get_track_by_path(
        &self,
        path: &std::path::Path,
    ) -> Result<Option<Track>, IndexerError> {
        query::get_track_by_path(&self.inner.client, path)
    }

    pub fn list_genres(&self) -> Result<Vec<Genre>, IndexerError> {
        query::list_genres(&self.inner.client)
    }

    pub fn list_tracks(&self, filter: TrackFilter) -> Result<Vec<Track>, IndexerError> {
        query::list_tracks(&self.inner.client, &filter)
    }

    pub fn list_albums(&self, filter: AlbumFilter) -> Result<Vec<Album>, IndexerError> {
        query::list_albums(&self.inner.client, &filter)
    }

    pub fn list_artists(&self, filter: ArtistFilter) -> Result<Vec<Artist>, IndexerError> {
        query::list_artists(&self.inner.client, &filter)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<SearchResults, IndexerError> {
        query::search(&self.inner.client, query, limit)
    }

    pub fn similar(
        &self,
        track_id: u64,
        limit: usize,
    ) -> Result<Vec<(Track, f32)>, IndexerError> {
        query::similar(&self.inner.client, track_id, limit)
    }

    pub fn shuffle(
        &self,
        filter: TrackFilter,
        seed: u64,
        limit: usize,
    ) -> Result<Vec<Track>, IndexerError> {
        query::shuffle(&self.inner.client, &filter, seed, limit)
    }

    pub fn list_folders(
        &self,
        music_root: &str,
    ) -> Result<Vec<query::FolderPlaylist>, IndexerError> {
        query::list_folders(&self.inner.client, music_root)
    }

    pub fn list_folder_tracks(
        &self,
        music_root: &str,
        folder: &str,
    ) -> Result<Vec<Track>, IndexerError> {
        query::list_folder_tracks(&self.inner.client, music_root, folder)
    }

    pub fn search_playlists(
        &self,
        music_root: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<query::PlaylistSearchResult>, IndexerError> {
        query::search_playlists(&self.inner.client, music_root, query, limit)
    }

    pub fn get_lyrics(&self, track_id: u64) -> Result<Vec<LyricLine>, IndexerError> {
        query::get_lyrics(&self.inner.client, track_id)
    }

    /// Indexação determinística de paths específicos, bloqueante até o
    /// coordinator responder (ou timeout de 30s). Usado pelo Crate depois
    /// de mover uma faixa (ou álbum) baixada pra dentro de `music_root` —
    /// diferente de `send(IndexerCommand::Rescan)`, devolve `track_id` por
    /// path em vez de só disparar um scan (spec §5.5).
    pub fn ingest_paths(&self, paths: Vec<PathBuf>) -> Vec<IngestOutcome> {
        let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
        if self
            .inner
            .cmd_tx
            .send(IndexerCommand::IngestPaths {
                paths: paths.clone(),
                reply: reply_tx,
            })
            .is_err()
        {
            return paths
                .into_iter()
                .map(|path| IngestOutcome {
                    path,
                    result: Err("indexer shutdown".to_string()),
                })
                .collect();
        }

        match reply_rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(outcomes) => outcomes,
            Err(_) => paths
                .into_iter()
                .map(|path| IngestOutcome {
                    path,
                    result: Err("timeout aguardando IngestPaths".to_string()),
                })
                .collect(),
        }
    }

    // --- Write operations -----------------------------------------------------

    pub fn record_play(&self, track_id: u64) -> Result<(), IndexerError> {
        query::record_play(&self.inner.client, track_id)
    }

    /// Persist the EBU R128 Integrated loudness for a track. Used by the
    /// lazy backfill worker after analyzing tracks indexed before the
    /// normalization feature landed.
    pub fn set_track_lufs(&self, track_id: u64, lufs: f32) -> Result<(), IndexerError> {
        self.inner.client.set_payload(
            &[track_id],
            serde_json::json!({ "lufs_integrated": lufs }),
        )
    }

    pub fn toggle_like(&self, track_id: u64) -> Result<bool, IndexerError> {
        query::toggle_like(&self.inner.client, track_id)
    }

    pub fn list_liked(&self, limit: usize) -> Result<Vec<Track>, IndexerError> {
        query::list_liked(&self.inner.client, limit)
    }

    pub fn is_liked(&self, track_id: u64) -> Result<bool, IndexerError> {
        query::is_liked(&self.inner.client, track_id)
    }

    pub fn list_history(&self, limit: usize) -> Result<Vec<Track>, IndexerError> {
        query::list_history(&self.inner.client, limit)
    }

    pub fn recommendations(&self) -> Result<query::Recommendations, IndexerError> {
        query::recommendations(&self.inner.client)
    }

    pub fn autoplay_next(
        &self,
        seed: u64,
        exclude: &[u64],
        limit: usize,
    ) -> Result<Vec<(u64, f64)>, IndexerError> {
        query::autoplay_next(&self.inner.client, seed, exclude, limit)
    }

    pub fn behavioral_signals(&self) -> Result<(Vec<u64>, Vec<u64>), IndexerError> {
        self.inner.client.behavioral_signals()
    }

    /// Sincroniza letras com o Qdrant: popula `lrc_path` no payload de tracks
    /// cujo `.lrc` sidecar chegou após a indexação do FLAC e gera o vetor
    /// `lyrics` (BGE-M3, 1024d) para quem tem texto mas ainda não tem vetor.
    /// Não re-embeda o vetor `mert`. Idempotente. Retorna o número de vetores
    /// `lyrics` escritos. O backfill já roda no startup; este método é o
    /// gatilho manual (ex.: após depositar um lote de `.lrc`).
    pub fn sync_lyrics_to_qdrant(
        &self,
        lyrics_client: &LyricsEmbedClient,
    ) -> Result<usize, IndexerError> {
        pipeline::run_lyrics_backfill(&self.inner.client, lyrics_client)
    }
}
