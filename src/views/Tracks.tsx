/* ============================================================
   views/Tracks.tsx — Flat list of all tracks with playlist chips.

   This view is reachable as a Library tab AND as /tracks direct.
   When mounted inside Library, the view__head is omitted (parent
   already rendered it); when used standalone it shows its own.

   O campo `genre` do índice é a pasta de primeiro nível do acervo, ou
   seja a PLAYLIST (scan.rs): a tela diz "Playlist" (A21).
   ============================================================ */

import { createMemo, createResource, createSignal, For, Show, Switch, Match } from "solid-js";
import { libListGenres, libGetTracks, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { TrackRowTable } from "../components/TrackRowTable";
import { EmptyState } from "../components/EmptyState";
import { ICONS } from "../components/Icon";
import { dataOf, listState, peek, settle } from "../lib/loaded";

/** Teto da listagem (o backend aceita mais; a tela não monta mais que isso
    de uma vez). Pede um a mais para saber se cortou. */
export const TRACKS_LIMIT = 5000;

const fmtN = (n: number) => n.toLocaleString("pt-BR");

export default function Tracks() {
  const [genre, setGenre] = createSignal<string | null>(null);

  const [genres] = createResource(async () => {
    try { return (await libListGenres()).filter((g: any) => g.track_count > 0); } catch { return []; }
  });

  // Chave = { g }: o source de createResource não pode ser null (null
  // suspende a busca), e "Todas" é genre null.
  const [result, { refetch }] = createResource(
    () => ({ g: genre() }),
    ({ g }) => settle(libGetTracks({ genre: g ?? undefined, limit: TRACKS_LIMIT + 1 })),
  );
  // peek: trocar de playlist mantém a lista anterior enquanto a nova chega
  // (sem piscar a tela inteira com o fallback do Suspense).
  const all = () => dataOf(peek(result));
  // Memo: a seleção múltipla reconhece a lista pela referência (claimList).
  const tracks = createMemo(() => {
    const a = all();
    return a.length > TRACKS_LIMIT ? a.slice(0, TRACKS_LIMIT) : a;
  });
  const truncated = () => all().length > TRACKS_LIMIT;
  const state = () => listState(peek(result));
  const busy = () => result.state === "refreshing";

  /** Total real quando se sabe (playlist escolhida); senão null. */
  const totalOf = () => {
    const g = genre();
    if (!g) return null;
    return (genres() ?? []).find((x: any) => x.name === g)?.track_count ?? null;
  };

  function play(t: Track) {
    const list = tracks();
    const idx = list.indexOf(t);
    setQueue(list, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  // Aberta direto (/tracks) a view traz o proprio .view — o unico
  // container que rola (.main tem overflow:hidden). Como aba, a Library
  // ja fornece o dela.
  const standalone = () => route().path === "/tracks";

  const body = () => (
    <div class="view__body">
      {/* Filtro e tabela num grupo só: o chip filtra o que está logo abaixo. */}
      <div class="lib-tracks" aria-busy={busy() ? "true" : undefined}>
        <div class="toolbar" role="group" aria-label="Filtrar por playlist">
          <button class={`chip${genre() === null ? " active" : ""}`} aria-pressed={genre() === null} onClick={() => setGenre(null)}>Todas</button>
          <For each={genres() ?? []}>
            {(g: any) => (
              <button
                class={`chip${genre() === g.name ? " active" : ""}`}
                aria-pressed={genre() === g.name}
                onClick={() => setGenre(g.name)}
              >
                {g.name}
              </button>
            )}
          </For>
          <Show when={busy()}>
            <span class="lib-busy" role="status">Atualizando…</span>
          </Show>
        </div>

        <Switch>
          <Match when={state() === "carregando"}>
            <EmptyState tone="carregando" title="Carregando o acervo…" />
          </Match>
          <Match when={state() === "erro"}>
            <EmptyState
              tone="erro"
              title="Não consegui ler o acervo agora."
              text="O índice não respondeu. As faixas continuam no disco."
              actions={[{ label: "Tentar de novo", onClick: () => void refetch(), icon: ICONS.refresh }]}
            />
          </Match>
          <Match when={state() === "vazio"}>
            <Show
              when={genre()}
              fallback={
                <EmptyState
                  icon={ICONS.tracks}
                  title="Nenhuma faixa no acervo ainda."
                  text="O que entra em ~/Music aparece aqui. Para trazer música nova, use o Crate."
                  actions={[{ label: "Abrir o Crate", onClick: () => navigate("/crate"), primary: true }]}
                />
              }
            >
              <EmptyState
                icon={ICONS.tracks}
                title="Nenhuma faixa nesta playlist."
                actions={[{ label: "Ver todas", onClick: () => setGenre(null) }]}
              />
            </Show>
          </Match>
          <Match when={state() === "pronto"}>
            <Show when={truncated()}>
              <p class="lib-note" role="status">
                Mostrando as primeiras {fmtN(TRACKS_LIMIT)}
                {totalOf() != null ? ` de ${fmtN(totalOf()!)}` : ""} faixas. Escolha uma playlist para ver o resto.
              </p>
            </Show>
            <div class="tracks" role="grid" aria-rowcount={tracks().length + 1}>
              <div class="tracks__head tracks__idx" role="columnheader">#</div>
              <div class="tracks__head" role="columnheader">Título</div>
              <div class="tracks__head" role="columnheader">Álbum</div>
              <div class="tracks__head" role="columnheader">Playlist</div>
              <div class="tracks__head tracks__mono" role="columnheader">Duração</div>

              <For each={tracks()}>
                {(t, i) => (
                  <TrackRowTable
                    track={t}
                    index={i() + 1}
                    onClick={() => play(t)}
                    contextList={tracks()}
                  />
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  );

  return (
    <Show when={standalone()} fallback={body()}>
      <article class="view">
        <header class="view__head">
          <div><h1>Faixas</h1></div>
        </header>
        {body()}
      </article>
    </Show>
  );
}
