-- Add lrc_path column to tracks for sidecar .lrc lyrics files.
-- Nullable: most tracks won't have lyrics.
ALTER TABLE tracks ADD COLUMN lrc_path TEXT;
