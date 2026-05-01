-- Play event tracking for behavioral signals
CREATE TABLE play_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id        INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    origin          TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    end_position_ms INTEGER,
    duration_ms     INTEGER NOT NULL,
    completed       INTEGER GENERATED ALWAYS AS (
                      CASE WHEN end_position_ms IS NOT NULL
                            AND end_position_ms >= duration_ms * 9 / 10
                           THEN 1 ELSE 0 END
                    ) STORED
);

CREATE INDEX idx_pe_track ON play_events(track_id);
CREATE INDEX idx_pe_time  ON play_events(started_at);

-- Pre-computed recommendations from Qdrant batch jobs
CREATE TABLE track_recommendations (
    seed_track_id        INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    recommended_track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    rank                 INTEGER NOT NULL,
    score                REAL NOT NULL,
    strategy             TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (seed_track_id, recommended_track_id, strategy)
);

CREATE INDEX idx_rec_seed ON track_recommendations(seed_track_id, strategy, rank);
