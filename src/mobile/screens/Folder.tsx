/* ============================================================
   Folder.tsx — porte de S.playlist do handoff.

   Pasta de 1º nível = playlist (é o que lib_list_folders devolve).
   Play → origin `playlist`; Shuffle → origin `shuffle`; tocar uma
   linha → origin `manual`, com a pasta inteira virando fila a
   partir daquele índice (o auto-advance é do Kotlin).
   ============================================================ */

import { Show, createResource } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { TrackRow } from "../components/TrackRow";
import { Empty, LazyList, TopBar } from "../components/ui";
import { libListFolderTracks } from "../ipc";
import { playFolder, playTrackFrom, shuffleList } from "../store";
import { fmtTotal } from "../derive";

export function Folder(props: { param: string | null }) {
  const name = () => props.param ?? "";
  const [data] = createResource(name, (n) => (n ? libListFolderTracks(n) : Promise.resolve([])));
  const list = () => data() ?? [];

  return (
    <div class="screen">
      <TopBar />
      <div class="hero">
        <Cover path={list()[0]?.album_cover_path} seed={name()} cls="art" />
        <div style={{ "min-width": 0 }}>
          <h1>{name()}</h1>
          <div class="meta">
            <Show when={!data.loading} fallback="carregando…">
              {list().length} faixas · {fmtTotal(list().map((t) => t.duration_ms))}
            </Show>
          </div>
        </div>
      </div>

      <Show when={list().length} fallback={<Show when={!data.loading}><Empty title="Pasta vazia" hint="Nenhuma faixa indexada nesta pasta." /></Show>}>
        <div class="actions">
          <button class="btn btn--pri" onClick={() => void playFolder(list(), name())}>
            <Icon.play />
            Play
          </button>
          <button class="btn" onClick={() => void shuffleList(list())}>
            <Icon.shuffle />
            Shuffle
          </button>
        </div>
        <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
          <LazyList items={list()} chunk={60}>
            {(t, i) => (
              <TrackRow
                track={t}
                context={{ list: list(), index: i() }}
                onPlay={() => void playTrackFrom(list(), i())}
              />
            )}
          </LazyList>
        </div>
        <div style={{ height: "16px" }} />
      </Show>
    </div>
  );
}
