/* ============================================================
   views/Queue.tsx — Fila de reproducao.
   Markup identico ao queue.js vanilla (queue-list / queue-row).
   ============================================================ */

import { Show, For } from "solid-js";
import { player, setPlayer } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { formatDuration } from "../tauri";

function formatMs(ms: number | null): string {
  if (!ms) return "—";
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Queue() {
  function handlePlay(idx: number) {
    const track = player.queue[idx];
    if (!track) return;
    setPlayer({ queueIndex: idx, currentTrack: track });
    playTrack(track);
  }

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Queue</h1>
        <div class="view__stats"><span>{player.queue.length} in queue</span></div>
      </header>

      <div class="view__body">
        <Show when={player.queue.length > 0} fallback={
          <div class="empty-state">
            <svg class="empty-state__icon" aria-hidden="true"><use href="#icon-queue-music" /></svg>
            <p class="empty-state__title">Queue is empty</p>
            <p class="empty-state__hint">Play an album or track to build a queue</p>
          </div>
        }>
          <div class="queue-list">
            <For each={player.queue}>
              {(track, i) => (
                <div
                  class={`queue-row${player.queueIndex === i() ? " is-current" : ""}`}
                  onClick={() => handlePlay(i())}
                >
                  <div class="queue-row__handle">
                    <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-drag" /></svg>
                  </div>
                  <div class="queue-row__meta">
                    <div class="queue-row__title">{track.title || "—"}</div>
                    <div class="queue-row__sub">{track.artist_name || "—"} {"•"} {track.album_title || ""}</div>
                  </div>
                  <div class="queue-row__dur">{formatMs(track.duration_ms)}</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </article>
  );
}
