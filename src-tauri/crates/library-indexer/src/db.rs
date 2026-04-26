//! SQLite persistence layer.
//!
//! Responsibilities:
//! - Open the DB (creating parent dirs on demand), enable WAL mode.
//! - Run migrations in order from the embedded `migrations/` folder.
//! - Seed curated genres from `seeds/genres.json` on first boot.
//! - Provide a connection pool for read-only queries so UI threads don't
//!   serialize behind coordinator writes.
//!
//! The writer connection lives on the coordinator thread (single writer,
//! per SQLite semantics). Readers are cloned `Arc<Mutex<Connection>>` from
//! the pool. With WAL enabled, readers never block on the writer.

#![allow(dead_code)]

use crate::error::IndexerError;
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::{debug, info};

/// Ordered (version, SQL) pairs embedded at compile time.
const MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("../migrations/001_initial.sql")),
    (2, include_str!("../migrations/002_add_lrc_path.sql")),
    (3, include_str!("../migrations/003_add_embedded_lyrics.sql")),
    (4, include_str!("../migrations/004_add_liked_at.sql")),
    (5, include_str!("../migrations/005_mood_playlists.sql")),
];

/// Flag set in the `meta` table when migration 003 promotes the schema.
/// Startup checks this to trigger a background rescan that backfills
/// `embedded_lyrics` for tracks indexed before the column existed.
pub const META_NEEDS_EMBEDDED_LYRICS_SCAN: &str = "needs_embedded_lyrics_scan";

const GENRE_SEED: &str = include_str!("../seeds/genres.json");

/// Connection pool shared with UI read threads.
///
/// We use `Mutex<Connection>` rather than an r2d2-style pool because the
/// indexer read pattern is bursty and low-concurrency — typical UI query
/// turnover is <50/s. A single read connection guarded by a mutex is
/// simpler and avoids pulling in a connection pool crate.
///
/// SQLite itself enforces that multiple readers on WAL don't conflict, but
/// a single `rusqlite::Connection` is `!Sync`, so the mutex is the safe
/// shared primitive.
#[derive(Clone)]
pub struct ReadPool {
    inner: Arc<Mutex<Connection>>,
    db_path: PathBuf,
}

impl ReadPool {
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Borrow the read connection for the lifetime of a query.
    pub fn with<F, R>(&self, f: F) -> Result<R, IndexerError>
    where
        F: FnOnce(&Connection) -> Result<R, IndexerError>,
    {
        let guard = self
            .inner
            .lock()
            .map_err(|_| IndexerError::Shutdown)?;
        f(&guard)
    }

    /// Spawn an additional read-only connection — useful when the UI wants
    /// to parallelize heavy queries (e.g. similarity scan).
    pub fn spawn_read_conn(&self) -> Result<Connection, IndexerError> {
        open_read_only(&self.db_path)
    }
}

/// A lightweight write connection for the handle to run small mutations
/// (record_play, etc.) without touching the pipeline's writer.
#[derive(Clone)]
pub struct WritePool {
    inner: Arc<Mutex<Connection>>,
}

impl WritePool {
    pub fn with<F, R>(&self, f: F) -> Result<R, IndexerError>
    where
        F: FnOnce(&Connection) -> Result<R, IndexerError>,
    {
        let guard = self.inner.lock().map_err(|_| IndexerError::Shutdown)?;
        f(&guard)
    }
}

/// Result of opening + migrating the DB. The writer connection is
/// consumed by the coordinator thread.
pub struct OpenedDb {
    pub writer: Connection,
    pub pool: ReadPool,
    pub write_pool: WritePool,
}

pub fn open_and_migrate(db_path: &Path) -> Result<OpenedDb, IndexerError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut writer = Connection::open(db_path)?;
    configure_connection(&writer)?;
    apply_migrations(&mut writer)?;
    seed_genres(&writer)?;

    let reader = open_read_only(db_path)?;

    // Separate read-write connection for lightweight handle mutations
    // (record_play, etc.). WAL mode allows concurrent writers — SQLite
    // serializes them internally with a short busy-wait.
    let handle_writer = Connection::open(db_path)?;
    configure_connection(&handle_writer)?;

    Ok(OpenedDb {
        writer,
        pool: ReadPool {
            inner: Arc::new(Mutex::new(reader)),
            db_path: db_path.to_path_buf(),
        },
        write_pool: WritePool {
            inner: Arc::new(Mutex::new(handle_writer)),
        },
    })
}

fn open_read_only(db_path: &Path) -> Result<Connection, IndexerError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(db_path, flags)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "query_only", "ON")?;
    Ok(conn)
}

fn configure_connection(conn: &Connection) -> Result<(), IndexerError> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn apply_migrations(conn: &mut Connection) -> Result<(), IndexerError> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
        [],
    )?;

    let current: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    for &(version, sql) in MIGRATIONS {
        if version <= current {
            continue;
        }
        info!(target: "library_indexer::db", version, "applying migration");
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_version (version) VALUES (?)",
            params![version],
        )?;
        // When migration 003 is the one just applied, flag a one-shot
        // rescan so existing tracks backfill the new `embedded_lyrics`
        // column. The `meta` table is created in migration 003 itself.
        if version == 3 {
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')",
                params![META_NEEDS_EMBEDDED_LYRICS_SCAN],
            )?;
        }
        tx.commit()?;
    }

    Ok(())
}

/// Read a value from the `meta` key-value table. Returns `None` when the
/// key is absent or the `meta` table doesn't exist yet (pre-migration-3 DB).
pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, IndexerError> {
    let has_meta: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_meta == 0 {
        return Ok(None);
    }
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?",
            params![key],
            |row| row.get(0),
        )
        .ok();
    Ok(value)
}

