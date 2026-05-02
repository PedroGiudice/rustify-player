/* ============================================================
   views/Tracks.tsx — Tabela de todas as tracks.
   Markup identico ao tracks.js vanilla.
   ============================================================ */

import { createResource, Show, For } from "solid-js";
import { libGetTracks, coverUrl } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { showTrackMenu } from "../js/components/context-menu.js";
import type { Track } from "../tauri";

function formatMs(ms: number | null): string {
  if (!ms) return "—";
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Tracks() {
  const [tracks] = createResource(() => libGetTracks());

  function handleClick(list: Track[], idx: number) {
    setQueue(list, idx);
    playTrack(list[idx]);
  }

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Tracks</h1>
        <Show when={tracks()}>
          {(t) => <div class="view__stats"><span class="view__stats-item">{t().length} tracks</span></div>}
        </Show>
      </header>

      <div class="view__body">
        <Show when={tracks()} fallback={
          <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
        }>
          {(list) => (
            <Show when={list().length > 0} fallback={
              <div class="empty-state">
                <p class="empty-state__title">No tracks indexed</p>
                <p class="empty-state__hint">Point to a music folder in Settings</p>
              </div>
            }>
              <table class="track-table">
                <thead>
                  <tr>
                    <th class="track-table__th track-table__th--cover"></th>
                    <th class="track-table__th track-table__th--num">#</th>
                    <th class="track-table__th">Title</th>
                    <th class="track-table__th">Artist</th>
                    <th class="track-table__th">Album</th>
                    <th class="track-table__th">Genre</th>
                    <th class="track-table__th track-table__th--dur">Duration</th>
                    <th class="track-table__th track-table__th--more"></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={list()}>
                    {(t, i) => (
                      <tr
                        class="track-row"
                        onClick={() => handleClick(list(), i())}
                        onContextMenu={(e) => { e.preventDefault(); showTrackMenu(e, t, list(), i()); }}
                      >
                        <td class="track-table__td track-table__td--cover">
                          <Show when={t.album_cover_path}>
                            {(p) => <img src={coverUrl(p())!} loading="lazy" alt="" />}
                          </Show>
                        </td>
                        <td class="track-table__td track-table__td--num">{t.track_number ?? i() + 1}</td>
                        <td class="track-table__td track-table__td--title">{t.title}</td>
                        <td class="track-table__td">{t.artist_name || "—"}</td>
                        <td class="track-table__td">{t.album_title || "—"}</td>
                        <td class="track-table__td">{t.genre_name || "—"}</td>
                        <td class="track-table__td track-table__td--dur">{formatMs(t.duration_ms)}</td>
                        <td class="track-table__td track-table__td--more">
                          <button class="more-btn" aria-label="More" onClick={(e) => { e.stopPropagation(); showTrackMenu(e, t, list(), i()); }}>
                            <svg class="icon icon--sm"><use href="#icon-more-vertical" /></svg>
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          )}
        </Show>
      </div>
    </article>
  );
}
