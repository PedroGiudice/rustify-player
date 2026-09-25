/* ============================================================
   views/Library.tsx — Tab nav for Tracks/Albums/Artists/Genres.
   Renders the active sub-view inline. Each tab is also addressable
   directly via /tracks, /albums, /artists routes if you want.
   ============================================================ */

import { createResource, createSignal, For, Show } from "solid-js";
import { libSnapshot, libListGenres, libGetAlbums, libGetArtists } from "../tauri";
import Tracks from "./Tracks";
import Albums from "./Albums";
import Artists from "./Artists";

type Tab = "tracks" | "albums" | "artists" | "genres";

export default function Library() {
  const [tab, setTab] = createSignal<Tab>("tracks");
  // O snapshot do indexer so tem tracks_total (IndexerSnapshot, types.rs):
  // albums/artists sao contados das listagens completas — o mesmo agrupamento
  // que as abas mostram. Falha vira null => "—", nunca numero inventado.
  // Cada listagem varre a colecao inteira no backend: busca UMA vez aqui e
  // as abas recebem a mesma lista em vez de refazer a varredura.
  const albumsP = libGetAlbums({ limit: null }).catch(() => null);
  const artistsP = libGetArtists({ limit: null }).catch(() => null);
  const [albumList] = createResource(() => albumsP);
  const [artistList] = createResource(() => artistsP);
  const [meta] = createResource(async () => {
    const [snap, genres, albums, artists] = await Promise.all([
      libSnapshot(),
      libListGenres().catch(() => []),
      albumsP,
      artistsP,
    ]);
    return {
      snap,
      genres: genres.filter((g: any) => g.track_count > 0),
      albumsTotal: albums?.length ?? null,
      artistsTotal: artists?.length ?? null,
    };
  });
  const fmtCount = (n: number | null) => (n == null ? "—" : n.toLocaleString());

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Library</h1>
          <p class="view__head-hint">
            <Show when={meta()} fallback="…">
              {(m) => (
                <>
                  {fmtCount(m().albumsTotal)} albums · {m().snap.tracks_total.toLocaleString()} tracks ·{" "}
                  {m().genres.length} genres
                </>
              )}
            </Show>
          </p>
        </div>
        <Show when={meta()}>
          {(m) => (
            <div class="view__stats">
              <span><b>{m().snap.embeddings_done.toLocaleString()}</b> embedded</span>
              <span><b>{(m().snap.tracks_total - m().snap.embeddings_done).toLocaleString()}</b> pending</span>
            </div>
          )}
        </Show>
      </header>

      {/* Padrão de abas do WAI-ARIA: o estado ativo existia só na classe
          .active, e o leitor anunciava botões soltos numa lista de abas vazia. */}
      <nav class="tabs" role="tablist">
        <button role="tab" id="library-tab-tracks" aria-controls="library-panel" aria-selected={tab() === "tracks"} class={`tab${tab() === "tracks" ? " active" : ""}`} onClick={() => setTab("tracks")}>
          Tracks <Show when={meta()}><span class="tab__count">{meta()!.snap.tracks_total.toLocaleString()}</span></Show>
        </button>
        <button role="tab" id="library-tab-albums" aria-controls="library-panel" aria-selected={tab() === "albums"} class={`tab${tab() === "albums" ? " active" : ""}`} onClick={() => setTab("albums")}>
          Albums <Show when={meta()}><span class="tab__count">{fmtCount(meta()!.albumsTotal)}</span></Show>
        </button>
        <button role="tab" id="library-tab-artists" aria-controls="library-panel" aria-selected={tab() === "artists"} class={`tab${tab() === "artists" ? " active" : ""}`} onClick={() => setTab("artists")}>
          Artists <Show when={meta()}><span class="tab__count">{fmtCount(meta()!.artistsTotal)}</span></Show>
        </button>
        <button role="tab" id="library-tab-genres" aria-controls="library-panel" aria-selected={tab() === "genres"} class={`tab${tab() === "genres" ? " active" : ""}`} onClick={() => setTab("genres")}>
          Genres <Show when={meta()}><span class="tab__count">{meta()!.genres.length}</span></Show>
        </button>
      </nav>

      <div id="library-panel" role="tabpanel" aria-labelledby={`library-tab-${tab()}`}>
        <Show when={tab() === "tracks"}><Tracks /></Show>
        <Show when={tab() === "albums"}><Albums list={() => albumList() ?? undefined} /></Show>
        <Show when={tab() === "artists"}><Artists list={() => artistList() ?? undefined} /></Show>
        <Show when={tab() === "genres"}>
          <div class="view__body">
            <For each={meta()?.genres ?? []}>
              {(g: any) => (
                <div class="row row--static">
                  <div class="row__meta">
                    <div class="row__title">{g.name}</div>
                    <div class="row__sub">{g.track_count} tracks</div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </article>
  );
}
