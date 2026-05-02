/* ============================================================
   views/Playlists.tsx — Folder-based playlists + Liked Songs.
   Markup identico ao playlists.js vanilla (folder-list/folder-item).
   ============================================================ */

import { createResource, createSignal, Show, For } from "solid-js";
import { libListFolders, libListFolderTracks, libListLiked, coverUrl } from "../tauri";
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

export default function Playlists() {
  const [viewMode, setViewMode] = createSignal<"list" | "folder" | "liked">("list");
  const [currentFolder, setCurrentFolder] = createSignal("");
  const [detailTracks, setDetailTracks] = createSignal<Track[]>([]);
  const [detailTitle, setDetailTitle] = createSignal("");

  const [folders] = createResource(libListFolders);
  const [likedCount, setLikedCount] = createSignal(0);

  // Fetch liked count on load
  (async () => {
    try {
      const liked = await libListLiked();
      setLikedCount(liked.length);
    } catch {}
  })();

  async function openFolder(folder: string) {
    const label = folder === "" ? "Unsorted" : folder;
    setDetailTitle(label);
    try {
      const tracks = await libListFolderTracks(folder);
      setDetailTracks(tracks);
      setCurrentFolder(folder);
      setViewMode("folder");
    } catch (err) {
      console.error("[playlists] load folder failed:", err);
    }
  }

  async function openLiked() {
    setDetailTitle("Liked Songs");
    try {
      const tracks = await libListLiked();
      setDetailTracks(tracks);
      setViewMode("liked");
    } catch (err) {
      console.error("[playlists] load liked failed:", err);
    }
  }

  function goBack() {
    setViewMode("list");
    setDetailTracks([]);
  }

  function handleTrackClick(tracks: Track[], idx: number) {
    setQueue(tracks, idx);
    playTrack(tracks[idx]);
  }

  function handleContextMenu(e: MouseEvent, tracks: Track[], idx: number) {
    e.preventDefault();
    showTrackMenu(e, tracks[idx], tracks, idx);
  }

  function handleMoreClick(e: MouseEvent, tracks: Track[], idx: number) {
    e.stopPropagation();
    showTrackMenu(e, tracks[idx], tracks, idx);
  }

  return (
    <article class="view">
      {/* === List view === */}
      <Show when={viewMode() === "list"}>
        <header class="view__header">
          <h1 class="view__title">Playlists</h1>
          <Show when={folders()}>
            {(f) => {
              const total = f().reduce((s: number, p: any) => s + (p.track_count || 0), 0);
              return (
                <div class="view__stats">
                  <span class="view__stats-item">{f().length} folders</span>
                  <span class="view__stats-item">{total} tracks</span>
                </div>
              );
            }}
          </Show>
        </header>
        <div class="view__body">
          <Show when={folders()} fallback={
            <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
          }>
            {(list) => (
              <>
                {/* Liked Songs entry */}
                <Show when={likedCount() > 0}>
                  <button class="folder-item folder-item--liked" onClick={openLiked} type="button">
                    <span class="folder-item__name">
                      <svg class="icon icon--sm" aria-hidden="true" style="color:var(--primary)"><use href="#icon-flame" /></svg>
                      Liked Songs
                    </span>
                    <span class="folder-item__count">{likedCount()} tracks</span>
                  </button>
                </Show>

                {/* Folder list */}
                <div class="folder-list">
                  <For each={list()}>
                    {(pl: any) => {
                      const label = pl.name === "" ? "Unsorted" : pl.name;
                      return (
                        <button class="folder-item" onClick={() => openFolder(pl.name || "")} type="button">
                          <span class="folder-item__name">{label}</span>
                          <span class="folder-item__count">{pl.track_count} tracks</span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>

      {/* === Detail view (folder or liked) === */}
      <Show when={viewMode() !== "list"}>
        <header class="view__header">
          <h1 class="view__title">
            <button class="view__back" onClick={goBack} type="button" aria-label="Back to playlists">{"←"}</button>
            {detailTitle()}
          </h1>
          <div class="view__stats"><span class="view__stats-item">{detailTracks().length} tracks</span></div>
        </header>
        <div class="view__body">
          <Show when={detailTracks().length > 0} fallback={
            <div class="empty-state">
              <p class="empty-state__title">{viewMode() === "liked" ? "No liked tracks yet" : "No tracks in this folder"}</p>
              <Show when={viewMode() === "liked"}>
                <p class="empty-state__hint">Click the flame icon on a track to like it</p>
              </Show>
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
                <For each={detailTracks()}>
                  {(t, i) => (
                    <tr
                      class="track-row"
                      onClick={() => handleTrackClick(detailTracks(), i())}
                      onContextMenu={(e) => handleContextMenu(e, detailTracks(), i())}
                    >
                      <td class="track-table__td track-table__td--cover">
                        <Show when={t.album_cover_path}>
                          {(p) => <img src={coverUrl(p())!} loading="lazy" alt="" />}
                        </Show>
                      </td>
                      <td class="track-table__td track-table__td--num">{i() + 1}</td>
                      <td class="track-table__td track-table__td--title">{t.title}</td>
                      <td class="track-table__td">{t.artist_name || "—"}</td>
                      <td class="track-table__td">{t.album_title || "—"}</td>
                      <td class="track-table__td">{t.genre_name || "—"}</td>
                      <td class="track-table__td track-table__td--dur">{formatMs(t.duration_ms)}</td>
                      <td class="track-table__td track-table__td--more">
                        <button class="more-btn" aria-label="More" onClick={(e) => handleMoreClick(e, detailTracks(), i())}>
                          <svg class="icon icon--sm"><use href="#icon-more-vertical" /></svg>
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </Show>
    </article>
  );
}
