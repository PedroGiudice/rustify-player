//! Indexer coordinator thread + embedding worker.
//!
//! The coordinator drives the scan → parse → upsert flow against Qdrant,
//! and feeds a single embedding worker thread. Events are broadcast to UI
//! subscribers via `crossbeam_channel`.

#![allow(dead_code)]

use crate::cover::{self, CoverSource};
use crate::embed_client::EmbedClient;
use crate::error::IndexerError;
use crate::loudness;
use crate::lyrics;
use crate::metadata::{self, ParsedFlacMetadata, PictureUsage};
use crate::qdrant_client::QdrantClient;
use crate::scan::{self, FileEntry};
use crate::types::{IndexerCommand, IndexerEvent, IndexerSnapshot, path_to_id};
use crossbeam_channel::{select, unbounded, Receiver, Sender};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

/// Shared counters readable by the UI between events.
#[derive(Default)]
pub(crate) struct SharedState {
    pub tracks_total: AtomicU64,
    pub embeddings_done: AtomicU64,
    pub embeddings_pending: AtomicU64,
    pub embeddings_failed: AtomicU64,
    pub scan_in_progress: AtomicBool,
}

impl SharedState {
    pub fn snapshot(&self) -> IndexerSnapshot {
        IndexerSnapshot {
            tracks_total: self.tracks_total.load(Ordering::Relaxed),
            embeddings_done: self.embeddings_done.load(Ordering::Relaxed),
            embeddings_pending: self.embeddings_pending.load(Ordering::Relaxed),
            embeddings_failed: self.embeddings_failed.load(Ordering::Relaxed),
            scan_in_progress: self.scan_in_progress.load(Ordering::Relaxed),
        }
    }

    pub fn refresh(&self, client: &QdrantClient) {
        let total = client.collection_point_count().unwrap_or(0);
        self.tracks_total.store(total, Ordering::Relaxed);

        let done = client
            .count_with_filter(json!({"must": [{"key": "embedding_status", "match": {"value": "done"}}]}))
            .unwrap_or(0);
        let failed = client
            .count_with_filter(json!({"must": [{"key": "embedding_status", "match": {"value": "failed"}}]}))
            .unwrap_or(0);
        self.embeddings_done.store(done, Ordering::Relaxed);
        self.embeddings_failed.store(failed, Ordering::Relaxed);
        self.embeddings_pending.store(total.saturating_sub(done + failed), Ordering::Relaxed);
    }
}

pub(crate) struct Handles {
    pub coordinator: JoinHandle<()>,
    pub embed_worker: Option<JoinHandle<()>>,
}

pub(crate) struct PipelineConfig {
    pub music_root: PathBuf,
    pub cache_dir: PathBuf,
    pub embed_client: Option<EmbedClient>,
}

