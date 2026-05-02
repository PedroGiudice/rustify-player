/* ============================================================
   views/History.tsx — Historico de reproducao.
   Markup identico ao history.js vanilla.
   ============================================================ */

import { createResource, Show, For } from "solid-js";
import { libListHistory, coverUrl } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { showTrackMenu } from "../js/components/context-menu.js";
import type { Track } from "../tauri";

function formatAgo(unixTs: number | null): string {
  if (!unixTs) return "—";
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function History() {
  const [tracks] = createResource(() => libListHistory(100));

  function handleClick(list: Track[], idx: number) {
    setQueue(list, idx);
    playTrack(list[idx]);
  }

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">History</h1>
        <Show when={tracks()}>
          {(t) => <div class="view__stats"><span class="view__stats-item">{t().length} played</span></div>}
        </Show>
      </header>

      <div class="view__body">
        <Show when={tracks()} fallback={
          <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
        }>
          {(list) => (
            <Show when={list().length > 0} fallback={
              <div class="empty-state">
                <p class="empty-state__title">No playback history yet</p>
                <p class="empty-state__hint">Play some tracks and they'll appear here</p>
              </div>
            }>
              <table class="track-table">
                <thead>
                  <tr>
                    <th class="track-table__th track-table__th--cover"></th>
                    <th class="track-table__th">Title</th>
                    <th class="track-table__th">Artist</th>
                    <th class="track-table__th">Album</th>
                    <th class="track-table__th track-table__th--dur">Played</th>
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
                        <td class="track-table__td track-table__td--title">{t.title}</td>
                        <td class="track-table__td">{t.artist_name || "—"}</td>
                        <td class="track-table__td">{t.album_title || "—"}</td>
                        <td class="track-table__td track-table__td--dur">{formatAgo(t.last_played ?? null)}</td>
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
