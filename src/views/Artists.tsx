/* ============================================================
   views/Artists.tsx — Grade de todos os artistas.

   O card abre pelo teclado (A18): abrir é o nome
   (<button class="card__open">), cujo ::after cobre o card inteiro,
   mesmo padrão de Álbuns e Playlists. Antes era <div onClick> e o Tab
   passava direto.

   Rosto (B3): a capa do álbum do artista com mais faixas, que o backend
   escolhe (query.rs aggregate_artists); sem capa nenhuma, o cassete.
   Filtro por nome acima da grade.
   ============================================================ */

import { createMemo, createResource, createSignal, For, Show, Switch, Match, type Accessor } from "solid-js";
import { libGetArtists, coverUrl, type Artist } from "../tauri";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { EmptyState } from "../components/EmptyState";
import { ICONS } from "../components/Icon";
import { dataOf, listState, peek, settle, type Loaded } from "../lib/loaded";
import { truncTipEvent } from "../lib/truncTip";
import { filterByText } from "../lib/gridFilter";
import { plural } from "../lib/count";
import { FilterField } from "../components/FilterField";

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
  // Filtro por nome (B3), sem acento.
  const [filter, setFilter] = createSignal("");
  const visible = createMemo(() => filterByText(artists(), filter(), (a) => a.name));
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
          <div class="lib-grid">
            <FilterField
              value={filter()}
              onInput={setFilter}
              label="Filtrar artistas"
              placeholder="Filtrar por nome…"
              status={filter().trim() ? `${visible().length.toLocaleString("pt-BR")} de ${artists().length.toLocaleString("pt-BR")}` : undefined}
            />
            <Show when={visible().length === 0}>
              <EmptyState
                compact
                title={`Nenhum artista com "${filter().trim()}".`}
                actions={[{ label: "Limpar filtro", onClick: () => setFilter("") }]}
              />
            </Show>
            <div class="card-grid">
              <For each={visible()}>
                {(a) => (
                  <div class="card" onPointerEnter={truncTipEvent}>
                    <CoverArt
                      seed={a.name}
                      src={coverUrl(a.cover_path ?? null)}
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
                    <div class="card__sub">{plural(a.album_count, "álbum", "álbuns")} · {plural(a.track_count, "faixa", "faixas")}</div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  );

  return (
    <Show when={standalone()} fallback={body()}>
      <article class="view">
        <header class="view__head"><div><h1>Artistas</h1></div></header>
        {body()}
      </article>
    </Show>
  );
}
