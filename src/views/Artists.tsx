/* ============================================================
   views/Artists.tsx — List of all artists with counts.
   ============================================================ */

import { createResource, For, Show, type Accessor } from "solid-js";
import { libGetArtists, type Artist } from "../tauri";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";

/** `list`: listagem já buscada pela Library (que a usa na contagem da
    aba). Sem ela — rota /artists direta — a view busca a própria. */
export default function Artists(props: { param?: string; list?: Accessor<Artist[] | undefined> }) {
  const artists: Accessor<Artist[] | undefined> = props.list ?? createResource(async () => {
    try { return await libGetArtists({ limit: null }); } catch { return [] as Artist[]; }
  })[0];
  // Aberta direto (/artists) a view traz o proprio .view — o unico
  // container que rola (.main tem overflow:hidden). Como aba, a Library
  // ja fornece o dela.
  const standalone = () => route().path === "/artists";

  const body = () => (
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
  );

  return (
    <Show when={standalone()} fallback={body()}>
      <article class="view">
        <header class="view__head"><div><h1>Artists</h1></div></header>
        {body()}
      </article>
    </Show>
  );
}
