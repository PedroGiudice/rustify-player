/* ============================================================
   views/Artists.tsx — Grade de todos os artistas.

   O card abre pelo teclado (A18): abrir é o nome
   (<button class="card__open">), cujo ::after cobre o card inteiro,
   mesmo padrão de Álbuns e Playlists. Antes era <div onClick> e o Tab
   passava direto.
   ============================================================ */

import { createResource, For, Show, Switch, Match, type Accessor } from "solid-js";
import { libGetArtists, type Artist } from "../tauri";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { EmptyState } from "../components/EmptyState";
import { ICONS } from "../components/Icon";
import { dataOf, listState, peek, settle, type Loaded } from "../lib/loaded";
import { truncTipEvent } from "../lib/truncTip";

/** `list`: listagem já buscada pela Library (que a usa na contagem da
    aba), com `onRetry` para refazê-la. Sem ela — rota /artists direta — a
    view busca a própria. */
export default function Artists(props: {
  param?: string;
  list?: Accessor<Loaded<Artist[]> | undefined>;
  onRetry?: () => void;
}) {
  let retry = () => props.onRetry?.();
  let result: Accessor<Loaded<Artist[]> | undefined>;
  if (props.list) {
    result = props.list;
  } else {
    const [r, { refetch }] = createResource(() => settle(libGetArtists({ limit: null })));
    result = () => peek(r);
    retry = () => void refetch();
  }
  const artists = () => dataOf(result());
  // Aberta direto (/artists) a view traz o proprio .view — o unico
  // container que rola (.main tem overflow:hidden). Como aba, a Library
  // ja fornece o dela.
  const standalone = () => route().path === "/artists";

  const body = () => (
    <div class="view__body">
      <Switch>
        <Match when={listState(result()) === "carregando"}>
          <EmptyState tone="carregando" title="Carregando o acervo…" />
        </Match>
        <Match when={listState(result()) === "erro"}>
          <EmptyState
            tone="erro"
            title="Não consegui ler o acervo agora."
            text="O índice não respondeu. As faixas continuam no disco."
            actions={[{ label: "Tentar de novo", onClick: retry, icon: ICONS.refresh }]}
          />
        </Match>
        <Match when={listState(result()) === "vazio"}>
          <EmptyState
            icon={ICONS.artists}
            title="Nenhum artista no acervo."
            text="Os artistas saem da tag de artista das faixas em ~/Music."
          />
        </Match>
        <Match when={listState(result()) === "pronto"}>
          <div class="card-grid">
            <For each={artists()}>
              {(a) => (
                <div class="card" onPointerEnter={truncTipEvent}>
                  <CoverArt
                    seed={a.name}
                    size="md"
                    class="card__cover"
                    style={{ "border-radius": "50%" }}
                  />
                  <button
                    type="button"
                    class="card__title card__open"
                    data-trunc
                    onClick={() => navigate(`/artist/${encodeURIComponent(a.name)}`)}
                    onFocus={truncTipEvent}
                  >
                    {a.name}
                  </button>
                  <div class="card__sub">{a.album_count} albums · {a.track_count} tracks</div>
                </div>
              )}
            </For>
          </div>
        </Match>
      </Switch>
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
