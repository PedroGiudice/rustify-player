/* ============================================================
   views/Albums.tsx — Grid de albums (card-grid).
   Markup identico ao albums.js vanilla.
   ============================================================ */

import { createResource, Show, For } from "solid-js";
import { libGetAlbums, libGetTracksByAlbum, coverUrl } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import type { Album } from "../tauri";

function initials(name: string): string {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

export default function Albums() {
  const [albums] = createResource(() => libGetAlbums(500));

  async function playAlbum(albumId: number) {
    const tracks = await libGetTracksByAlbum(albumId);
    if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
  }

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Albums</h1>
        <Show when={albums()}>
          {(a) => <div class="view__stats"><span>{a().length} albums</span></div>}
        </Show>
      </header>

      <div class="view__body">
        <Show when={albums()} fallback={<p class="empty-state__hint">Loading...</p>}>
          {(list) => (
            <Show when={list().length > 0} fallback={
              <div class="empty-state"><p class="empty-state__title">No albums yet</p></div>
            }>
              <div class="card-grid">
                <For each={list()}>
                  {(a) => (
                    <div class="card" onClick={() => navigate(`/album/${a.id}`)}>
                      <div class={`card__cover${a.cover_path ? "" : " card__cover--initials"}`}>
                        <Show when={a.cover_path} fallback={<span>{initials(a.title)}</span>}>
                          {(p) => <img src={coverUrl(p())!} alt="" />}
                        </Show>
                        <button class="card__cover-play" onClick={(e) => { e.stopPropagation(); playAlbum(a.id); }} aria-label="Play album">
                          <svg class="icon icon--filled" aria-hidden="true"><use href="#icon-play" /></svg>
                        </button>
                      </div>
                      <div class="card__label">{a.title}</div>
                      <div class="card__sub">{a.album_artist_name || a.artist_name || "—"}{a.year ? ` • ${a.year}` : ""}</div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </article>
  );
}
