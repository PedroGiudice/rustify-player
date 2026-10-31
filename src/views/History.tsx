/* ============================================================
   views/History.tsx — histórico de escuta, agrupado por dia (B13).
   Uma linha por faixa, pela última vez que tocou; o cabeçalho do dia
   conta as faixas e a coluna da linha diz a hora e quantas vezes ela
   já tocou (lib/historyDays.ts).
   ============================================================ */

import { createMemo, createResource, For, Match, Switch } from "solid-js";
import { libListHistory, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { TrackRowList } from "../components/TrackRowList";
import { groupByDay, playedWhen } from "../lib/historyDays";
import { plural } from "../lib/count";
import { navigate } from "../router";
import { EmptyState } from "../components/EmptyState";
import { ICONS } from "../components/Icon";
import { dataOf, listState, peek, settle } from "../lib/loaded";

export default function History() {
  const [res, { refetch }] = createResource(() => settle(libListHistory(200)));
  const tracks = () => dataOf<Track>(peek(res));
  const state = () => listState(peek(res));
  const days = createMemo(() => groupByDay(tracks()));

  function play(t: Track) {
    const all = tracks();
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>History</h1>
          <p class="view__head-hint">
            {state() === "pronto" ? `Últimas ${tracks().length} faixas tocadas` : "Faixas tocadas, da mais recente"}
          </p>
        </div>
      </header>

      <div class="view__body">
        <Switch>
          <Match when={state() === "carregando"}>
            <EmptyState tone="carregando" title="Carregando o histórico…" />
          </Match>
          <Match when={state() === "erro"}>
            <EmptyState
              tone="erro"
              title="Não consegui ler o histórico agora."
              text="O índice não respondeu. O que você ouviu continua registrado."
              actions={[{ label: "Tentar de novo", onClick: () => void refetch(), icon: ICONS.refresh }]}
            />
          </Match>
          <Match when={state() === "vazio"}>
            <EmptyState
              icon={ICONS.history}
              title="Sem histórico ainda."
              text="Toque algumas faixas e elas aparecem aqui."
              actions={[{ label: "Abrir a biblioteca", onClick: () => navigate("/library"), primary: true }]}
            />
          </Match>
          <Match when={state() === "pronto"}>
            <div class="hist">
              <For each={days()}>
                {(day) => (
                  <section class="hist-day" aria-label={`${day.label}, ${plural(day.items.length, "faixa", "faixas")}`}>
                    <h2 class="section__title hist-day__title">
                      {day.label}
                      <span class="hist-day__count"> · {plural(day.items.length, "faixa", "faixas")}</span>
                    </h2>
                    <div class="row-list">
                      <For each={day.items}>
                        {(t) => (
                          <TrackRowList
                            track={t}
                            onClick={() => play(t)}
                            whenText={playedWhen(t)}
                            contextList={tracks()}
                          />
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </article>
  );
}
