//! Filesystem watcher with debounce, emitting only FLAC-relevant events.
//!
//! Wraps `notify::RecommendedWatcher` with a debounce layer tuned for the
//! indexer's needs:
//!
//! - **Only `.flac` files** (case-insensitive). Everything else is dropped
//!   at the earliest stage — we never allocate a `PendingEntry` for it.
//! - **Hidden directories are skipped** (any path component starting with
//!   `.`). This matches the scan-time rule and prevents trash folders,
//!   `.git`, tempdirs, etc. from generating noise.
//! - **2-second debounce window** with a "latest intent wins" collapse:
//!   `Remove > Modified > Created`. Remove always wins (a file that's
//!   gone doesn't need to be reindexed). For ties between Modified and
//!   Created, the later event wins. The window is *trailing-edge*: any
//!   new event for a path refreshes its timer, so a burst of writes
//!   during a large copy collapses into a single flush 2s after the
//!   last event.
//!
//! ## Threading
//!
//! Two threads back this module:
//!
//! 1. **notify's internal thread** — owned by `RecommendedWatcher`. It
//!    pushes raw events into an internal channel.
//! 2. **Debounce thread** — spawned by `start`. Polls the raw channel
//!    with a 100ms timeout, accumulates into a `HashMap<PathBuf, Pending>`,
//!    and every poll flushes entries whose last-seen age >= 2s.
//!
//! `FsWatcher` owns both via `Drop`: dropping signals the debounce thread
//! to exit and drops the `RecommendedWatcher`, which stops the notify
//! thread.

#![allow(dead_code)]

use crate::error::IndexerError;
use crossbeam_channel::{Receiver, Sender};
use notify::event::EventKind;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tracing::warn;

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(2000);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// A debounced, FLAC-filtered filesystem event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// A new FLAC file appeared.
    Created(PathBuf),
    /// An existing FLAC file changed (mtime/content).
    Modified(PathBuf),
    /// A FLAC file was removed.
    Removed(PathBuf),
}

/// Resolved intent for a path within a debounce window.
///
/// Ordering encodes the collapse priority: `Remove > Modified > Created`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Intent {
    Created = 0,
    Modified = 1,
    Removed = 2,
}

impl Intent {
    fn to_event(self, path: PathBuf) -> WatchEvent {
        match self {
            Intent::Created => WatchEvent::Created(path),
            Intent::Modified => WatchEvent::Modified(path),
            Intent::Removed => WatchEvent::Removed(path),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct PendingEntry {
    intent: Intent,
    last_seen: Instant,
}

/// Filesystem watcher. Dropping stops both the notify and debounce threads.
pub struct FsWatcher {
    _watcher: RecommendedWatcher,
    shutdown_tx: Sender<()>,
    debounce_handle: Option<JoinHandle<()>>,
}

impl FsWatcher {
    /// Start watching `music_root` recursively. Debounced [`WatchEvent`]s
    /// are sent on `event_tx`. Dropping the returned `FsWatcher` stops the
    /// watcher and joins the debounce thread.
    pub fn start(
        music_root: &Path,
        event_tx: Sender<WatchEvent>,
    ) -> Result<Self, IndexerError> {
        let (raw_tx, raw_rx) = crossbeam_channel::unbounded::<RawSignal>();
        let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(1);

        let notify_tx = raw_tx.clone();
        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                match res {
                    Ok(event) => {
                        for signal in translate(&event) {
                            let _ = notify_tx.send(signal);
                        }
                    }
                    Err(e) => {
                        warn!(target: "library_indexer::watch", error = %e, "notify error");
                    }
                }
            })?;

        watcher.watch(music_root, RecursiveMode::Recursive)?;

        let debounce_handle = thread::Builder::new()
            .name("library-indexer-debounce".into())
            .spawn(move || debounce_loop(raw_rx, shutdown_rx, event_tx))
            .map_err(IndexerError::Io)?;

        Ok(Self {
            _watcher: watcher,
            shutdown_tx,
            debounce_handle: Some(debounce_handle),
        })
    }
}

impl Drop for FsWatcher {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(());
        if let Some(h) = self.debounce_handle.take() {
            let _ = h.join();
        }
    }
}

/// Internal signal pushed from the notify thread into the debounce thread.
#[derive(Debug, Clone)]
struct RawSignal {
    path: PathBuf,
    intent: Intent,
}

/// Translate a raw `notify::Event` into zero-or-more internal signals.
/// Applies the FLAC + hidden-dir filters here so garbage never enters the
/// debounce map.
fn translate(event: &notify::Event) -> Vec<RawSignal> {
    let intent = match event.kind {
        EventKind::Create(_) => Intent::Created,
        EventKind::Modify(_) => Intent::Modified,
        EventKind::Remove(_) => Intent::Removed,
        _ => return Vec::new(),
    };

    event
        .paths
        .iter()
        .filter(|p| extension_is_flac(p) && !has_hidden_component(p))
        .map(|p| RawSignal {
            path: p.clone(),
            intent,
        })
        .collect()
}

fn debounce_loop(
    raw_rx: Receiver<RawSignal>,
    shutdown_rx: Receiver<()>,
    out_tx: Sender<WatchEvent>,
) {
    let mut pending: HashMap<PathBuf, PendingEntry> = HashMap::new();

    loop {
        match raw_rx.recv_timeout(POLL_INTERVAL) {
            Ok(signal) => {
                merge_signal(&mut pending, signal);
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                break;
            }
        }

        if shutdown_rx.try_recv().is_ok() {
            break;
        }

        flush_expired(&mut pending, &out_tx);
    }
}

