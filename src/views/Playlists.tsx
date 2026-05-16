/* ============================================================
   views/Playlists.tsx — User playlists list + create CTA.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import type { Playlist } from "../tauri";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";

// NOTE: backend ainda nao expoe lib_list_playlists. Quando expuser,
// substitua o body do createResource por:
//   const data = await invoke<Playlist[]>("lib_list_playlists");
//   return data;
export default function Playlists() {
  const [playlists] = createResource(async (): Promise<Playlist[]> => []);

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Playlists</h1>
          <p class="view__head-hint">Suas coleções pessoais.</p>
        </div>
        <button class="chip active" style={{ "padding": "6px 12px" }}>
          <Icon name={ICONS.plus} size={12} /> New playlist
        </button>
      </header>

      <div class="view__body">
        <Show
          when={(playlists() ?? []).length > 0}
          fallback={
            <div class="empty-state">
              <p class="empty-state__title">Nenhuma playlist ainda</p>
              <p class="empty-state__hint">Use o botão acima pra criar.</p>
            </div>
          }
        >
          <div class="card-grid">
            <For each={playlists() ?? []}>
              {(p) => (
                <div class="card">
                  <CoverArt seed={p.name} size="md" class="card__cover" />
                  <div class="card__title">{p.name}</div>
                  <div class="card__sub">{p.track_count} tracks</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </article>
  );
}
