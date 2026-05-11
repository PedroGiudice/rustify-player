//! Session state persistence.
//!
//! Writes a JSON snapshot to `~/.local/share/rustify-player/state.json`
//! so the player can resume the current track + queue + position after
//! the app is reopened. Restoration is paused — the user clicks play
//! to continue, avoiding surprise audio after a system reboot.
//!
//! A staleness window (`MAX_AGE_SECS`) guards against restoring a
//! session that was abandoned days ago. The frontend owns the queue
//! state and is responsible for calling `save` periodically and on
//! lifecycle events.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Sessions older than this are ignored on load and treated as cold start.
/// 6 hours covers "closed yesterday to update / went to lunch" but skips
/// stale state from days ago.
const MAX_AGE_SECS: i64 = 6 * 60 * 60;

const FILE_NAME: &str = "state.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedState {
    /// Current track ID (Qdrant point id). None when no track is loaded.
    ///
    /// Stored as a string because Qdrant point IDs are u64 hashes that
    /// routinely exceed `Number.MAX_SAFE_INTEGER` (2^53). Round-tripping
    /// them through JavaScript `Number` silently truncates the low bits
    /// (typical signature: id ends in zeros). The frontend keeps these
    /// IDs as strings end-to-end; we mirror that here.
    pub track_id: Option<String>,
    /// Position in milliseconds when the snapshot was taken.
    pub position_ms: u64,
    /// IDs of every track in the queue, in playback order.
    /// Stored as strings — see `track_id` comment.
    pub queue_ids: Vec<String>,
    /// Index of the current track within `queue_ids`.
    pub queue_index: usize,
    /// Shuffle / radio mode.
    pub shuffle: bool,
    /// Repeat mode: "off" | "all" | "one".
    pub repeat_mode: String,
    /// Last 30 IDs the user has heard — kept across restarts so the
    /// recommendation excludes survive a reload.
    /// Stored as strings — see `track_id` comment.
    pub recently_played: Vec<String>,
    /// Unix epoch (seconds) when this snapshot was written.
    pub saved_at: i64,
}

fn state_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Read the persisted snapshot from disk. Returns `None` when the file
/// is missing, malformed, or older than `MAX_AGE_SECS`.
pub fn load(data_dir: &PathBuf) -> Option<PersistedState> {
    let path = state_path(data_dir);
    let raw = std::fs::read_to_string(&path).ok()?;
    let state: PersistedState = serde_json::from_str(&raw).ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    if now - state.saved_at > MAX_AGE_SECS {
        return None;
    }
    Some(state)
}

/// Write the snapshot to disk atomically (via tmp + rename) so a crash
/// mid-write can't leave a half-written JSON that fails to parse.
pub fn save(data_dir: &PathBuf, state: &PersistedState) -> Result<(), String> {
    let path = state_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string(state).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
