//! Position tracking and scheduled state updates.
//!
//! Scheduled events solve the "UI-is-ahead" problem: the ring buffer holds
//! ~500 ms of decoded samples that the callback has not yet consumed, so
//! the moment the engine thread switches decoders is NOT the moment the
//! listener hears the new track. Events that need to match the listener's
//! timeline (e.g. `TrackStarted`) are queued with a `fire_at` instant.

#![allow(dead_code)]

use crate::types::StateUpdate;
use std::time::Instant;

pub(crate) struct ScheduledEvent {
    pub fire_at: Instant,
    pub update: StateUpdate,
}

/// Thin wrapper around `Vec<ScheduledEvent>` that keeps the queue sorted by
/// `fire_at`. `drain_ready` returns events whose time has come.
#[derive(Default)]
pub(crate) struct EventScheduler {
    pending: Vec<ScheduledEvent>,
}

impl EventScheduler {
    pub fn schedule(&mut self, event: ScheduledEvent) {
        // Insertion sort: pending is kept sorted; most of the time the event
        // belongs at the end because we schedule in causal order.
        let pos = self
            .pending
            .iter()
            .position(|e| e.fire_at > event.fire_at)
            .unwrap_or(self.pending.len());
        self.pending.insert(pos, event);
    }

    pub fn drain_ready(&mut self, now: Instant) -> impl Iterator<Item = StateUpdate> + '_ {
        let split = self
            .pending
            .iter()
            .position(|e| e.fire_at > now)
            .unwrap_or(self.pending.len());
        self.pending.drain(..split).map(|e| e.update)
    }

    /// Duration to the next scheduled event, if any. Useful for sizing
    /// `select!` timeouts so we don't miss firing.
    pub fn next_delay(&self, now: Instant) -> Option<std::time::Duration> {
        self.pending.first().map(|e| {
            if e.fire_at <= now {
                std::time::Duration::from_millis(0)
            } else {
                e.fire_at - now
            }
        })
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// Given the current ring-buffer fill (unread samples), compute how long
/// those samples will take to leave the buffer at the current stream rate.
pub(crate) fn drain_delay(
    unread_samples: usize,
    sample_rate: u32,
    channels: u16,
) -> std::time::Duration {
    if sample_rate == 0 || channels == 0 {
        return std::time::Duration::from_millis(0);
    }
    let frames = unread_samples as u64 / channels as u64;
    let micros = frames.saturating_mul(1_000_000) / sample_rate as u64;
    std::time::Duration::from_micros(micros)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PlaybackState, StateUpdate};
    use std::time::Duration;

    fn evt(ms: u64) -> ScheduledEvent {
        ScheduledEvent {
            fire_at: Instant::now() + Duration::from_millis(ms),
            update: StateUpdate::StateChanged(PlaybackState::Idle),
        }
    }

    #[test]
    fn schedule_sorts_events() {
        let mut s = EventScheduler::default();
        s.schedule(evt(200));
        s.schedule(evt(50));
        s.schedule(evt(100));
        let ts: Vec<_> = s.pending.iter().map(|e| e.fire_at).collect();
        assert!(ts[0] <= ts[1] && ts[1] <= ts[2]);
    }

    #[test]
    fn drain_ready_respects_time() {
        let mut s = EventScheduler::default();
        s.schedule(evt(0));
        s.schedule(evt(50));
        s.schedule(evt(500));
        let fired: Vec<_> = s
            .drain_ready(Instant::now() + Duration::from_millis(100))
            .collect();
        assert_eq!(fired.len(), 2);
        assert_eq!(s.pending.len(), 1);
    }

    #[test]
    fn drain_delay_math() {
        // 44100 samples * 2 channels = 88200 interleaved values per second
        let d = drain_delay(88200, 44100, 2);
        assert_eq!(d, Duration::from_secs(1));

        let d = drain_delay(44100, 44100, 2); // half a second
        assert_eq!(d.as_millis(), 500);

        let d = drain_delay(0, 44100, 2);
        assert_eq!(d.as_millis(), 0);
    }
}
