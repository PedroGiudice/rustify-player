//! Indexer coordinator thread + embedding worker.
//!
//! The coordinator owns the writer connection (SQLite allows only one),
//! drives the scan → parse → cover → insert flow, and feeds a single
//! embedding worker thread. Events are broadcast to UI subscribers via
//! `crossbeam_channel`.
//!
//! ## Flow on startup
//!
//! 1. Walk `music_root`, compute `(path, mtime, size)` per FLAC.
//! 2. Diff against DB: new, changed, removed.
//! 3. For each new/changed: parse metadata, write album/artist/genre/tags,
//!    upsert track row, mirror to `tracks_fts`, extract + cache cover.
//! 4. Enqueue `embedding_status = 'pending'` tracks into the embed worker.
//! 5. Embed worker: HTTP POST to `rustify-embed` service, write BLOB on
//!    success, mark `failed` on error.
//!
//! ## Concurrency
//!
//! - Coordinator thread: exclusive writer, serves all DB mutations.
//! - Embed worker thread: no DB writes directly — sends results back to
//!   the coordinator via `embed_results` channel. Single writer invariant
//!   preserved.
//! - Read queries (UI) go through the separate `ReadPool` which opens a
//!   read-only connection in WAL mode.

#![allow(dead_code)]

use crate::cover::{self, CoverSource};
use crate::db::{self, OpenedDb, ReadPool};
use crate::embed_client::EmbedClient;
use crate::error::IndexerError;
use crate::lyrics;
use crate::metadata::{self, ParsedFlacMetadata, PictureUsage};
use crate::scan::{self, FileEntry};
use crate::types::{IndexerCommand, IndexerEvent, IndexerSnapshot};
use crossbeam_channel::{select, unbounded, Receiver, Sender};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};

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

    pub fn refresh_from_db(&self, conn: &Connection) {
        let (total, done, pending, failed) = counts(conn).unwrap_or((0, 0, 0, 0));
        self.tracks_total.store(total, Ordering::Relaxed);
        self.embeddings_done.store(done, Ordering::Relaxed);
        self.embeddings_pending.store(pending, Ordering::Relaxed);
        self.embeddings_failed.store(failed, Ordering::Relaxed);
    }
}

fn counts(conn: &Connection) -> Result<(u64, u64, u64, u64), IndexerError> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tracks WHERE embedding_status = 'done'",
        [],
        |r| r.get(0),
    )?;
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tracks WHERE embedding_status = 'pending'",
        [],
        |r| r.get(0),
    )?;
    let failed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tracks WHERE embedding_status = 'failed'",
        [],
        |r| r.get(0),
    )?;
    Ok((total as u64, done as u64, pending as u64, failed as u64))
}

/// Handle returned to callers that owns the spawned threads.
pub(crate) struct Handles {
    pub coordinator: JoinHandle<()>,
    pub embed_worker: Option<JoinHandle<()>>,
}

pub(crate) struct PipelineConfig {
    pub music_root: PathBuf,
    pub cache_dir: PathBuf,
    pub embed_client: Option<EmbedClient>,
}