/// Start the coordinator + embed worker. Returns channels, shared state, and the client.
pub(crate) fn start(
    client: QdrantClient,
    config: PipelineConfig,
) -> (
    Sender<IndexerCommand>,
    Receiver<IndexerEvent>,
    Arc<SharedState>,
    QdrantClient,
    Handles,
) {
    let (cmd_tx, cmd_rx) = unbounded::<IndexerCommand>();
    let (evt_tx, evt_rx) = unbounded::<IndexerEvent>();
    let state = Arc::new(SharedState::default());

    let (embed_job_tx, embed_job_rx) = unbounded::<EmbedJob>();
    let (embed_result_tx, embed_result_rx) = unbounded::<EmbedResult>();

    let embed_worker = config.embed_client.as_ref().map(|ec| {
        let ec = ec.clone();
        let result_tx = embed_result_tx.clone();
        thread::Builder::new()
            .name("library-indexer-embed".into())
            .spawn(move || embed_worker_loop(ec, embed_job_rx, result_tx))
            .expect("spawn embed worker")
    });

    let coord_state = Arc::clone(&state);
    let coord_evt_tx = evt_tx.clone();
    let coord_client = client.clone();
    let coordinator = thread::Builder::new()
        .name("library-indexer-coord".into())
        .spawn(move || {
            coordinator_loop(
                coord_client,
                config,
                cmd_rx,
                coord_evt_tx,
                coord_state,
                embed_job_tx,
                embed_result_rx,
            );
        })
        .expect("spawn coordinator");

    (
        cmd_tx,
        evt_rx,
        state,
        client,
        Handles {
            coordinator,
            embed_worker,
        },
    )
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

fn coordinator_loop(
    client: QdrantClient,
    config: PipelineConfig,
    cmd_rx: Receiver<IndexerCommand>,
    evt_tx: Sender<IndexerEvent>,
    state: Arc<SharedState>,
    embed_job_tx: Sender<EmbedJob>,
    embed_result_rx: Receiver<EmbedResult>,
) {
    info!(target: "library_indexer::pipeline", "coordinator starting");
    state.refresh(&client);

    if let Err(e) = run_scan(&client, &config, &evt_tx, &state, &embed_job_tx) {
        error!(target: "library_indexer::pipeline", error = %e, "initial scan failed");
        let _ = evt_tx.send(IndexerEvent::Error(e.to_string()));
    }

    loop {
        select! {
            recv(cmd_rx) -> msg => match msg {
                Ok(IndexerCommand::Rescan) => {
                    if let Err(e) = run_scan(&client, &config, &evt_tx, &state, &embed_job_tx) {
                        error!(target: "library_indexer::pipeline", error = %e, "rescan failed");
                        let _ = evt_tx.send(IndexerEvent::Error(e.to_string()));
                    }
                }
                Ok(IndexerCommand::Shutdown) | Err(_) => break,
            },
            recv(embed_result_rx) -> msg => match msg {
                Ok(result) => {
                    apply_embed_result(&client, &result, &state, &evt_tx);
                }
                Err(_) => {}
            },
        }
    }

    info!(target: "library_indexer::pipeline", "coordinator exiting");
}

/// RAII guard: clears `scan_in_progress` on drop (even on panic).
struct ScanGuard(Arc<SharedState>);
impl Drop for ScanGuard {
    fn drop(&mut self) {
        self.0.scan_in_progress.store(false, Ordering::Relaxed);
    }
}

fn run_scan(
    client: &QdrantClient,
    config: &PipelineConfig,
    evt_tx: &Sender<IndexerEvent>,
    state: &Arc<SharedState>,
    embed_job_tx: &Sender<EmbedJob>,
) -> Result<(), IndexerError> {
    state.scan_in_progress.store(true, Ordering::Relaxed);
    let _guard = ScanGuard(Arc::clone(state));
    let _ = evt_tx.send(IndexerEvent::ScanStarted);

    let entries: Vec<FileEntry> = scan::walk_music_root(&config.music_root)?.collect();
    let total = entries.len() as u64;

    let existing = load_existing_from_qdrant(client)?;
    info!(
        target: "library_indexer::pipeline",
        files_on_disk = total,
        tracks_in_qdrant = existing.len(),
        "scan diff starting"
    );

    let mut added = 0u64;
    let mut updated = 0u64;
    let mut removed = 0u64;

    let seen_paths: std::collections::HashSet<PathBuf> =
        entries.iter().map(|e| e.path.clone()).collect();

    // Deletions: in Qdrant but not on disk.
    let to_delete: Vec<u64> = existing
        .iter()
        .filter(|(_, path, _, _, _)| !seen_paths.contains(path))
        .map(|(id, _, _, _, _)| *id)
        .collect();
    if !to_delete.is_empty() {
        client.delete_points(&to_delete)?;
        removed = to_delete.len() as u64;
        for id in &to_delete {
            let _ = evt_tx.send(IndexerEvent::TrackRemoved(*id));
        }
    }

    let by_path: std::collections::HashMap<PathBuf, (u64, u64, u64, bool)> = existing
        .into_iter()
        .map(|(id, p, mt, sz, emb)| (p, (id, mt, sz, emb)))
        .collect();

    let mut batch: Vec<(u64, serde_json::Value, Option<Vec<f32>>)> = Vec::new();
    let mut processed = 0u64;

    for entry in entries {
        processed += 1;
        let prior = by_path.get(&entry.path);
        let needs_ingest = match prior {
            None => true,
            Some((_, mt, sz, _)) => *mt != entry.mtime || *sz != entry.size,
        };

        if needs_ingest {
            match build_track_payload(config, &entry) {
                Ok(payload) => {
                    let id = path_to_id(&entry.path);
                    batch.push((id, payload, None));
                    if prior.is_none() {
                        added += 1;
                    } else {
                        updated += 1;
                    }
                    let _ = embed_job_tx.send(EmbedJob {
                        track_id: id,
                        path: entry.path.clone(),
                    });
                }
                Err(e) => {
                    warn!(target: "library_indexer::pipeline", path = ?entry.path, error = %e, "ingest failed");
                }
            }
        } else if let Some((id, _, _, embedded)) = prior {
            if !embedded {
                let _ = embed_job_tx.send(EmbedJob {
                    track_id: *id,
                    path: entry.path.clone(),
                });
            }
        }

        if batch.len() >= 100 {
            client.upsert_tracks(&batch)?;
            batch.clear();
        }

        if processed % 25 == 0 {
            let _ = evt_tx.send(IndexerEvent::ScanProgress { processed, total });
        }
    }

    if !batch.is_empty() {
        client.upsert_tracks(&batch)?;
    }

    let _ = evt_tx.send(IndexerEvent::ScanProgress { processed, total });
    state.refresh(client);
    let _ = evt_tx.send(IndexerEvent::ScanDone {
        added,
        updated,
        removed,
    });
    Ok(())
}

fn load_existing_from_qdrant(
    client: &QdrantClient,
) -> Result<Vec<(u64, PathBuf, u64, u64, bool)>, IndexerError> {
    let all = client.scroll_all_payloads(&["path", "mtime", "size_bytes", "embedding_status"])?;
    Ok(all
        .into_iter()
        .map(|(id, payload)| {
            let path = PathBuf::from(payload["path"].as_str().unwrap_or(""));
            let mtime = payload["mtime"].as_u64().unwrap_or(0);
            let size = payload["size_bytes"].as_u64().unwrap_or(0);
            let embedded = payload["embedding_status"].as_str() == Some("done");
            (id, path, mtime, size, embedded)
        })
        .collect())
}

fn build_track_payload(
    config: &PipelineConfig,
    entry: &FileEntry,
) -> Result<serde_json::Value, IndexerError> {
    let md = metadata::parse_flac(&entry.path)?;

    let artist_name = md
        .album_artist
        .clone()
        .or_else(|| md.artist.clone())
        .or_else(|| entry.album_artist_from_path.clone())
        .unwrap_or_default();
    let album_title = md
        .album
        .clone()
        .or_else(|| entry.album_from_path.clone())
        .unwrap_or_default();
    let genre = entry.genre_from_path.clone().unwrap_or_default();
    let filename = entry
        .path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let title = md
        .title
        .clone()
        .unwrap_or_else(|| filename_stem(&filename));
    let lrc_path = lyrics::find_lrc_sidecar(&entry.path).map(|p| path_str(&p));
    let embedded_lyrics = md
        .embedded_lyrics
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Cover art + dominant color
    let cover_source = pick_cover_source(entry, &md);
    // dominant_color now lives in track_enrichments — computed on-demand by get_track_color
    let cover_path = if let Some(src) = cover_source {
        let album_key = format!(
            "{}|{}",
            album_title.to_lowercase(),
            artist_name.to_lowercase()
        );
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&album_key, &mut hasher);
        let album_hash = std::hash::Hasher::finish(&hasher);
        match cover::process_album_cover(album_hash as i64, src, &config.cache_dir) {
            Ok(path) => {
                let rel = path
                    .strip_prefix(&config.cache_dir)
                    .map(|p| p.to_path_buf())
                    .unwrap_or(path);
                Some(rel.to_string_lossy().to_string())
            }
            Err(e) => {
                warn!(target: "library_indexer::pipeline", error = %e, "cover processing failed");
                None
            }
        }
    } else {
        None
    };

    let now = unix_now();

    // EBU R128 Integrated loudness — best-effort. A failure here must NOT
    // abort the indexing of the track; we just skip the field and let the
    // lazy backfill worker retry on first playback.
    let lufs_integrated = match loudness::analyze_file(&entry.path) {
        Ok(a) => Some(a.integrated_lufs),
        Err(e) => {
            warn!(
                target: "library_indexer::pipeline",
                path = ?entry.path, error = %e,
                "loudness analysis failed; will backfill on first play"
            );
            None
        }
    };

    Ok(json!({
        "path": path_str(&entry.path),
        "filename": filename,
        "title": title,
        "track_number": md.track_number,
        "disc_number": md.disc_number.unwrap_or(1),
        "duration_ms": md.duration_ms,
        "album_title": album_title,
        "album_title_exact": album_title,
        "album_year": md.year.or(entry.year_from_path),
        "artist": artist_name,
        "artist_exact": artist_name,
        "genre": genre,
        "tags": md.tags,
        "cover_path": cover_path,
        "sample_rate": md.sample_rate,
        "bit_depth": md.bit_depth,
        "channels": md.channels,
        "rg_track_gain": md.rg_track_gain,
        "rg_album_gain": md.rg_album_gain,
        "rg_track_peak": md.rg_track_peak,
        "rg_album_peak": md.rg_album_peak,
        "lufs_integrated": lufs_integrated,
        "embedding_status": "pending",
        "lrc_path": lrc_path,
        "embedded_lyrics": embedded_lyrics,
        "mtime": entry.mtime,
        "size_bytes": entry.size,
        "indexed_at": now
    }))
}

