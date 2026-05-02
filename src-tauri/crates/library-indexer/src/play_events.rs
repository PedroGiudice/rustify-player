use crate::error::IndexerError;
use crate::qdrant_client::QdrantClient;
use rusqlite::{params, Connection};

pub fn insert_play_event(
    conn: &Connection,
    qdrant: Option<&QdrantClient>,
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

    if let Some(client) = qdrant {
        let end_pos = end_position_ms.unwrap_or(0) as u64;
        let dur = duration_ms as u64;
        if let Err(e) = client.insert_play_event(track_id, origin, started_at, end_pos, dur) {
            tracing::warn!(?e, track_id, "failed to insert play_event to Qdrant");
        }
    }

    Ok(())
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
