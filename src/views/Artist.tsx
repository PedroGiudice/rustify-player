/* ============================================================
   views/Artist.tsx — Detalhe de artista (hero + discography grid).
   Markup identico ao artist.js vanilla.
   ============================================================ */

import { createResource, Show, For } from "solid-js";
import { libGetArtist, libGetAlbumsByArtist, libGetTracksByAlbum, coverUrl } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import type { Album } from "../tauri";

interface Props { param?: string | null; }

function initials(name: string): string {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

export default function Artist(props: Props) {
  const artistId = () => props.param ? Number(props.param) : null;
  const [artist] = createResource(artistId, (id) => libGetArtist(id));
  const [albums] = createResource(artistId, (id) => libGetAlbumsByArtist(id));

  async function playAlbum(albumId: number) {
    const tracks = await libGetTracksByAlbum(albumId);
    if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
  }

  return (
    <article class="view view--hero">
      <Show when={artist()} fallback={
        <div class="artist-detail"><p class="empty-state__hint">Loading...</p></div>
      }>
        {(a) => (
          <div class="artist-detail">
            <div class="artist-detail__hero">
              <button class="view__back" onClick={() => navigate("/artists")} aria-label="Back">
                <svg class="icon" aria-hidden="true"><use href="#icon-arrow-left" /></svg>
              </button>
              <div class="artist-detail__eyebrow">Artist</div>
              <h1 class="artist-detail__name">{a().name}</h1>
              <div class="artist-detail__stats">
                <span>{albums()?.length ?? 0} albums</span>
              </div>
            </div>

            <Show when={albums()?.length}>
              <section class="home-section">
                <h2 class="home-section__title">Discography</h2>
                <div class="card-grid">
                  <For each={albums()!}>
                    {(album) => (
                      <div class="card" onClick={() => navigate(`/album/${album.id}`)}>
                        <div class={`card__cover${album.cover_path ? "" : " card__cover--initials"}`}>
                          <Show when={album.cover_path} fallback={<span>{initials(album.title)}</span>}>
                            {(p) => <img src={coverUrl(p())!} alt="" />}
                          </Show>
                          <button class="card__cover-play" onClick={(e) => { e.stopPropagation(); playAlbum(album.id); }} aria-label="Play">
                            <svg class="icon icon--filled" aria-hidden="true"><use href="#icon-play" /></svg>
                          </button>
                        </div>
                        <div class="card__label">{album.title}</div>
                        <div class="card__sub">{album.year || "—"}</div>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </article>
  );
}
