use library_indexer::db;
use tempfile::NamedTempFile;

fn test_db() -> rusqlite::Connection {
    let tmp = NamedTempFile::new().unwrap();
    let opened = db::open_and_migrate(tmp.path()).unwrap();
    opened.writer.execute(
        "INSERT INTO tracks (id, path, filename, mtime, size_bytes, title, duration_ms,
         sample_rate, bit_depth, channels, indexed_at)
         VALUES (1, '/test.flac', 'test.flac', 0, 0, 'Test', 180000, 44100, 16, 2, 0)",
        [],
    ).unwrap();
    opened.writer
}

#[test]
fn test_insert_play_event_completed() {
    let conn = test_db();
    library_indexer::play_events::insert_play_event(
        &conn, 1, "manual", "1714560000", Some("1714560180"), Some(175000), 180000,
    )
    .unwrap();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM play_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);

    let completed: i64 = conn
        .query_row(
            "SELECT completed FROM play_events WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(completed, 1);
}

#[test]
fn test_insert_play_event_incomplete() {
    let conn = test_db();
    library_indexer::play_events::insert_play_event(
        &conn, 1, "manual", "1714560000", Some("1714560005"), Some(4000), 180000,
    )
    .unwrap();

    let completed: i64 = conn
        .query_row(
            "SELECT completed FROM play_events WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(completed, 0);
}

#[test]
fn test_autoplay_next_with_recommendations() {
    let conn = test_db();
    for i in 2..=5 {
        conn.execute(
            &format!(
                "INSERT INTO tracks (id, path, filename, mtime, size_bytes, title, duration_ms,
                 sample_rate, bit_depth, channels, indexed_at)
                 VALUES ({i}, '/test{i}.flac', 'test{i}.flac', 0, 0, 'Test {i}', 180000, 44100, 16, 2, 0)"
            ),
            [],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO track_recommendations (seed_track_id, recommended_track_id, rank, score, strategy, updated_at)
         VALUES (1, 2, 1, 0.95, 'mert', '2026-05-01'), (1, 3, 2, 0.90, 'mert', '2026-05-01'),
                (1, 4, 3, 0.85, 'mert', '2026-05-01')",
        [],
    )
    .unwrap();

    let recs = library_indexer::play_events::autoplay_next(&conn, 1, &[], 5).unwrap();
    assert_eq!(recs.len(), 3);
    assert_eq!(recs[0].0, 2);
    assert_eq!(recs[1].0, 3);
}

#[test]
fn test_autoplay_next_excludes_recent() {
    let conn = test_db();
    for i in 2..=5 {
        conn.execute(
            &format!(
                "INSERT INTO tracks (id, path, filename, mtime, size_bytes, title, duration_ms,
                 sample_rate, bit_depth, channels, indexed_at)
                 VALUES ({i}, '/test{i}.flac', 'test{i}.flac', 0, 0, 'Test {i}', 180000, 44100, 16, 2, 0)"
            ),
            [],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO track_recommendations (seed_track_id, recommended_track_id, rank, score, strategy, updated_at)
         VALUES (1, 2, 1, 0.95, 'mert', '2026-05-01'), (1, 3, 2, 0.90, 'mert', '2026-05-01'),
                (1, 4, 3, 0.85, 'mert', '2026-05-01')",
        [],
    )
    .unwrap();

    let recs = library_indexer::play_events::autoplay_next(&conn, 1, &[2, 3], 5).unwrap();
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0].0, 4);
}

#[test]
fn test_autoplay_next_empty_recommendations() {
    let conn = test_db();
    let recs = library_indexer::play_events::autoplay_next(&conn, 1, &[], 5).unwrap();
    assert!(recs.is_empty());
}
