-- Embedded lyrics extracted from audio tags (Vorbis Comment LYRICS / ID3 USLT).
-- Nullable: most tracks won't have embedded lyrics.
ALTER TABLE tracks ADD COLUMN embedded_lyrics TEXT;

-- Key-value metadata table (created here since no prior migration defined it).
-- Used for one-shot flags like `needs_embedded_lyrics_scan`.
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
