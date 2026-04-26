-- Add accent_color and cover_path to mood_playlists.
-- Uses a no-op SELECT guard: the CREATE TRIGGER trick won't work for ALTER,
-- so this migration is handled programmatically in db.rs.
-- This file is intentionally empty; the Rust code checks column existence.
SELECT 1;