/// Start the coordinator + embed worker. Returns channels and shared state.
pub(crate) fn start(
    db: OpenedDb,
    config: PipelineConfig,
) -> (
    Sender<IndexerCommand>,
    Receiver<IndexerEvent>,
    Arc<SharedState>,
    ReadPool,
    Handles,
) {
    let (cmd_tx, cmd_rx) = unbounded::<IndexerCommand>();
    let (evt_tx, evt_rx) = unbounded::<IndexerEvent>();
    let state = Arc::new(SharedState::default());
    let pool = db.pool.clone();

    // Embed pipeline: optional, only spawned when a client is provided.
    let (embed_job_tx, embed_job_rx) = unbounded::<EmbedJob>();
    let (embed_result_tx, embed_result_rx) = unbounded::<EmbedResult>();

    let embed_worker = config.embed_client.as_ref().map(|client| {
        let client = client.clone();
        let result_tx = embed_result_tx.clone();
        thread::Builder::new()
            .name("library-indexer-embed".into())
            .spawn(move || embed_worker_loop(client, embed_job_rx, result_tx))
            .expect("spawn embed worker")
    });

    let coord_state = Arc::clone(&state);
    let coord_evt_tx = evt_tx.clone();
    let coordinator = thread::Builder::new()
        .name("library-indexer-coord".into())
        .spawn(move || {
            coordinator_loop(
                db.writer,
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
        pool,
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
    mut writer: Connection,
    config: PipelineConfig,
    cmd_rx: Receiver<IndexerCommand>,
    evt_tx: Sender<IndexerEvent>,
    state: Arc<SharedState>,
    embed_job_tx: Sender<EmbedJob>,
    embed_result_rx: Receiver<EmbedResult>,
) {
    info!(target: "library_indexer::pipeline", "coordinator starting");
    state.refresh_from_db(&writer);

    // Initial scan is always a full rescan — the UI usually wants to see
    // something immediately on boot.
    if let Err(e) = run_scan(&mut writer, &config, &evt_tx, &state, &embed_job_tx) {
        error!(target: "library_indexer::pipeline", error = %e, "initial scan failed");
        let _ = evt_tx.send(IndexerEvent::Error(e.to_string()));
    }

    loop {
        select! {
            recv(cmd_rx) -> msg => match msg {
                Ok(IndexerCommand::Rescan) => {
                    if let Err(e) = run_scan(&mut writer, &config, &evt_tx, &state, &embed_job_tx) {
                        error!(target: "library_indexer::pipeline", error = %e, "rescan failed");
                        let _ = evt_tx.send(IndexerEvent::Error(e.to_string()));
                    }
                }
                Ok(IndexerCommand::Shutdown) | Err(_) => break,
            },
            recv(embed_result_rx) -> msg => match msg {
                Ok(result) => {
                    apply_embed_result(&writer, &result, &state, &evt_tx);
                }
                Err(_) => {
                    // Embed worker closed — OK, just keep going without embeddings.
                }
            },
        }
    }

    info!(target: "library_indexer::pipeline", "coordinator exiting");
}

fn run_scan(
    writer: &mut Connection,
    config: &PipelineConfig,
    evt_tx: &Sender<IndexerEvent>,
    state: &Arc<SharedState>,
    embed_job_tx: &Sender<EmbedJob>,
) -> Result<(), IndexerError> {
    state.scan_in_progress.store(true, Ordering::Relaxed);
    let _ = evt_tx.send(IndexerEvent::ScanStarted);

    let entries: Vec<FileEntry> = scan::walk_music_root(&config.music_root)?.collect();
    let total = entries.len() as u64;
    let existing = load_existing(writer)?;

    let mut added = 0u64;
    let mut updated = 0u64;
    let mut removed = 0u64;

    let seen_paths: std::collections::HashSet<PathBuf> =
        entries.iter().map(|e| e.path.clone()).collect();

    // Deletions: anything in DB but not on disk.
    let to_delete: Vec<(i64, PathBuf)> = existing
        .iter()
        .filter(|(_, path, _, _)| !seen_paths.contains(path))
        .map(|(id, path, _, _)| (*id, path.clone()))
        .collect();
    for (id, _path) in &to_delete {
        delete_track(writer, *id)?;
        removed += 1;
        let _ = evt_tx.send(IndexerEvent::TrackRemoved(*id));
    }

    // Index existing-by-path → (id, mtime, size).
    let by_path: std::collections::HashMap<PathBuf, (i64, i64, i64)> = existing
        .into_iter()
        .map(|(id, p, mt, sz)| (p, (id, mt, sz)))
        .collect();

    let mut processed = 0u64;
    for entry in entries {
        processed += 1;
        let prior = by_path.get(&entry.path);
        let needs_ingest = match prior {
            None => true,
            Some((_, mt, sz)) => (*mt as u64) != entry.mtime || (*sz as u64) != entry.size,
        };
        if needs_ingest {
            match ingest_one(writer, config, &entry) {
                Ok((track_id, is_new)) => {
                    if is_new {
                        added += 1;
                    } else {
                        updated += 1;
                    }
                    // Enqueue embedding; worker will no-op if client is absent.
                    let _ = embed_job_tx.send(EmbedJob {
                        track_id,
                        path: entry.path.clone(),
                    });
                }
                Err(e) => {
                    warn!(target: "library_indexer::pipeline", path = ?entry.path, error = %e, "ingest failed");
                }
            }
        } else if prior.is_some() {
            // Unchanged, but if embedding_status is 'pending' re-enqueue so
            // a previously-offline session eventually gets its vector.
            if let Some((id, _, _)) = prior {
                let status: String = writer
                    .query_row(
                        "SELECT embedding_status FROM tracks WHERE id = ?",
                        params![id],
                        |row| row.get(0),
                    )
                    .unwrap_or_else(|_| "done".into());
                if status == "pending" {
                    let _ = embed_job_tx.send(EmbedJob {
                        track_id: *id,
                        path: entry.path.clone(),
                    });
                }
            }
        }

        if processed % 25 == 0 {
            let _ = evt_tx.send(IndexerEvent::ScanProgress { processed, total });
        }
    }

    let _ = evt_tx.send(IndexerEvent::ScanProgress { processed, total });
    state.refresh_from_db(writer);
    state.scan_in_progress.store(false, Ordering::Relaxed);
    let _ = evt_tx.send(IndexerEvent::ScanDone {
        added,
        updated,
        removed,
    });
    Ok(())
}

fn load_existing(conn: &Connection) -> Result<Vec<(i64, PathBuf, i64, i64)>, IndexerError> {
    let mut stmt = conn.prepare("SELECT id, path, mtime, size_bytes FROM tracks")?;
    let rows = stmt
        .query_map([], |row| {
            let path_str: String = row.get(1)?;
            Ok((row.get::<_, i64>(0)?, PathBuf::from(path_str), row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn ingest_one(
    conn: &mut Connection,
    config: &PipelineConfig,
    entry: &FileEntry,
) -> Result<(i64, bool), IndexerError> {
    let md = metadata::parse_flac(&entry.path)?;

    let tx = conn.transaction()?;
    let result = ingest_within_tx(&tx, config, entry, &md);
    match result {
        Ok(v) => {
            tx.commit()?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback();
            Err(e)
        }
    }
}

fn ingest_within_tx(
    tx: &rusqlite::Transaction<'_>,
    config: &PipelineConfig,
    entry: &FileEntry,
    md: &ParsedFlacMetadata,
) -> Result<(i64, bool), IndexerError> {
    // Resolve artist / album / genre.
    let artist_name = md
        .album_artist
        .clone()
        .or_else(|| md.artist.clone())
        .or_else(|| entry.album_artist_from_path.clone());
    let artist_id = match artist_name.as_deref() {
        Some(name) if !name.trim().is_empty() => Some(db::upsert_artist(tx, name)?),
        _ => None,
    };

    let album_title = md.album.clone().or_else(|| entry.album_from_path.clone());
    let album_year = md.year.or(entry.year_from_path);
    let album_id = match album_title.as_deref() {
        Some(title) if !title.trim().is_empty() => {
            Some(db::upsert_album(tx, title, artist_id, album_year)?)
        }
        _ => None,
    };

    let genre_id = resolve_genre(tx, entry, md)?;

    // Upsert track row.
    let now = unix_now();
    let filename = entry
        .path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let title = md.title.clone().unwrap_or_else(|| filename_stem(&filename));

    let existing_id: Option<i64> = tx
        .query_row(
            "SELECT id FROM tracks WHERE path = ?",
            params![path_str(&entry.path)],
            |row| row.get(0),
        )
        .ok();

    // Discover sidecar .lrc lyrics file.
    let lrc_path = lyrics::find_lrc_sidecar(&entry.path).map(|p| path_str(&p));

    let (track_id, is_new) = if let Some(id) = existing_id {
        tx.execute(
            "UPDATE tracks SET
                filename = ?, mtime = ?, size_bytes = ?,
                title = ?, track_number = ?, disc_number = ?, duration_ms = ?,
                album_id = ?, artist_id = ?, genre_id = ?,
                sample_rate = ?, bit_depth = ?, channels = ?,
                rg_track_gain = ?, rg_album_gain = ?, rg_track_peak = ?, rg_album_peak = ?,
                embedding_status = 'pending', embedding = NULL, embedding_error = NULL,
                indexed_at = ?, lrc_path = ?
             WHERE id = ?",
            params![
                filename,
                entry.mtime as i64,
                entry.size as i64,
                title,
                md.track_number,
                md.disc_number.unwrap_or(1),
                md.duration_ms,
                album_id,
                artist_id,
                genre_id,
                md.sample_rate as i64,
                md.bit_depth as i64,
                md.channels as i64,
                md.rg_track_gain,
                md.rg_album_gain,
                md.rg_track_peak,
                md.rg_album_peak,
                now,
                lrc_path,
                id,
            ],
        )?;
        (id, false)
    } else {
        tx.execute(
            "INSERT INTO tracks
                (path, filename, mtime, size_bytes,
                 title, track_number, disc_number, duration_ms,
                 album_id, artist_id, genre_id,
                 sample_rate, bit_depth, channels,
                 rg_track_gain, rg_album_gain, rg_track_peak, rg_album_peak,
                 embedding_status, indexed_at, lrc_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            params![
                path_str(&entry.path),
                filename,
                entry.mtime as i64,
                entry.size as i64,
                title,
                md.track_number,
                md.disc_number.unwrap_or(1),
                md.duration_ms,
                album_id,
                artist_id,
                genre_id,
                md.sample_rate as i64,
                md.bit_depth as i64,
                md.channels as i64,
                md.rg_track_gain,
                md.rg_album_gain,
                md.rg_track_peak,
                md.rg_album_peak,
                now,
                lrc_path,
            ],
        )?;
        (tx.last_insert_rowid(), true)
    };

    // Tags: wipe and re-insert (simpler than diffing).
    tx.execute("DELETE FROM track_tags WHERE track_id = ?", params![track_id])?;
    for tag_name in &md.tags {
        let tag_id = db::upsert_tag(tx, tag_name)?;
        tx.execute(
            "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)",
            params![track_id, tag_id],
        )?;
    }

    // FTS5 mirror.
    let album_title_for_fts = album_title.clone().unwrap_or_default();
    let artist_name_for_fts = artist_name.clone().unwrap_or_default();
    let tags_concat = md.tags.join(" ");
    tx.execute(
        "INSERT OR REPLACE INTO tracks_fts (rowid, title, album_title, artist_name, tags) \
         VALUES (?, ?, ?, ?, ?)",
        params![
            track_id,
            title,
            album_title_for_fts,
            artist_name_for_fts,
            tags_concat
        ],
    )?;

    // Cover art: only process if we have an album row (one cover per album).
    if let Some(aid) = album_id {
        let cover_source = pick_cover_source(entry, md);
        if let Some(src) = cover_source {
            match cover::process_album_cover(aid, src, &config.cache_dir) {
                Ok(path) => {
                    let rel = path
                        .strip_prefix(&config.cache_dir)
                        .map(|p| p.to_path_buf())
                        .unwrap_or(path);
                    let rel_str = rel.to_string_lossy().to_string();
                    tx.execute(
                        "UPDATE albums SET cover_path = COALESCE(cover_path, ?) WHERE id = ?",
                        params![rel_str, aid],
                    )?;
                }
                Err(e) => {
                    warn!(target: "library_indexer::pipeline", album_id = aid, error = %e, "cover processing failed");
                }
            }
        }
    }

    Ok((track_id, is_new))
}

fn pick_cover_source(entry: &FileEntry, md: &ParsedFlacMetadata) -> Option<CoverSource> {
    // Prefer embedded FrontCover, then any embedded picture, then folder file.
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

fn resolve_genre(
    conn: &Connection,
    entry: &FileEntry,
    md: &ParsedFlacMetadata,
) -> Result<Option<i64>, IndexerError> {
    // 1) Path-based: primary canonical source (see reorg convention).
    if let Some(from_path) = entry.genre_from_path.as_deref() {
        if !from_path.trim().is_empty() {
            return Ok(Some(db::upsert_genre(conn, from_path)?));
        }
    }

    // 2) First tokenized tag matched case-insensitively against existing
    //    genres (exact match only — no fuzzy for MVP).
    for tag in &md.tags {
        let found: Option<i64> = conn
            .query_row(
                "SELECT id FROM genres WHERE name = ? COLLATE NOCASE",
                params![tag],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = found {
            return Ok(Some(id));
        }
    }

    Ok(None)
}

fn delete_track(conn: &mut Connection, id: i64) -> Result<(), IndexerError> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM tracks_fts WHERE rowid = ?",
        params![id],
    )?;
    tx.execute("DELETE FROM tracks WHERE id = ?", params![id])?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Embedding worker
// ---------------------------------------------------------------------------

struct EmbedJob {
    track_id: i64,
    path: PathBuf,
}

struct EmbedResult {
    track_id: i64,
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
        if let Err(msg) = &outcome {
            debug!(target: "library_indexer::pipeline", track_id = job.track_id, error = %msg, "embed failed");
        }
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
    writer: &Connection,
    result: &EmbedResult,
    state: &Arc<SharedState>,
    evt_tx: &Sender<IndexerEvent>,
) {
    match &result.outcome {
        Ok(vector) => {
            let mut bytes = Vec::with_capacity(vector.len() * 4);
            for v in vector {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            let res = writer.execute(
                "UPDATE tracks SET embedding = ?, embedding_status = 'done', embedding_error = NULL \
                 WHERE id = ?",
                params![bytes, result.track_id],
            );
            if let Err(e) = res {
                warn!(target: "library_indexer::pipeline", track_id = result.track_id, error = %e, "write embedding failed");
                return;
            }
            state.embeddings_done.fetch_add(1, Ordering::Relaxed);
            let _ = evt_tx.send(IndexerEvent::EmbeddingDone {
                track_id: result.track_id,
            });
        }
        Err(msg) => {
            let _ = writer.execute(
                "UPDATE tracks SET embedding_status = 'failed', embedding_error = ? WHERE id = ?",
                params![msg, result.track_id],
            );
            state.embeddings_failed.fetch_add(1, Ordering::Relaxed);
        }
    }
    state.refresh_from_db(writer);
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
    name.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| name.to_string())
}
