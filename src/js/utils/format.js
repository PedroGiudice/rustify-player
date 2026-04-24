// Shared formatting helpers.
//
// Keep these tiny and purely functional — the whole app imports from here,
// so any heavy logic would inflate every view.

/**
 * Format a duration in milliseconds as `M:SS`.
 * Returns "—" for 0, null, undefined, NaN.
 *
 * The app stores durations as ms (matching the backend `duration_ms`
 * serialization). The player-bar keeps an internal seconds-based state
 * for alignment with engine PositionTick events and manages its own
 * conversion at the boundary — it does NOT use this helper.
 */
export function formatMs(ms) {
  if (!ms) return "—";
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
