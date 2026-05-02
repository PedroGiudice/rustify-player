/* ============================================================
   views/Library.tsx — Local Library com genre chips + track table.
   Markup identico ao library.js vanilla.
   ============================================================ */

import { createResource, createSignal, Show, For } from "solid-js";
import { libGetTracks, libSnapshot, libListGenres, coverUrl } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import type { Track } from "../tauri";

function formatMs(ms: number | null): string {
  if (!ms) return "—";
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Library() {
  const [data] = createResource(async () => {
    const [snapshot, genres, tracks] = await Promise.all([
      libSnapshot(),
      libListGenres(),
      libGetTracks({ limit: 200 }),
    ]);
    return { snapshot, genres, tracks };
  });

  const [filteredTracks, setFilteredTracks] = createSignal<Track[] | null>(null);
  const [activeGenre, setActiveGenre] = createSignal<number | null>(null);

  async function toggleGenre(genreId: number) {
    if (activeGenre() === genreId) {
      setActiveGenre(null);
      setFilteredTracks(null);
    } else {
      setActiveGenre(genreId);
      const filtered = await libGetTracks({ genreId, limit: 200 });
      setFilteredTracks(filtered);
    }
  }

  const displayTracks = () => filteredTracks() ?? data()?.tracks ?? [];

  function handleTrackClick(idx: number) {
    const tracks = displayTracks();
    if (idx >= 0 && idx < tracks.length) {
      setQueue(tracks, idx);
      playTrack(tracks[idx]);
    }
  }

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Local Library</h1>
        <Show when={data()}>
          {(d) => {
            const populated = d().genres.filter((g: any) => g.track_count > 0);
            return (
              <div class="view__stats">
                <span class="view__stats-item">{d().snapshot.tracks_total} tracks</span>
                <span class="view__stats-sep">{"•"}</span>
                <span class="view__stats-item">{populated.length} genres</span>
                <Show when={d().snapshot.embeddings_done > 0}>
                  <span class="view__stats-sep">{"•"}</span>
                  <span class="view__stats-item">{d().snapshot.embeddings_done} embeddings</span>
                </Show>
              </div>
            );
          }}
        </Show>
      </header>

      <div class="view__body">
        <Show when={data()} fallback={
          <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
        }>
          {(d) => {
            const populated = d().genres.filter((g: any) => g.track_count > 0);
            return (
              <Show when={d().tracks.length > 0} fallback={
                <div class="empty-state">
                  <p class="empty-state__title">No tracks indexed yet</p>
                  <p class="empty-state__hint">Point to a music folder in Settings</p>
                </div>
              }>
                {/* Genre chips */}
                <Show when={populated.length > 0}>
                  <div class="genre-chips">
                    <For each={populated}>
                      {(g: any) => (
                        <button
                          class={`chip${activeGenre() === g.id ? " chip--active" : ""}`}
                          onClick={() => toggleGenre(g.id)}
                        >
                          {g.name} ({g.track_count})
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Track table */}
                <table class="track-table">
                  <thead>
                    <tr>
                      <th class="track-table__th track-table__th--num">#</th>
                      <th class="track-table__th">Title</th>
                      <th class="track-table__th">Artist</th>
                      <th class="track-table__th">Album</th>
                      <th class="track-table__th track-table__th--dur">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={displayTracks()}>
                      {(track, i) => (
                        <tr
                          class="track-row"
                          onDblClick={() => handleTrackClick(i())}
                        >
                          <td class="track-table__td track-table__td--num">{i() + 1}</td>
                          <td class="track-table__td track-table__td--title">{track.title}</td>
                          <td class="track-table__td">{track.artist_name || "—"}</td>
                          <td class="track-table__td">{track.album_title || "—"}</td>
                          <td class="track-table__td track-table__td--dur">{formatMs(track.duration_ms)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            );
          }}
        </Show>
      </div>
    </article>
  );
}
