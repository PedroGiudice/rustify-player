/* ============================================================
   views/Queue.tsx — Full-page queue view (separate from the
   slide-over drawer). Useful for reorganizing long queues.
   ============================================================ */

import { For, Show } from "solid-js";
import { player } from "../store/player";
import { TrackRowList } from "../components/TrackRowList";
import { playTrack, playQueueUpcoming } from "../components/PlayerBar";

export default function Queue() {
  const upcoming = () => player.queue.slice(player.queueIndex + 1);
  const past = () => player.queue.slice(0, player.queueIndex);

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Queue</h1>
          <p class="view__head-hint">
            {upcoming().length} tracks próximos · {past().length} já reproduzidos
          </p>
        </div>
      </header>

      <div class="view__body">
        <Show when={player.currentTrack}>
          {(t) => (
            <section>
              <div class="section__head"><h2 class="section__title">Now playing</h2></div>
              <TrackRowList track={t()} onClick={() => playTrack(t())} noWhen />
            </section>
          )}
        </Show>

        <Show when={upcoming().length > 0}>
          <section>
            <div class="section__head"><h2 class="section__title">Up next · {upcoming().length}</h2></div>
            <div class="row-list">
              <For each={upcoming()}>
                {(t) => <TrackRowList track={t} onClick={() => playQueueUpcoming(t)} noWhen />}
              </For>
            </div>
          </section>
        </Show>

        <Show when={past().length > 0}>
          <section>
            <div class="section__head"><h2 class="section__title">History · {past().length}</h2></div>
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
            <p class="empty-state__hint">Toque algo da Library pra começar.</p>
          </div>
        </Show>
      </div>
    </article>
  );
}
