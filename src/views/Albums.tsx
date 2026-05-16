/* ============================================================
   views/Albums.tsx — Grid of all albums, click to play.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libGetAlbums, libGetTracksByAlbum, coverUrl, type Album } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";

export default function Albums() {
  const [albums] = createResource(async () => {
    try { return await libGetAlbums({ limit: 300 }); } catch { return [] as Album[]; }
  });

  async function play(album: Album) {
    const tracks = await libGetTracksByAlbum(album.title);
    if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
  }

  const standalone = () => route().path === "/albums";

  return (
    <>
      <Show when={standalone()}>
        <header class="view__head">
          <div><h1>Albums</h1></div>
        </header>
      </Show>

      <div class="view__body">
        <div class="card-grid">
          <For each={albums() ?? []}>
            {(a) => (
              <div class="card" onClick={() => play(a)}>
                <CoverArt
                  seed={a.title}
                  src={coverUrl(a.cover_path)}
                  size="md"
                  class="card__cover"
                >
                  <button class="card__play" type="button"><Icon name={ICONS.play} size={12} /></button>
                </CoverArt>
                <div class="card__title">{a.title}</div>
                <div class="card__sub">{a.artist_name ?? "—"}</div>
                <div class="card__meta">{a.track_count} tracks{a.year ? ` · ${a.year}` : ""}</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  );
}