fn merge_signal(pending: &mut HashMap<PathBuf, PendingEntry>, signal: RawSignal) {
    let now = Instant::now();
    pending
        .entry(signal.path)
        .and_modify(|e| {
            if signal.intent >= e.intent {
                e.intent = signal.intent;
            }
            e.last_seen = now;
        })
        .or_insert(PendingEntry {
            intent: signal.intent,
            last_seen: now,
        });
}

fn flush_expired(
    pending: &mut HashMap<PathBuf, PendingEntry>,
    out_tx: &Sender<WatchEvent>,
) {
    if pending.is_empty() {
        return;
    }
    let now = Instant::now();
    let expired: Vec<PathBuf> = pending
        .iter()
        .filter(|(_, e)| now.duration_since(e.last_seen) >= DEBOUNCE_WINDOW)
        .map(|(p, _)| p.clone())
        .collect();
    for path in expired {
        if let Some(entry) = pending.remove(&path) {
            let _ = out_tx.send(entry.intent.to_event(path));
        }
    }
}

/// True if `path` has a `.flac` extension, case-insensitive.
pub(crate) fn extension_is_flac(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("flac"))
        .unwrap_or(false)
}

/// True if any component of `path` starts with `.` — matches scan-time rule.
pub(crate) fn has_hidden_component(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| s.starts_with('.'))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn extension_is_flac_cases() {
        assert!(extension_is_flac(Path::new("x.flac")));
        assert!(extension_is_flac(Path::new("x.FLAC")));
        assert!(extension_is_flac(Path::new("x.Flac")));
        assert!(!extension_is_flac(Path::new("x.txt")));
        assert!(!extension_is_flac(Path::new("x")));
        assert!(!extension_is_flac(Path::new("flac")));
        assert!(!extension_is_flac(Path::new("x.flacx")));
    }

    #[test]
    fn has_hidden_component_detects_dot_dirs() {
        assert!(has_hidden_component(Path::new("/tmp/.cache/x.flac")));
        assert!(has_hidden_component(Path::new("/a/b/.hidden/c.flac")));
        assert!(!has_hidden_component(Path::new("/tmp/Music/a/b.flac")));
        assert!(!has_hidden_component(Path::new("/home/user/Music/a.flac")));
    }

    fn feed(pending: &mut HashMap<PathBuf, PendingEntry>, path: &str, intent: Intent) {
        merge_signal(
            pending,
            RawSignal {
                path: PathBuf::from(path),
                intent,
            },
        );
    }

    #[test]
    fn debounce_remove_beats_modified_beats_created() {
        let mut pending = HashMap::new();
        feed(&mut pending, "/a.flac", Intent::Created);
        feed(&mut pending, "/a.flac", Intent::Modified);
        feed(&mut pending, "/a.flac", Intent::Removed);
        feed(&mut pending, "/a.flac", Intent::Modified);
        assert_eq!(pending[&PathBuf::from("/a.flac")].intent, Intent::Removed);
    }

    #[test]
    fn debounce_modified_beats_created() {
        let mut pending = HashMap::new();
        feed(&mut pending, "/a.flac", Intent::Created);
        feed(&mut pending, "/a.flac", Intent::Modified);
        assert_eq!(pending[&PathBuf::from("/a.flac")].intent, Intent::Modified);
    }

    #[test]
    fn debounce_created_then_modified_then_created_resolves_to_created_only_if_tie() {
        let mut pending = HashMap::new();
        feed(&mut pending, "/a.flac", Intent::Created);
        feed(&mut pending, "/a.flac", Intent::Modified);
        feed(&mut pending, "/a.flac", Intent::Created);
        assert_eq!(pending[&PathBuf::from("/a.flac")].intent, Intent::Modified);
    }

    #[test]
    fn debounce_independent_paths_do_not_collide() {
        let mut pending = HashMap::new();
        feed(&mut pending, "/a.flac", Intent::Created);
        feed(&mut pending, "/b.flac", Intent::Removed);
        assert_eq!(pending[&PathBuf::from("/a.flac")].intent, Intent::Created);
        assert_eq!(pending[&PathBuf::from("/b.flac")].intent, Intent::Removed);
    }

    #[test]
    fn flush_expired_removes_only_old_entries() {
        let mut pending = HashMap::new();
        let (tx, rx) = crossbeam_channel::unbounded();

        pending.insert(
            PathBuf::from("/old.flac"),
            PendingEntry {
                intent: Intent::Created,
                last_seen: Instant::now() - Duration::from_secs(5),
            },
        );
        pending.insert(
            PathBuf::from("/fresh.flac"),
            PendingEntry {
                intent: Intent::Modified,
                last_seen: Instant::now(),
            },
        );

        flush_expired(&mut pending, &tx);

        let received: Vec<WatchEvent> = rx.try_iter().collect();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0], WatchEvent::Created(PathBuf::from("/old.flac")));
        assert!(pending.contains_key(Path::new("/fresh.flac")));
        assert!(!pending.contains_key(Path::new("/old.flac")));
    }

    #[test]
    #[ignore = "timing-sensitive; run manually"]
    fn integration_detects_new_flac_file() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, rx) = crossbeam_channel::unbounded();
        let _watcher = FsWatcher::start(tmp.path(), tx).unwrap();

        thread::sleep(Duration::from_millis(200));

        let flac_path = tmp.path().join("new.flac");
        fs::write(&flac_path, b"fake flac bytes").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut got = None;
        while Instant::now() < deadline {
            if let Ok(ev) = rx.recv_timeout(Duration::from_millis(200)) {
                got = Some(ev);
                break;
            }
        }

        match got {
            Some(WatchEvent::Created(p)) | Some(WatchEvent::Modified(p)) => {
                assert_eq!(p, flac_path);
            }
            Some(other) => panic!("unexpected event: {:?}", other),
            None => panic!("no event received within 5s"),
        }
    }
}
