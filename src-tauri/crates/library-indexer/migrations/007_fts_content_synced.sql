-- Denormalize album_title, artist_name, and tags into the tracks table
-- so FTS5 can use content-sync (content='tracks'). These columns are
-- immutable in practice (sourced from FLAC metadata), so sync cost is zero.

ALTER TABLE tracks ADD COLUMN album_title TEXT DEFAULT '';
ALTER TABLE tracks ADD COLUMN artist_name TEXT DEFAULT '';
ALTER TABLE tracks ADD COLUMN tags TEXT DEFAULT '';

UPDATE tracks SET
    album_title = COALESCE((SELECT title FROM albums WHERE id = tracks.album_id), ''),
    artist_name = COALESCE((SELECT name FROM artists WHERE id = tracks.artist_id), ''),
    tags = COALESCE((
        SELECT GROUP_CONCAT(t.name, ' ')
        FROM track_tags tt JOIN tags t ON t.id = tt.tag_id
        WHERE tt.track_id = tracks.id
    ), '');

-- Drop the old contentless FTS table and recreate as content-synced.
DROP TABLE IF EXISTS tracks_fts;

CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title,
    album_title,
    artist_name,
    tags,
    content='tracks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Delete trigger: FTS5 content-sync requires the OLD values to locate
-- and remove index entries. INSERT/UPDATE are handled by the pipeline
-- (which populates denormalized columns before writing FTS).
CREATE TRIGGER tracks_fts_delete AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, album_title, artist_name, tags)
    VALUES ('delete', OLD.id, OLD.title, OLD.album_title, OLD.artist_name, OLD.tags);
END;

-- Rebuild the index from existing data.
INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild');
