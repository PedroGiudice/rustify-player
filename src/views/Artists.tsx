/* ============================================================
   views/Artists.tsx — Grid de artistas (card-grid).
   Markup identico ao artists.js vanilla.
   ============================================================ */

import { createResource, Show, For } from "solid-js";
import { libGetArtists } from "../tauri";
import { navigate } from "../router";

function initials(name: string): string {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

export default function Artists() {
  const [artists] = createResource(() => libGetArtists(500));

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Artists</h1>
        <Show when={artists()}>
          {(a) => <div class="view__stats"><span>{a().length} artists</span></div>}
        </Show>
      </header>

      <div class="view__body">
        <Show when={artists()} fallback={<p class="empty-state__hint">Loading...</p>}>
          {(list) => (
            <Show when={list().length > 0} fallback={
              <div class="empty-state"><p class="empty-state__title">No artists yet</p></div>
            }>
              <div class="card-grid">
                <For each={list()}>
                  {(a) => (
                    <div class="card" onClick={() => navigate(`/artist/${a.id}`)}>
                      <div class="card__cover card__cover--initials">{initials(a.name)}</div>
                      <div class="card__label">{a.name}</div>
                      <div class="card__sub">{a.track_count || 0} tracks</div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </article>
  );
}
