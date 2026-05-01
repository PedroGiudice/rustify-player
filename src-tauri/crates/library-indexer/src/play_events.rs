use crate::error::IndexerError;
use rusqlite::{params, Connection};

pub fn insert_play_event(
    conn: &Connection,
    track_id: i64,
    origin: &str,
    started_at: &str,
    ended_at: Option<&str>,
    end_position_ms: Option<i64>,
    duration_ms: i64,
) -> Result<(), IndexerError> {
    conn.execute(
        "INSERT INTO play_events (track_id, origin, started_at, ended_at, end_position_ms, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![track_id, origin, started_at, ended_at, end_position_ms, duration_ms],
    )?;
    Ok(())
}

/// Extract positive and negative track IDs from play_events for Qdrant Recommendations.
///
/// Positives: completed plays from manual or autoplay-confirmed (up to 50, most recent first).
/// Negatives: skipped early (< 5 s, excluding album_seq inertia, up to 20, most recent first).
pub fn behavioral_signals(
    conn: &Connection,
) -> Result<(Vec<i64>, Vec<i64>), IndexerError> {
    let mut pos_stmt = conn.prepare(
        "SELECT DISTINCT track_id FROM play_events
         WHERE completed = 1 AND origin IN ('manual', 'autoplay')
         ORDER BY started_at DESC LIMIT 50",
    )?;
    let positives: Vec<i64> = pos_stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut neg_stmt = conn.prepare(
        "SELECT DISTINCT track_id FROM play_events
         WHERE completed = 0
           AND end_position_ms IS NOT NULL
           AND end_position_ms < 5000
           AND origin != 'album_seq'
         ORDER BY started_at DESC LIMIT 20",
    )?;
    let negatives: Vec<i64> = neg_stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok((positives, negatives))
}

/// Returns `Vec<(track_id, score)>` ordered by rank.
/// Checks `track_recommendations` first; returns empty if none found.
pub fn autoplay_next(
    conn: &Connection,
    seed_track_id: i64,
    exclude_ids: &[i64],
    limit: usize,
) -> Result<Vec<(i64, f64)>, IndexerError> {
    let exclude_csv = if exclude_ids.is_empty() {
        "0".to_string()
    } else {
        exclude_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",")
    };

    let sql = format!(
        "SELECT recommended_track_id, score
         FROM track_recommendations
         WHERE seed_track_id = ?1
           AND strategy = 'mert'
           AND recommended_track_id NOT IN ({exclude_csv})
         ORDER BY rank
         LIMIT ?2"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![seed_track_id, limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}
