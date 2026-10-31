/* ============================================================
   views/Liked.tsx — aba Curtidas da Library (B8, varredura de 31/10).

   Curtir é o gesto de maior peso no motor (behavioral_signals) e não
   tinha onde ser visto: `lib_list_liked` existia e ninguém chamava. A
   lista vem do backend ordenada por `liked_at`, a mais recente primeiro.

   "Tocar curtidas" embaralha todas numa fila aberta: quando ela acaba, o
   rádio segue a partir da última, uma curtida. A fila não leva origem de
   rádio de propósito: são faixas escolhidas pelo dono, e o motor não
   deve descontá-las como escuta passiva.

   A Library busca a lista (conta na aba) e passa por `list`.
   ============================================================ */

import { For, Match, Show, Switch, type Accessor } from "solid-js";
import type { Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { TrackRowList } from "../components/TrackRowList";
import { EmptyState } from "../components/EmptyState";
import { Icon, ICONS } from "../components/Icon";
import { relTime } from "../lib/format";
import { plural } from "../lib/count";
import { dataOf, listState, type Loaded } from "../lib/loaded";

/** Teto da lista (o backend corta no limit). Bater nele = a tela avisa. */
export const LIKED_LIMIT = 1000;

function shuffled<T>(list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default function Liked(props: {
  list: Accessor<Loaded<Track[]> | undefined>;
  onRetry: () => void;
}) {
  const tracks = () => dataOf(props.list());
  const state = () => listState(props.list());

  function playFrom(t: Track) {
    const all = tracks();
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0, "open");
    playTrack(t);
  }

  function playAll() {
    const queue = shuffled(tracks());
    if (!queue.length) return;
    setQueue(queue, 0, "open", null);
    playTrack(queue[0]);
  }

  return (
    <div class="view__body">
      <Switch>
        <Match when={state() === "carregando"}>
          <EmptyState tone="carregando" title="Carregando as curtidas…" />
        </Match>
        <Match when={state() === "erro"}>
          <EmptyState
            tone="erro"
            title="Não consegui ler as curtidas agora."
            text="O índice não respondeu. As curtidas continuam registradas."
            actions={[{ label: "Tentar de novo", onClick: () => props.onRetry(), icon: ICONS.refresh }]}
          />
        </Match>
        <Match when={state() === "vazio"}>
          <EmptyState
            icon={ICONS.heart}
            title="Nenhuma faixa curtida ainda."
            text="Curta pelo coração da barra do player ou do Now Playing; a faixa aparece aqui, a mais recente primeiro."
          />
        </Match>
        <Match when={state() === "pronto"}>
          <div class="lib-liked">
            <div class="lib-liked__bar">
              <p class="lib-liked__count">
                <b>{plural(tracks().length, "curtida", "curtidas")}</b>
                <Show when={tracks().length >= LIKED_LIMIT}>
                  {" "}· mostrando as {LIKED_LIMIT.toLocaleString("pt-BR")} mais recentes
                </Show>
              </p>
              <button type="button" class="pl-action-btn pl-action-btn--primary" onClick={playAll}>
                <Icon name={ICONS.shuffle} size={13} />
                <span>Tocar curtidas</span>
              </button>
            </div>
            <div class="row-list">
              <For each={tracks()}>
                {(t) => (
                  <TrackRowList
                    track={t}
                    onClick={() => playFrom(t)}
                    whenText={relTime(t.liked_at)}
                    contextList={tracks()}
                  />
                )}
              </For>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  );
}
