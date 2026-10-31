/* ============================================================
   views/Albums.tsx — Grade de todos os álbuns.

   Clicar no card ABRE o álbum (B1, varredura de 31/10): antes tocava e
   trocava a fila, e a grade não tinha caminho para a página do álbum. Só
   o play do hover toca. Abrir é o nome (<button class="card__open">), cujo
   ::after cobre o card (mesmo padrão da Playlists); o play é um botão
   irmão, nenhum controle aninhado em outro.
   Filtro por texto acima da grade (B3).
   ============================================================ */

import { createMemo, createResource, createSignal, For, Show, Switch, Match, type Accessor } from "solid-js";
import { libGetAlbums, libGetTracks, coverUrl, type Album } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";
import { EmptyState } from "../components/EmptyState";
import { dataOf, listState, peek, settle, type Loaded } from "../lib/loaded";
import { ALBUM_TRACK_LIMIT, albumHref } from "../lib/albumRoute";
import { truncTipEvent } from "../lib/truncTip";
import { filterByText } from "../lib/gridFilter";
import { plural } from "../lib/count";
import { FilterField } from "../components/FilterField";

/** Toca o álbum inteiro: título E artista, para dois "Greatest Hits" não
    virarem uma fila só (A19). */
export async function playAlbum(album: Album) {
  const tracks = await libGetTracks({ album: album.title, artist: album.artist_name ?? undefined, limit: ALBUM_TRACK_LIMIT });
  // scope "curated": album e uma unidade coerente — shuffle embaralha so este.
  if (tracks.length) { setQueue(tracks, 0, "curated", { kind: "album", name: album.title }); playTrack(tracks[0]); }
}

/** `list`: listagem já buscada pela Library (que a usa na contagem da
    aba), com `onRetry` para refazê-la. Sem ela — rota /albums direta — a
    view busca a própria. */
export default function Albums(props: {
  param?: string;
  list?: Accessor<Loaded<Album[]> | undefined>;
  onRetry?: () => void;
}) {
  let retry = () => props.onRetry?.();
  let result: Accessor<Loaded<Album[]> | undefined>;
  if (props.list) {
    result = props.list;
  } else {
    const [r, { refetch }] = createResource(() => settle(libGetAlbums({ limit: null })));
    result = () => peek(r);
    retry = () => void refetch();
  }
  const albums = () => dataOf(result());
  // Filtro por texto (B3): título e artista, sem acento.
  const [filter, setFilter] = createSignal("");
  const visible = createMemo(() => filterByText(albums(), filter(), (a) => `${a.title} ${a.artist_name ?? ""}`));

  // Aberta direto (/albums) a view traz o proprio .view — o unico
  // container que rola (.main tem overflow:hidden). Como aba, a Library
  // ja fornece o dela.
  const standalone = () => route().path === "/albums";

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
            text="O índice não respondeu. Os álbuns continuam no disco."
            actions={[{ label: "Tentar de novo", onClick: retry, icon: ICONS.refresh }]}
          />
        </Match>
        <Match when={listState(result()) === "vazio"}>
          <EmptyState
            icon={ICONS.albums}
            title="Nenhum álbum no acervo."
            text="Faixa sem a tag de álbum fica fora desta grade; ela aparece em Faixas."
          />
        </Match>
        <Match when={listState(result()) === "pronto"}>
          <div class="lib-grid">
            <FilterField
              value={filter()}
              onInput={setFilter}
              label="Filtrar álbuns"
              placeholder="Filtrar por álbum ou artista…"
              status={filter().trim() ? `${visible().length.toLocaleString("pt-BR")} de ${albums().length.toLocaleString("pt-BR")}` : undefined}
            />
            <Show when={visible().length === 0}>
              <EmptyState
                compact
                title={`Nenhum álbum com "${filter().trim()}".`}
                actions={[{ label: "Limpar filtro", onClick: () => setFilter("") }]}
              />
            </Show>
            <div class="card-grid">
              <For each={visible()}>
                {(a) => (
                  <div class="card" onPointerEnter={truncTipEvent}>
                    <CoverArt
                      seed={a.title}
                      src={coverUrl(a.cover_path)}
                      size="md"
                      class="card__cover"
                    >
                      <button class="card__play" type="button" aria-label={`Tocar ${a.title}`} onClick={(e) => { e.stopPropagation(); void playAlbum(a); }}><Icon name={ICONS.play} size={12} /></button>
                    </CoverArt>
                    <button
                      type="button"
                      class="card__title card__open"
                      data-trunc
                      onClick={() => navigate(albumHref(a.title, a.artist_name))}
                      onFocus={truncTipEvent}
                    >
                      {a.title}
                    </button>
                    <div class="card__sub" data-trunc>{a.artist_name ?? "—"}</div>
                    <div class="card__meta">{plural(a.track_count, "faixa", "faixas")}{a.year ? ` · ${a.year}` : ""}</div>
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
        <header class="view__head">
          <div><h1>Albums</h1></div>
        </header>
        {body()}
      </article>
    </Show>
  );
}
