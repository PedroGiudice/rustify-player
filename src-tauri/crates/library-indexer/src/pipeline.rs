//! Indexer coordinator thread + embedding worker.
//!
//! The coordinator drives the scan → parse → upsert flow against Qdrant,
//! and feeds a single embedding worker thread. Events are broadcast to UI
//! subscribers via `crossbeam_channel`.

#![allow(dead_code)]

use crate::cover::{self, CoverSource};
use crate::embed_client::{EmbedClient, LyricsEmbedClient};
use crate::error::IndexerError;
use crate::loudness;
use crate::lyrics;
use crate::metadata::{self, ParsedFlacMetadata, PictureUsage};
use crate::qdrant_client::QdrantClient;
use crate::scan::{self, FileEntry};
use crate::types::{IndexerCommand, IndexerEvent, IndexerSnapshot, path_to_id};
use crate::watch::{FsWatcher, WatchEvent};
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
    /// Cliente de embedding de texto (cogmem BGE-M3) para os vetores `lyrics`.
    /// Quando presente, o coordinator roda o backfill de lyrics no startup.
    pub lyrics_client: Option<LyricsEmbedClient>,
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

    // Live filesystem watcher: any FLAC create/modify/remove inside the
    // music root triggers an incremental rescan. Debounce is handled inside
    // the watcher (2s window); the scanner itself is idempotent so re-running
    // on top of an unchanged tree is cheap.
    //
    // Held in scope for the lifetime of the coordinator — dropping it stops
    // the underlying notify thread.
    let (watch_tx, watch_rx) = unbounded::<WatchEvent>();
    let _fs_watcher = match FsWatcher::start(&config.music_root, watch_tx) {
        Ok(w) => {
            info!(
                target: "library_indexer::pipeline",
                root = %config.music_root.display(),
                "fs watcher armed"
            );
            Some(w)
        }
        Err(e) => {
            warn!(target: "library_indexer::pipeline", error = %e, "fs watcher disabled");
            None
        }
    };

    // Bulk LUFS backfill for tracks indexed before normalization landed.
    // Runs on its own thread so the coordinator stays responsive; idempotent
    // (filters on `lufs_integrated IS NULL`), so a no-op once coverage is full.
    {
        let backfill_client = client.clone();
        thread::Builder::new()
            .name("library-indexer-lufs-backfill".into())
            .spawn(move || {
                if let Err(e) = backfill_missing_lufs(&backfill_client) {
                    warn!(
                        target: "library_indexer::pipeline",
                        error = %e,
                        "loudness bulk backfill failed"
                    );
                }
            })
            .ok();
    }

    // Bulk lyrics backfill: popula `lrc_path` no payload de tracks cujo `.lrc`
    // sidecar chegou depois da indexação do FLAC (run_scan não detecta isso,
    // pois o mtime/size do FLAC não muda) e gera o vetor `lyrics` para quem tem
    // texto mas ainda não tem vetor. Thread própria, idempotente, sem re-MERT.
    // Só roda se houver cliente de embedding de texto configurado.
    if let Some(lyrics_client) = config.lyrics_client.clone() {
        let backfill_client = client.clone();
        thread::Builder::new()
            .name("library-indexer-lyrics-backfill".into())
            .spawn(move || {
                if let Err(e) = backfill_lyrics(&backfill_client, &lyrics_client) {
                    warn!(
                        target: "library_indexer::pipeline",
                        error = %e,
                        "lyrics bulk backfill failed"
                    );
                }
            })
            .ok();
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
            recv(watch_rx) -> msg => match msg {
                Ok(first) => {
                    // Drain any other events that piled up during the
                    // debounce window so a bulk move (113 FLACs at once)
                    // collapses into a single rescan instead of one per file.
                    let mut count = 1;
                    while watch_rx.try_recv().is_ok() {
                        count += 1;
                    }
                    if state.scan_in_progress.load(Ordering::Relaxed) {
                        info!(
                            target: "library_indexer::pipeline",
                            events = count,
                            "watch: scan already running, skipping"
                        );
                    } else {
                        info!(
                            target: "library_indexer::pipeline",
                            events = count,
                            first = ?first,
                            "watch: triggering rescan"
                        );
                        if let Err(e) = run_scan(&client, &config, &evt_tx, &state, &embed_job_tx) {
                            error!(target: "library_indexer::pipeline", error = %e, "watch rescan failed");
                            let _ = evt_tx.send(IndexerEvent::Error(e.to_string()));
                        }
                    }
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

/// One-shot bulk pass: find every track in Qdrant whose `lufs_integrated`
/// payload field is missing, decode it with ebur128, and persist the value.
///
/// Tracks indexed before the normalization feature landed have no LUFS, and
/// the lazy on-play backfill only fills one track per playback. This bulk
/// pass closes the gap without user intervention.
///
/// Single-threaded by design — keeps CPU pressure predictable while the
/// app is also handling playback. ~5–10 s per FLAC, so ~80 min for a 1k
/// library on first launch; subsequent launches are no-ops.
fn backfill_missing_lufs(client: &QdrantClient) -> Result<(), IndexerError> {
    let filter = json!({
        "must": [
            { "is_empty": { "key": "lufs_integrated" } }
        ]
    });

    let pending = client.scroll_all_with_filter(filter, &["path"])?;
    if pending.is_empty() {
        info!(target: "library_indexer::pipeline", "loudness backfill: nothing to do");
        return Ok(());
    }

    let total = pending.len();
    info!(
        target: "library_indexer::pipeline",
        total,
        "loudness backfill: starting bulk pass"
    );

    let mut done = 0usize;
    let mut failed = 0usize;
    for (id, payload) in pending {
        let path = match payload["path"].as_str() {
            Some(p) if !p.is_empty() => PathBuf::from(p),
            _ => {
                failed += 1;
                continue;
            }
        };

        match loudness::analyze_file(&path) {
            Ok(a) => {
                if let Err(e) = client.set_payload(
                    &[id],
                    json!({ "lufs_integrated": a.integrated_lufs }),
                ) {
                    warn!(
                        target: "library_indexer::pipeline",
                        track_id = id, error = %e,
                        "loudness backfill: set_payload failed"
                    );
                    failed += 1;
                } else {
                    done += 1;
                }
            }
            Err(e) => {
                warn!(
                    target: "library_indexer::pipeline",
                    track_id = id, path = ?path, error = %e,
                    "loudness backfill: analysis failed"
                );
                failed += 1;
            }
        }

        if (done + failed) % 25 == 0 {
            info!(
                target: "library_indexer::pipeline",
                done, failed, total,
                "loudness backfill: progress"
            );
        }
    }

    info!(
        target: "library_indexer::pipeline",
        done, failed, total,
        "loudness backfill: bulk pass complete"
    );
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

/// Executa uma operação de embed isolando panics. Um panic dentro do
/// decode/preprocess (symphonia/rubato podem entrar em panic com input
/// degenerado) viraria a morte da thread do worker, deixando o `jobs_rx`
/// órfão (sender sem receiver) — o scan seguiria mandando jobs no vazio e
/// nenhum embed mais aconteceria, sem sinal. `catch_unwind` converte o
/// panic num `Err` daquele job; o worker segue para o próximo.
fn embed_one<F>(op: F) -> Result<Vec<f32>, String>
where
    F: FnOnce() -> Result<Vec<f32>, IndexerError>,
{
    // `AssertUnwindSafe`: o EmbedClient (ureq::Agent) não é auto-UnwindSafe
    // por causa do pool interno de conexões com interior mutability. É seguro
    // aqui porque cada job é independente e, em caso de panic, descartamos o
    // resultado daquele job inteiro — não reusamos nenhum estado parcialmente
    // mutado dentro da mesma chamada.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(op)) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e.to_string()),
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic desconhecido no embed".to_string());
            Err(format!("embed panicked: {msg}"))
        }
    }
}

fn embed_worker_loop(
    client: EmbedClient,
    jobs_rx: Receiver<EmbedJob>,
    results_tx: Sender<EmbedResult>,
) {
    info!(target: "library_indexer::pipeline", "embed worker starting");
    while let Ok(job) = jobs_rx.recv() {
        let path = job.path.clone();
        let client = client.clone();
        let outcome = embed_one(move || client.embed_file(&path));
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
// Lyrics backfill (sidecar .lrc → payload + vetor lyrics)
// ---------------------------------------------------------------------------

/// Texto mínimo (em chars, após limpeza) para uma letra valer como input de
/// embedding. Espelha o guard `len > 20` do `scripts/embed_lyrics.py` — textos
/// curtos são ruído (instrumentais marcados, fragmentos).
const MIN_LYRICS_CHARS: usize = 20;

/// Resultado da resolução de letra de uma track a partir do seu payload + disco.
struct LyricsResolution {
    /// Texto limpo (sem timestamps) pronto para embedding, se houver.
    text: Option<String>,
    /// `lrc_path` a gravar no payload quando um `.lrc` sidecar foi encontrado
    /// no disco mas ainda NÃO constava no payload (Gap A). `None` quando o
    /// payload já estava correto ou não há sidecar.
    lrc_path_for_payload: Option<String>,
}

/// Resolve a letra de uma track a partir do seu payload Qdrant, sem tocar no
/// áudio (logo, sem re-embed MERT). Ordem de prioridade — mesma do pipeline
/// Python canônico, estendida para detectar sidecar novo:
///
/// 1. `embedded_lyrics` do payload (limpo), se > [`MIN_LYRICS_CHARS`].
/// 2. `lrc_path` do payload (lido do disco e limpo), se > [`MIN_LYRICS_CHARS`].
/// 3. **Gap A**: `.lrc` sidecar ao lado do `path` do FLAC que ainda não está
///    no payload — lê, limpa e sinaliza o caminho para `set_payload`.
fn resolve_lyrics(payload: &serde_json::Value) -> LyricsResolution {
    let none = LyricsResolution {
        text: None,
        lrc_path_for_payload: None,
    };

    // 1. embedded_lyrics direto do payload.
    if let Some(raw) = payload["embedded_lyrics"].as_str() {
        let cleaned = lyrics::clean_lyrics_text(raw);
        if cleaned.chars().count() > MIN_LYRICS_CHARS {
            return LyricsResolution {
                text: Some(cleaned),
                lrc_path_for_payload: None,
            };
        }
    }

    // 2. lrc_path já registrado no payload.
    if let Some(lrc) = payload["lrc_path"].as_str() {
        if let Some(cleaned) = read_clean_lrc(Path::new(lrc)) {
            return LyricsResolution {
                text: Some(cleaned),
                lrc_path_for_payload: None,
            };
        }
    }

    // 3. Sidecar novo no disco, ainda fora do payload (Gap A).
    if let Some(audio) = payload["path"].as_str() {
        if let Some(sidecar) = lyrics::find_lrc_sidecar(Path::new(audio)) {
            if let Some(cleaned) = read_clean_lrc(&sidecar) {
                return LyricsResolution {
                    text: Some(cleaned),
                    lrc_path_for_payload: Some(path_str(&sidecar)),
                };
            }
        }
    }

    none
}

/// Lê e limpa um `.lrc` do disco; `None` se ilegível ou texto curto demais.
fn read_clean_lrc(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let cleaned = lyrics::clean_lyrics_text(&raw);
    (cleaned.chars().count() > MIN_LYRICS_CHARS).then_some(cleaned)
}

/// Ponto de entrada `pub(crate)` para disparar o backfill de lyrics sob
/// demanda (ex.: `IndexerHandle::sync_lyrics_to_qdrant`). Mesma lógica que roda
/// no startup do coordinator. Retorna o número de vetores `lyrics` escritos.
pub(crate) fn run_lyrics_backfill(
    client: &QdrantClient,
    lyrics_client: &LyricsEmbedClient,
) -> Result<usize, IndexerError> {
    backfill_lyrics(client, lyrics_client)
}

/// One-shot bulk pass: garante que toda track com letra (sidecar `.lrc` ou
/// `embedded_lyrics`) tenha o payload de lyrics populado E o vetor `lyrics`
/// (1024d, BGE-M3 via cogmem) gerado — sem nunca re-embeddar o vetor `mert`.
///
/// Resolve dois gaps de uma vez, escaneando a collection uma única vez:
///
/// - **Payload (Gap A)**: um `.lrc` adicionado ao lado de um FLAC já indexado
///   nunca muda o mtime/size do FLAC, então o `run_scan` o ignora. Aqui
///   detectamos o sidecar no disco e gravamos `lrc_path`/`embedded_lyrics` via
///   `set_payload` (não toca vetores).
/// - **Vetor (Gap B)**: tracks com texto de letra mas sem o vetor `lyrics`
///   recebem o embedding via `update_vectors` (PUT /points/vectors), que
///   preserva o `mert` intacto (doc Qdrant: "all other unspecified vectors
///   will stay intact").
///
/// Idempotente: pula quem já tem o vetor `lyrics`. No-op quando a cobertura
/// está completa. Roda em thread própria (como o backfill de LUFS) para não
/// bloquear o coordinator. Retorna a contagem de vetores escritos.
fn backfill_lyrics(
    client: &QdrantClient,
    lyrics_client: &LyricsEmbedClient,
) -> Result<usize, IndexerError> {
    let rows = client.scroll_all_lyrics_state(&["path", "lrc_path", "embedded_lyrics"])?;
    if rows.is_empty() {
        info!(target: "library_indexer::pipeline", "lyrics backfill: collection vazia");
        return Ok(0);
    }

    let total = rows.len();
    let mut payload_updates = 0usize;
    let mut embedded = 0usize;
    let mut failed = 0usize;
    let mut vector_batch: Vec<(u64, Vec<f32>)> = Vec::new();

    for (id, payload, has_lyrics_vector) in rows {
        let resolved = resolve_lyrics(&payload);

        // Gap A: sidecar novo no disco → grava no payload (não toca vetores).
        if let Some(ref lrc) = resolved.lrc_path_for_payload {
            if let Err(e) =
                client.set_payload(&[id], json!({ "lrc_path": lrc }))
            {
                warn!(
                    target: "library_indexer::pipeline",
                    track_id = id, error = %e,
                    "lyrics backfill: set_payload lrc_path falhou"
                );
            } else {
                payload_updates += 1;
            }
        }

        // Gap B: tem texto mas falta o vetor lyrics → embeda.
        if has_lyrics_vector {
            continue;
        }
        let Some(text) = resolved.text else { continue };

        match lyrics_client.embed_text(&text) {
            Ok(vec) => {
                vector_batch.push((id, vec));
                embedded += 1;
            }
            Err(e) => {
                warn!(
                    target: "library_indexer::pipeline",
                    track_id = id, error = %e,
                    "lyrics backfill: embed falhou"
                );
                failed += 1;
            }
        }

        if vector_batch.len() >= 50 {
            flush_lyrics_vectors(client, &mut vector_batch);
        }
    }

    flush_lyrics_vectors(client, &mut vector_batch);

    info!(
        target: "library_indexer::pipeline",
        total, payload_updates, embedded, failed,
        "lyrics backfill: bulk pass complete"
    );
    Ok(embedded)
}

/// Escreve um lote de vetores `lyrics` (preserva `mert`) e esvazia o buffer.
/// Falha de escrita é logada mas não aborta o backfill — os pontos do lote
/// serão reprocessados no próximo startup (idempotente).
fn flush_lyrics_vectors(client: &QdrantClient, batch: &mut Vec<(u64, Vec<f32>)>) {
    if batch.is_empty() {
        return;
    }
    let refs: Vec<(u64, &[f32])> = batch.iter().map(|(id, v)| (*id, v.as_slice())).collect();
    if let Err(e) = client.upsert_lyrics_batch(&refs) {
        warn!(
            target: "library_indexer::pipeline",
            count = refs.len(), error = %e,
            "lyrics backfill: upsert_lyrics_batch falhou"
        );
    }
    batch.clear();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_one_returns_ok_on_success() {
        let r = embed_one(|| Ok(vec![1.0, 2.0, 3.0]));
        assert_eq!(r.unwrap(), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn embed_one_returns_err_on_error() {
        let r = embed_one(|| Err(IndexerError::Embedding("boom".into())));
        assert!(r.unwrap_err().contains("boom"));
    }

    #[test]
    fn embed_one_catches_panic_instead_of_propagating() {
        // Um panic no decode/preprocess NÃO deve matar a thread do worker —
        // deve virar um Err daquele job para o pipeline seguir.
        let r = embed_one(|| panic!("symphonia explodiu"));
        let err = r.expect_err("panic deve virar Err, não propagar");
        assert!(
            err.contains("panicked") && err.contains("symphonia explodiu"),
            "mensagem de erro deve preservar o motivo do panic: {err}"
        );
    }

    // --- resolve_lyrics --------------------------------------------------------

    #[test]
    fn resolve_lyrics_uses_embedded_text_when_present() {
        // embedded_lyrics já no payload (com timestamps) → limpa e usa, sem
        // tocar no disco. Não há .lrc novo para anexar ao payload.
        let payload = json!({
            "path": "/nao/existe/track.flac",
            "embedded_lyrics": "[00:00.00] primeira linha da letra\n[00:05.00] segunda linha da letra",
        });
        let r = resolve_lyrics(&payload);
        assert_eq!(
            r.text.as_deref(),
            Some("primeira linha da letra\nsegunda linha da letra")
        );
        assert_eq!(r.lrc_path_for_payload, None);
    }

    #[test]
    fn resolve_lyrics_ignores_short_embedded_text() {
        // embedded_lyrics curto (<=20 chars após limpeza) não vale como letra
        // — espelha o guard do script Python (len > 20).
        let payload = json!({
            "path": "/nao/existe/track.flac",
            "embedded_lyrics": "[00:00.00] oi",
        });
        let r = resolve_lyrics(&payload);
        assert_eq!(r.text, None);
        assert_eq!(r.lrc_path_for_payload, None);
    }

    #[test]
    fn resolve_lyrics_reads_lrc_path_from_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let lrc = tmp.path().join("track.lrc");
        std::fs::write(&lrc, "[00:00.00] uma letra bem comprida de teste\n").unwrap();

        let payload = json!({
            "path": tmp.path().join("track.flac").to_string_lossy(),
            "lrc_path": lrc.to_string_lossy(),
        });
        let r = resolve_lyrics(&payload);
        assert_eq!(r.text.as_deref(), Some("uma letra bem comprida de teste"));
        // lrc_path já estava no payload → nada a anexar.
        assert_eq!(r.lrc_path_for_payload, None);
    }

    #[test]
    fn resolve_lyrics_detects_sidecar_not_yet_in_payload() {
        // Gap A: FLAC já indexado, .lrc chegou ao lado depois, payload NÃO tem
        // lrc_path nem embedded_lyrics. resolve_lyrics acha o sidecar no disco,
        // devolve o texto E o caminho para popular o payload.
        let tmp = tempfile::tempdir().unwrap();
        let flac = tmp.path().join("track.flac");
        let lrc = tmp.path().join("track.lrc");
        std::fs::write(&flac, b"fake").unwrap();
        std::fs::write(&lrc, "[00:00.00] letra que chegou depois do flac\n").unwrap();

        let payload = json!({ "path": flac.to_string_lossy() });
        let r = resolve_lyrics(&payload);
        assert_eq!(r.text.as_deref(), Some("letra que chegou depois do flac"));
        assert_eq!(
            r.lrc_path_for_payload.as_deref(),
            Some(lrc.to_string_lossy().as_ref()),
            "deve sinalizar o lrc_path para o set_payload do Gap A"
        );
    }

    #[test]
    fn resolve_lyrics_none_when_no_text_anywhere() {
        let tmp = tempfile::tempdir().unwrap();
        let flac = tmp.path().join("track.flac");
        std::fs::write(&flac, b"fake").unwrap();
        let payload = json!({ "path": flac.to_string_lossy() });
        let r = resolve_lyrics(&payload);
        assert_eq!(r.text, None);
        assert_eq!(r.lrc_path_for_payload, None);
    }
}