fn pick_cover_source(entry: &FileEntry, md: &ParsedFlacMetadata) -> Option<CoverSource> {
    if let Some(pic) = md
        .pictures
        .iter()
        .find(|p| p.usage == PictureUsage::FrontCover)
        .or_else(|| md.pictures.first())
    {
        return Some(CoverSource::EmbeddedBytes {
            data: pic.data.clone(),
            mime_hint: pic.mime.clone(),
        });
    }
    if let Some(parent) = entry.path.parent() {
        if let Some(p) = metadata::find_folder_cover(parent) {
            return Some(CoverSource::FolderFile(p));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Embedding worker
// ---------------------------------------------------------------------------

struct EmbedJob {
    track_id: u64,
    path: PathBuf,
}

struct EmbedResult {
    track_id: u64,
    outcome: Result<Vec<f32>, String>,
}

fn embed_worker_loop(
    client: EmbedClient,
    jobs_rx: Receiver<EmbedJob>,
    results_tx: Sender<EmbedResult>,
) {
    info!(target: "library_indexer::pipeline", "embed worker starting");
    while let Ok(job) = jobs_rx.recv() {
        let outcome = match client.embed_file(&job.path) {
            Ok(v) => Ok(v),
            Err(e) => Err(e.to_string()),
        };
        if results_tx
            .send(EmbedResult {
                track_id: job.track_id,
                outcome,
            })
            .is_err()
        {
            break;
        }
    }
    info!(target: "library_indexer::pipeline", "embed worker exiting");
}

fn apply_embed_result(
    client: &QdrantClient,
    result: &EmbedResult,
    state: &Arc<SharedState>,
    evt_tx: &Sender<IndexerEvent>,
) {
    match &result.outcome {
        Ok(vector) => {
            let body = json!({
                "points": [{
                    "id": result.track_id,
                    "vector": { "mert": vector }
                }]
            });
            let url = format!("{}/collections/rustify_tracks/points/vectors", client.base_url());
            match client.raw_put(&url, &body) {
                Ok(_) => {
                    client
                        .set_payload(&[result.track_id], json!({"embedding_status": "done"}))
                        .ok();
                    state.embeddings_done.fetch_add(1, Ordering::Relaxed);
                    let _ = evt_tx.send(IndexerEvent::EmbeddingDone {
                        track_id: result.track_id,
                    });
                }
                Err(e) => {
                    warn!(target: "library_indexer::pipeline", track_id = result.track_id, error = %e, "write embedding failed");
                }
            }
        }
        Err(_msg) => {
            client
                .set_payload(&[result.track_id], json!({"embedding_status": "failed"}))
                .ok();
            state.embeddings_failed.fetch_add(1, Ordering::Relaxed);
        }
    }
    state.refresh(client);
    let snap = state.snapshot();
    let _ = evt_tx.send(IndexerEvent::EmbeddingProgress {
        done: snap.embeddings_done,
        pending: snap.embeddings_pending,
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn filename_stem(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(s, _)| s.to_string())
        .unwrap_or_else(|| name.to_string())
}
