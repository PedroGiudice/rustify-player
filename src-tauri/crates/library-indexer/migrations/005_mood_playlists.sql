CREATE TABLE IF NOT EXISTS mood_playlists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    centroid BLOB,
    track_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mood_playlist_tracks (
    mood_playlist_id INTEGER REFERENCES mood_playlists(id) ON DELETE CASCADE,
    track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    distance REAL,
    PRIMARY KEY (mood_playlist_id, track_id)
);
