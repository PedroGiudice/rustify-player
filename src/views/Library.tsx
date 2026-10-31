/* ============================================================
   views/Library.tsx — Tab nav for Tracks/Albums/Artists/Playlists.
   Renders the active sub-view inline. Each tab is also addressable
   directly via /tracks, /albums, /artists routes if you want.

   A quarta aba se chamava "Genres", mas o campo `genre` do índice é a
   pasta de primeiro nível do acervo: é a lista das playlists (A21).
   ============================================================ */

import { createResource, createSignal, For, Show } from "solid-js";
import { libSnapshot, libListGenres, libGetAlbums, libGetArtists } from "../tauri";
import Tracks from "./Tracks";
import Albums from "./Albums";
import Artists from "./Artists";
import { resetSelection } from "../store/selection";
import { EmptyState } from "../components/EmptyState";
import { peek, settle, type Loaded } from "../lib/loaded";

type Tab = "tracks" | "albums" | "artists" | "genres";

const fmtN = (n: number) => n.toLocaleString();

export default function Library() {
  const [tab, setTabRaw] = createSignal<Tab>("tracks");
  // Aba nova = lista nova: a seleção de faixas não atravessa a troca.
  const setTab = (t: Tab) => { if (t !== tab()) resetSelection(); setTabRaw(t); };
  // O snapshot do indexer so tem tracks_total (IndexerSnapshot, types.rs):
  // albums/artists sao contados das listagens completas — o mesmo agrupamento
  // que as abas mostram. Falha vira "—", nunca numero inventado.
  // Cada listagem varre a colecao inteira no backend: busca UMA vez aqui e
  // as abas recebem a mesma lista em vez de refazer a varredura.
  const [albumRes, { refetch: refetchAlbums }] = createResource(() => settle(libGetAlbums({ limit: null })));
  const [artistRes, { refetch: refetchArtists }] = createResource(() => settle(libGetArtists({ limit: null })));
  const [metaRes] = createResource(async () => {
    const [snap, genres] = await Promise.all([libSnapshot().catch(() => null), libListGenres().catch(() => [])]);
    return { snap, genres: genres.filter((g: any) => g.track_count > 0) };
  });
  const meta = () => peek(metaRes);
  const snap = () => meta()?.snap ?? null;

  /** Contagem de uma listagem: undefined enquanto carrega, "—" se falhou. */
  const countOf = (r: Loaded<unknown[]> | undefined) =>
    r === undefined ? undefined : r.ok ? fmtN(r.data.length) : "—";
  const albumsCount = () => countOf(peek(albumRes));
  const artistsCount = () => countOf(peek(artistRes));

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Library</h1>
          <p class="view__head-hint">
            <Show when={meta()} fallback="…">
              {(m) => (
                <>
                  {albumsCount() ?? "…"} albums · {snap() ? fmtN(snap()!.tracks_total) : "—"} tracks ·{" "}
                  {m().genres.length} playlists
                </>
              )}
            </Show>
          </p>
        </div>
        <Show when={snap()}>
          {(s) => (
            <div class="view__stats">
              <span><b>{s().embeddings_done.toLocaleString()}</b> embedded</span>
              <span><b>{(s().tracks_total - s().embeddings_done).toLocaleString()}</b> pending</span>
            </div>
          )}
        </Show>
      </header>

      {/* Padrão de abas do WAI-ARIA: o estado ativo existia só na classe
          .active, e o leitor anunciava botões soltos numa lista de abas vazia. */}
      <nav class="tabs lib-tabs" role="tablist">
        <button role="tab" id="library-tab-tracks" aria-controls="library-panel" aria-selected={tab() === "tracks"} class={`tab${tab() === "tracks" ? " active" : ""}`} onClick={() => setTab("tracks")}>
          Tracks <Show when={snap()}><span class="tab__count">{fmtN(snap()!.tracks_total)}</span></Show>
        </button>
        <button role="tab" id="library-tab-albums" aria-controls="library-panel" aria-selected={tab() === "albums"} class={`tab${tab() === "albums" ? " active" : ""}`} onClick={() => setTab("albums")}>
          Albums <Show when={albumsCount()}><span class="tab__count">{albumsCount()}</span></Show>
        </button>
        <button role="tab" id="library-tab-artists" aria-controls="library-panel" aria-selected={tab() === "artists"} class={`tab${tab() === "artists" ? " active" : ""}`} onClick={() => setTab("artists")}>
          Artists <Show when={artistsCount()}><span class="tab__count">{artistsCount()}</span></Show>
        </button>
        <button role="tab" id="library-tab-genres" aria-controls="library-panel" aria-selected={tab() === "genres"} class={`tab${tab() === "genres" ? " active" : ""}`} onClick={() => setTab("genres")}>
          Playlists <Show when={meta()}><span class="tab__count">{meta()!.genres.length}</span></Show>
        </button>
      </nav>

      <div id="library-panel" class="lib-panel" role="tabpanel" aria-labelledby={`library-tab-${tab()}`}>
        <Show when={tab() === "tracks"}><Tracks /></Show>
        <Show when={tab() === "albums"}><Albums list={() => peek(albumRes)} onRetry={() => void refetchAlbums()} /></Show>
        <Show when={tab() === "artists"}><Artists list={() => peek(artistRes)} onRetry={() => void refetchArtists()} /></Show>
        <Show when={tab() === "genres"}>
          <div class="view__body">
            <Show
              when={meta()}
              fallback={<EmptyState tone="carregando" title="Carregando o acervo…" />}
            >
              {(m) => (
                <Show
                  when={m().genres.length > 0}
                  fallback={
                    <EmptyState
                      title="Nenhuma playlist ainda."
                      text="Cada pasta de primeiro nível em ~/Music vira uma playlist."
                    />
                  }
                >
                  <div class="row-list lib-folders">
                    <For each={m().genres}>
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
              )}
            </Show>
          </div>
        </Show>
      </div>
    </article>
  );
}
