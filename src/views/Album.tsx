/* ============================================================
   views/Album.tsx — Detalhe de album (hero + track table).
   Markup identico ao album.js vanilla.
   ============================================================ */

import { createResource, createSignal, Show, For } from "solid-js";
import { libGetAlbum, libGetTracksByAlbum, coverUrl, formatDuration } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import { showTrackMenu } from "../js/components/context-menu.js";
import type { Track, Album as AlbumType } from "../tauri";

interface Props { param?: string | null; }

function formatMs(ms: number | null): string {
  if (!ms) return "—";
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function initials(name: string): string {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

export default function Album(props: Props) {
  const albumId = () => props.param ? Number(props.param) : null;
  const [album] = createResource(albumId, (id) => libGetAlbum(id));
  const [tracks] = createResource(albumId, (id) => libGetTracksByAlbum(id));

  const totalDur = () => {
    const t = tracks();
    if (!t) return "";
    const ms = t.reduce((s, tr) => s + (tr.duration_ms || 0), 0);
    return `${Math.floor(ms / 60000)}m`;
  };

  function playAll() {
    const t = tracks();
    if (t?.length) { setQueue(t, 0); playTrack(t[0]); }
  }

  function shuffleAll() {
    const t = tracks();
    if (!t?.length) return;
    const shuffled = [...t].sort(() => Math.random() - 0.5);
    setQueue(shuffled, 0);
    playTrack(shuffled[0]);
  }

  function handleRowClick(t: Track[], idx: number) {
    setQueue(t, idx);
    playTrack(t[idx]);
  }

  return (
    <article class="view view--hero">
      <Show when={album()} fallback={
        <div class="album-detail"><p class="empty-state__hint">Loading...</p></div>
      }>
        {(a) => (
          <div class="album-detail">
            <div class="album-detail__hero">
              <div class="album-detail__cover">
                <Show when={a().cover_path} fallback={
                  <span style="font-size:var(--text-display-lg);font-weight:var(--fw-bold);color:var(--primary)">{initials(a().title)}</span>
                }>
                  {(p) => <img src={coverUrl(p())!} alt={a().title} />}
                </Show>
              </div>
              <div class="album-detail__meta">
                <button class="view__back" onClick={() => navigate("/albums")} aria-label="Back">
                  <svg class="icon" aria-hidden="true"><use href="#icon-arrow-left" /></svg>
                </button>
                <div class="album-detail__eyebrow">Album{a().year ? ` • ${a().year}` : ""}</div>
                <h1 class="album-detail__title">{a().title}</h1>
                <div class="album-detail__artist" onClick={() => {
                  if (a().artist_id) navigate(`/artist/${a().artist_id}`);
                }}>{a().album_artist_name || a().artist_name || "—"}</div>
                <div class="album-detail__stats">
                  <span>{tracks()?.length ?? 0} tracks</span>
                  <span class="view__stats-sep">{"•"}</span>
                  <span>{totalDur()}</span>
                </div>
                <div class="album-detail__actions">
                  <button class="settings-button settings-button--primary" onClick={playAll}>
                    <svg class="icon icon--sm icon--filled" aria-hidden="true"><use href="#icon-play" /></svg>
                    Play
                  </button>
                  <button class="settings-button" onClick={shuffleAll}>
                    <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-shuffle" /></svg>
                    Shuffle
                  </button>
                </div>
              </div>
            </div>

            <Show when={tracks()}>
              {(list) => (
                <table class="track-table">
                  <thead><tr>
                    <th class="track-table__th track-table__th--num">#</th>
                    <th class="track-table__th">Title</th>
                    <th class="track-table__th track-table__th--dur">Dur</th>
                    <th class="track-table__th track-table__th--more"></th>
                  </tr></thead>
                  <tbody>
                    <For each={list()}>
                      {(track, i) => (
                        <tr
                          class="track-row"
                          onClick={() => handleRowClick(list(), i())}
                          onContextMenu={(e) => { e.preventDefault(); showTrackMenu(e, track, list(), i()); }}
                        >
                          <td class="track-table__td track-table__td--num">{track.track_number || i() + 1}</td>
                          <td class="track-table__td track-table__td--title">{track.title || "—"}</td>
                          <td class="track-table__td track-table__td--dur">{formatMs(track.duration_ms)}</td>
                          <td class="track-table__td track-table__td--more">
                            <button class="more-btn" aria-label="More" onClick={(e) => { e.stopPropagation(); showTrackMenu(e, track, list(), i()); }}>
                              <svg class="icon icon--sm"><use href="#icon-more-vertical" /></svg>
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              )}
            </Show>
          </div>
        )}
      </Show>
    </article>
  );
}
