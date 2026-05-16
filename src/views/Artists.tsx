/* ============================================================
   views/Artists.tsx — List of all artists with counts.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libGetArtists, type Artist } from "../tauri";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";

export default function Artists() {
  const [artists] = createResource(async () => {
    try { return await libGetArtists({ limit: 500 }); } catch { return [] as Artist[]; }
  });
  const standalone = () => route().path === "/artists";

  return (
    <>
      <Show when={standalone()}>
        <header class="view__head"><div><h1>Artists</h1></div></header>
      </Show>

      <div class="view__body">
        <div class="card-grid">
          <For each={artists() ?? []}>
            {(a) => (
              <div class="card" onClick={() => navigate(`/artist/${encodeURIComponent(a.name)}`)}>
                <CoverArt
                  seed={a.name}
                  size="md"
                  class="card__cover"
                  style={{ "border-radius": "50%" }}
                />
                <div class="card__title">{a.name}</div>
                <div class="card__sub">{a.album_count} albums · {a.track_count} tracks</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  );
}
