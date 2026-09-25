/* ============================================================
   Folder.tsx — porte de S.playlist do handoff.

   Pasta de 1º nível = playlist (é o que lib_list_folders devolve).
   Play → origin `playlist`; Shuffle → origin `autoplay` (cauda
   escolhida pela máquina; `shuffle` não é origin); tocar uma linha →
   a pasta inteira vira fila a partir daquele índice, com origin
   `manual` SÓ na faixa tocada e `playlist` na cauda que o Kotlin
   auto-avança (origem por item — a cauda é escuta passiva).

   Playlist é coleção curada e TERMINA (CEO, 17/08): TODOS os caminhos
   que refazem a fila a partir dela — Play, Shuffle, linha tocada
   (`playFolderFrom`) e, pela sheet da linha, "Tocar agora" e "Tocar a
   partir daqui" — armam continuidade OFF com a pasta como contexto;
   daí o `playlist: name()` no contexto da linha. As outras telas não
   passam `playlist` e ficam no default (radio).
   ============================================================ */

import { Show, createResource } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { TrackRow } from "../components/TrackRow";
import { Empty, LazyList, LoadError, TopBar } from "../components/ui";
import { libListFolderTracks } from "../ipc";
import { playFolder, playFolderFrom, shuffleFolder } from "../store";
import { fmtTotal } from "../derive";

export function Folder(props: { param: string | null }) {
  const name = () => props.param ?? "";
  const [data, { refetch }] = createResource(name, (n) =>
    n ? libListFolderTracks(n) : Promise.resolve([]),
  );
  // Ler um resource em erro RELANÇA a exceção (Solid 1.9) e, sem boundary,
  // derrubava a tela (mobile-13). `data.error` lê sem lançar: com erro, a
  // lista é vazia e a tela mostra o estado de erro.
  const list = () => (data.error ? [] : (data() ?? []));

  return (
    <div class="screen">
      <TopBar />
      <div class="hero">
        <Cover path={list()[0]?.album_cover_path} seed={name()} cls="art" />
        <div style={{ "min-width": 0 }}>
          <h1>{name()}</h1>
          <div class="meta">
            <Show when={!data.loading} fallback="carregando…">
              <Show when={!data.error} fallback="falha ao carregar">
                {list().length} faixas · {fmtTotal(list().map((t) => t.duration_ms))}
              </Show>
            </Show>
          </div>
        </div>
      </div>

      <Show when={data.error && !data.loading}>
        <LoadError
          title="Não deu para carregar a pasta"
          detail={String(data.error)}
          onRetry={() => void refetch()}
        />
      </Show>

      <Show when={list().length} fallback={<Show when={!data.loading && !data.error}><Empty title="Pasta vazia" hint="Nenhuma faixa indexada nesta pasta." /></Show>}>
        <div class="actions">
          <button class="btn btn--pri" onClick={() => void playFolder(list(), name())}>
            <Icon.play />
            Play
          </button>
          <button class="btn" onClick={() => void shuffleFolder(list(), name())}>
            <Icon.shuffle />
            Shuffle
          </button>
        </div>
        <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
          <LazyList items={list()} chunk={60}>
            {(t, i) => (
              <TrackRow
                track={t}
                context={{ list: list(), index: i(), playlist: name() }}
                onPlay={() => void playFolderFrom(list(), i(), name())}
              />
            )}
          </LazyList>
        </div>
        <div style={{ height: "16px" }} />
      </Show>
    </div>
  );
}
