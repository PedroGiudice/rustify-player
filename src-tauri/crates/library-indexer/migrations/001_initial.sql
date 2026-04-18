-- Initial schema for rustify-player library index.
-- Single SQLite file (default path: ~/.local/share/rustify-player/library.db).
-- WAL mode so background writers (coordinator + embedding worker) do not
-- block readers (UI queries).

PRAGMA foreign_keys = ON;

-- Curated top-level genres. Seeded from `seeds/genres.json` on migration.
CREATE TABLE IF NOT EXISTS genres (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0
);

-- Artists. Unique per normalized (case-insensitive) name.
CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name_nocase
    ON artists(name COLLATE NOCASE);

-- Albums. Unique per (title, album_artist) case-insensitive.
CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    album_artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    year INTEGER,
    cover_path TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_title_artist
    ON albums(title COLLATE NOCASE, IFNULL(album_artist_id, -1));
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(album_artist_id);

-- Tracks. The heart of the schema.
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,

    title TEXT NOT NULL,
    track_number INTEGER,
    disc_number INTEGER NOT NULL DEFAULT 1,
    duration_ms INTEGER NOT NULL,

    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    genre_id INTEGER REFERENCES genres(id) ON DELETE SET NULL,

    sample_rate INTEGER NOT NULL,
    bit_depth INTEGER NOT NULL,
    channels INTEGER NOT NULL,

    rg_track_gain REAL,
    rg_album_gain REAL,
    rg_track_peak REAL,
    rg_album_peak REAL,

    embedding BLOB,
    embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending','done','failed')),
    embedding_error TEXT,

    play_count INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER,

    indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre_id);
CREATE INDEX IF NOT EXISTS idx_tracks_mtime ON tracks(mtime);
CREATE INDEX IF NOT EXISTS idx_tracks_embedding_pending
    ON tracks(embedding_status) WHERE embedding_status = 'pending';

-- Tags (open-ended, many-to-many).
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_nocase
    ON tags(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS track_tags (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (track_id, tag_id)
);

-- FTS5 virtual table. Not content-linked — we populate it from triggers
-- or bulk inserts from the coordinator after writing tracks.
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title,
    album_title,
    artist_name,
    tags,
    tokenize='unicode61 remove_diacritics 2',
    content=''
);
