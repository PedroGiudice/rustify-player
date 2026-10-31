/* ============================================================
   views/Library.tsx — abas Faixas / Álbuns / Artistas / Curtidas /
   Playlists. Renderiza a sub-view ativa no lugar. Faixas, Álbuns e
   Artistas também abrem direto por /tracks, /albums, /artists.

   - Abas no padrão do WAI-ARIA (A36): uma parada do Tab, setas andam
     entre elas (lib/tabKeys.ts).
   - Curtidas (B8): `lib_list_liked`, a mais recente primeiro.
   - Playlists (B33): o campo `genre` do índice é a pasta de primeiro
     nível do acervo (A21); cada linha abre a playlist. Antes eram linhas
     mudas que repetiam a tela Playlists sem ação.
   ============================================================ */

import { createResource, createSignal, For, Show } from "solid-js";
import { libSnapshot, libListGenres, libGetAlbums, libGetArtists, libListLiked } from "../tauri";
import Tracks from "./Tracks";
import Albums from "./Albums";
import Artists from "./Artists";
import Liked, { LIKED_LIMIT } from "./Liked";
import { resetSelection } from "../store/selection";
import { navigate } from "../router";
import { EmptyState } from "../components/EmptyState";
import { Icon, ICONS } from "../components/Icon";
import { peek, settle, type Loaded } from "../lib/loaded";
import { plural } from "../lib/count";
import { fmtInt } from "../lib/format";
import { tabKeyHandler } from "../lib/tabKeys";

const TABS = ["tracks", "albums", "artists", "liked", "playlists"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  tracks: "Faixas",
  albums: "Álbuns",
  artists: "Artistas",
  liked: "Curtidas",
  playlists: "Playlists",
};
const tabId = (t: Tab) => `library-tab-${t}`;

const fmtN = fmtInt;

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
  const [likedRes, { refetch: refetchLiked }] = createResource(() => settle(libListLiked(LIKED_LIMIT)));
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
  const tabCount = (t: Tab): string | undefined => {
    switch (t) {
      case "tracks": return snap() ? fmtN(snap()!.tracks_total) : undefined;
      case "albums": return albumsCount();
      case "artists": return artistsCount();
      case "liked": return countOf(peek(likedRes));
      case "playlists": return meta() ? fmtN(meta()!.genres.length) : undefined;
    }
  };

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
              <span><b>{fmtInt(s().embeddings_done)}</b> embedded</span>
              <span><b>{fmtInt(s().tracks_total - s().embeddings_done)}</b> pending</span>
            </div>
          )}
        </Show>
      </header>

      <nav
        class="tabs lib-tabs"
        role="tablist"
        aria-label="Seções da biblioteca"
        onKeyDown={tabKeyHandler(TABS, tab, setTab, tabId)}
      >
        <For each={TABS}>
          {(t) => (
            <button
              role="tab"
              id={tabId(t)}
              aria-controls="library-panel"
              aria-selected={tab() === t}
              tabIndex={tab() === t ? 0 : -1}
              class={`tab${tab() === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {LABEL[t]} <Show when={tabCount(t)}>{(c) => <span class="tab__count">{c()}</span>}</Show>
            </button>
          )}
        </For>
      </nav>

      <div id="library-panel" class="lib-panel" role="tabpanel" aria-labelledby={tabId(tab())}>
        <Show when={tab() === "tracks"}><Tracks /></Show>
        <Show when={tab() === "albums"}><Albums list={() => peek(albumRes)} onRetry={() => void refetchAlbums()} /></Show>
        <Show when={tab() === "artists"}><Artists list={() => peek(artistRes)} onRetry={() => void refetchArtists()} /></Show>
        <Show when={tab() === "liked"}><Liked list={() => peek(likedRes)} onRetry={() => void refetchLiked()} /></Show>
        <Show when={tab() === "playlists"}>
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
                        <button
                          type="button"
                          class="row row--static row--open"
                          onClick={() => navigate(`/playlist/${encodeURIComponent(g.name)}`)}
                        >
                          <div class="row__meta">
                            <div class="row__title">{g.name}</div>
                            <div class="row__sub">{plural(g.track_count, "faixa", "faixas")}</div>
                          </div>
                          <Icon name={ICONS.chevronRight} size={16} class="row__go" />
                        </button>
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
