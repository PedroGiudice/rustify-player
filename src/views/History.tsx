/* ============================================================
   views/History.tsx — Listening history (full, scrollable).
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libListHistory, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { TrackRowList } from "../components/TrackRowList";
import { relTime } from "../lib/format";

export default function History() {
  const [tracks] = createResource(async () => {
    try { return await libListHistory(200); } catch { return [] as Track[]; }
  });

  function play(t: Track) {
    const all = tracks() ?? [];
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>History</h1>
          <p class="view__head-hint">Últimas {tracks()?.length ?? 0} faixas tocadas</p>
        </div>
      </header>

      <div class="view__body">
        <Show
          when={(tracks() ?? []).length > 0}
          fallback={
            <div class="empty-state">
              <p class="empty-state__title">Sem histórico ainda</p>
              <p class="empty-state__hint">Toque algumas faixas e elas vão aparecer aqui.</p>
            </div>
          }
        >
          <div class="row-list">
            <For each={tracks() ?? []}>
              {(t) => (
                <TrackRowList
                  track={t}
                  onClick={() => play(t)}
                  whenText={relTime(t.last_played)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </article>
  );
}
