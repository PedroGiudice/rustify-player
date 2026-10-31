/* ============================================================
   views/Queue.tsx — Fila em página inteira (separada da gaveta).
   Útil para reorganizar filas longas. Mesmo vocabulário da gaveta
   (QueueDrawer, A9): cabeçalho por queueMeta, nota do que vem depois
   por queueEndNote, e a faixa atual abre o Now Playing em vez de
   recomeçar (playTrack registraria mais um play no motor).
   ============================================================ */

import { For, Show } from "solid-js";
import { player } from "../store/player";
import { TrackRowList } from "../components/TrackRowList";
import { playTrack, playQueueUpcoming } from "../components/PlayerBar";
import { queueEndNote, queueMeta, radioReason } from "../components/QueueDrawer";
import { navigate } from "../router";

export default function Queue() {
  const upcoming = () => player.queue.slice(player.queueIndex + 1);
  const past = () => player.queue.slice(0, player.queueIndex);

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Fila</h1>
          <p class="view__head-hint">{queueMeta(upcoming(), !!player.currentTrack)}</p>
        </div>
      </header>

      <div class="view__body">
        <Show when={player.currentTrack}>
          {(t) => (
            <section>
              <div class="section__head"><h2 class="section__title">Tocando agora</h2></div>
              <TrackRowList track={t()} onClick={() => navigate("/now-playing")} noWhen />
              <Show when={radioReason(t(), player.queue)}>
                {(why) => <p class="queue-view__why">{why()}</p>}
              </Show>
            </section>
          )}
        </Show>

        <Show when={upcoming().length > 0}>
          <section>
            <div class="section__head"><h2 class="section__title">A seguir · {upcoming().length}</h2></div>
            <div class="row-list">
              <For each={upcoming()}>
                {(t) => (
                  <>
                    <TrackRowList track={t} onClick={() => playQueueUpcoming(t)} noWhen />
                    <Show when={radioReason(t, player.queue)}>
                      {(why) => <p class="queue-view__why">{why()}</p>}
                    </Show>
                  </>
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={player.currentTrack}>
          <p class="queue-view__note">{queueEndNote(upcoming().length > 0, player.repeatMode)}</p>
        </Show>

        <Show when={past().length > 0}>
          <section>
            <div class="section__head"><h2 class="section__title">Já tocadas · {past().length}</h2></div>
            <div class="row-list">
              <For each={past().slice().reverse()}>
                {(t) => <TrackRowList track={t} onClick={() => playTrack(t)} noWhen muted />}
              </For>
            </div>
          </section>
        </Show>

        <Show when={!player.currentTrack && upcoming().length === 0}>
          <div class="empty-state">
            <p class="empty-state__title">Fila vazia</p>
            <p class="empty-state__hint">Toque algo da biblioteca para começar.</p>
          </div>
        </Show>
      </div>
    </article>
  );
}
