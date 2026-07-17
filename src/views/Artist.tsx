/* ============================================================
   views/Artist.tsx — Detail page for a single artist.
   Lists albums by this artist + their tracks.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libGetAlbums, libGetTracksByAlbum, coverUrl, type Album, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";

export default function ArtistView() {
  const name = () => route().param ? decodeURIComponent(route().param!) : null;

  const [albums] = createResource(name, async (n): Promise<Album[]> => {
    if (!n) return [];
    try { return (await libGetAlbums({ limit: 500 })).filter((a) => a.artist_name === n); }
    catch { return []; }
  });

  async function playAlbum(a: Album) {
    const tracks = await libGetTracksByAlbum(a.title);
    // scope "curated": album e uma unidade coerente do artista.
    if (tracks.length) { setQueue(tracks, 0, "curated", { kind: "album", name: a.title }); playTrack(tracks[0]); }
  }

  return (
    <article class="view">
      <header class="view__head">
        <div style={{ display: "flex", gap: "20px", "align-items": "flex-end" }}>
          <CoverArt
            seed={name() ?? "x"}
            size="lg"
            style={{ width: "120px", height: "120px", "border-radius": "50%" }}
          />
          <div>
            <h1>{name() ?? "Artist"}</h1>
            <p class="view__head-hint">{albums()?.length ?? 0} albums</p>
          </div>
        </div>
      </header>

      <div class="view__body">
        <section>
          <div class="section__head"><h2 class="section__title">Albums</h2></div>
          <div class="card-grid">
            <For each={albums() ?? []}>
              {(a) => (
                <div class="card" onClick={() => navigate(`/album/${encodeURIComponent(a.title)}`)}>
                  <CoverArt
                    seed={a.title}
                    src={coverUrl(a.cover_path)}
                    size="md"
                    class="card__cover"
                  >
                    <button class="card__play" type="button" onClick={(e) => { e.stopPropagation(); playAlbum(a); }}>
                      <Icon name={ICONS.play} size={12} />
                    </button>
                  </CoverArt>
                  <div class="card__title">{a.title}</div>
                  <div class="card__sub">{a.track_count} tracks{a.year ? ` · ${a.year}` : ""}</div>
                </div>
              )}
            </For>
          </div>
        </section>
      </div>
    </article>
  );
}