/// Delete a key from the `meta` table. No-op when absent or when the table
/// itself doesn't exist.
pub fn meta_clear(conn: &Connection, key: &str) -> Result<(), IndexerError> {
    let has_meta: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_meta == 0 {
        return Ok(());
    }
    conn.execute("DELETE FROM meta WHERE key = ?", params![key])?;
    Ok(())
}

#[derive(Deserialize)]
struct SeedGenre {
    name: String,
    display_order: i32,
}

fn seed_genres(conn: &Connection) -> Result<(), IndexerError> {
    let existing: i64 =
        conn.query_row("SELECT COUNT(*) FROM genres", [], |row| row.get(0))?;
    if existing > 0 {
        debug!(target: "library_indexer::db", existing, "genres already seeded");
        return Ok(());
    }

    let seed: Vec<SeedGenre> = serde_json::from_str(GENRE_SEED)?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO genres (name, display_order) VALUES (?, ?)",
    )?;
    for g in &seed {
        stmt.execute(params![g.name, g.display_order])?;
    }
    info!(
        target: "library_indexer::db",
        count = seed.len(),
        "seeded genres"
    );
    Ok(())
}

// --- Upsert helpers -------------------------------------------------------
// Used by the ingest pipeline. Writer-side only; readers never call these.

pub fn upsert_artist(conn: &Connection, name: &str) -> Result<i64, IndexerError> {
    if let Ok(id) = conn
        .query_row(
            "SELECT id FROM artists WHERE name = ? COLLATE NOCASE",
            params![name],
            |row| row.get::<_, i64>(0),
        )
    {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO artists (name) VALUES (?)",
        params![name],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn upsert_album(
    conn: &Connection,
    title: &str,
    album_artist_id: Option<i64>,
    year: Option<i32>,
) -> Result<i64, IndexerError> {
    if let Ok(id) = conn
        .query_row(
            "SELECT id FROM albums
             WHERE title = ? COLLATE NOCASE
               AND IFNULL(album_artist_id, -1) = IFNULL(?, -1)",
            params![title, album_artist_id],
            |row| row.get::<_, i64>(0),
        )
    {
        // Fill year if previously null.
        if let Some(y) = year {
            conn.execute(
                "UPDATE albums SET year = COALESCE(year, ?) WHERE id = ?",
                params![y, id],
            )?;
        }
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)",
        params![title, album_artist_id, year],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn upsert_genre(conn: &Connection, name: &str) -> Result<i64, IndexerError> {
    if let Ok(id) = conn
        .query_row(
            "SELECT id FROM genres WHERE name = ? COLLATE NOCASE",
            params![name],
            |row| row.get::<_, i64>(0),
        )
    {
        return Ok(id);
    }
    let next_order: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(display_order), 0) + 1 FROM genres",
            [],
            |row| row.get(0),
        )
        .unwrap_or(100);
    conn.execute(
        "INSERT INTO genres (name, display_order) VALUES (?, ?)",
        params![name, next_order],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn upsert_tag(conn: &Connection, name: &str) -> Result<i64, IndexerError> {
    if let Ok(id) = conn
        .query_row(
            "SELECT id FROM tags WHERE name = ? COLLATE NOCASE",
            params![name],
            |row| row.get::<_, i64>(0),
        )
    {
        return Ok(id);
    }
    conn.execute("INSERT INTO tags (name) VALUES (?)", params![name])?;
    Ok(conn.last_insert_rowid())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_tmp() -> (OpenedDb, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("library.db");
        let db = open_and_migrate(&db_path).unwrap();
        (db, tmp)
    }

    #[test]
    fn migrations_applied() {
        let (db, _tmp) = open_tmp();
        let version: i32 = db
            .writer
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn genres_seeded() {
        let (db, _tmp) = open_tmp();
        let count: i64 = db
            .writer
            .query_row("SELECT COUNT(*) FROM genres", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 15);
    }

    #[test]
    fn reopen_does_not_reseed() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("library.db");

        let db1 = open_and_migrate(&db_path).unwrap();
        db1.writer
            .execute(
                "INSERT INTO genres (name, display_order) VALUES ('Extra', 99)",
                [],
            )
            .unwrap();
        drop(db1);

        let db2 = open_and_migrate(&db_path).unwrap();
        let count: i64 = db2
            .writer
            .query_row("SELECT COUNT(*) FROM genres", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 16, "re-open must not re-seed default genres");
    }

    #[test]
    fn upsert_artist_is_case_insensitive() {
        let (db, _tmp) = open_tmp();
        let a = upsert_artist(&db.writer, "Baco Exu Do Blues").unwrap();
        let b = upsert_artist(&db.writer, "baco exu do blues").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn upsert_album_backfills_year() {
        let (db, _tmp) = open_tmp();
        let artist = upsert_artist(&db.writer, "Belchior").unwrap();
        let id1 = upsert_album(&db.writer, "Alucinação", Some(artist), None).unwrap();
        let id2 =
            upsert_album(&db.writer, "Alucinação", Some(artist), Some(1976)).unwrap();
        assert_eq!(id1, id2);
        let year: i32 = db
            .writer
            .query_row(
                "SELECT year FROM albums WHERE id = ?",
                params![id1],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(year, 1976);
    }

    #[test]
    fn read_pool_is_readonly() {
        let (db, _tmp) = open_tmp();
        let err = db
            .pool
            .with(|conn| Ok(conn.execute("INSERT INTO tags (name) VALUES ('x')", [])?));
        assert!(err.is_err(), "read pool must reject writes");
    }
}
