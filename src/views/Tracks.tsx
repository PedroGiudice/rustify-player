/* ============================================================
   views/Tracks.tsx — Flat list of all tracks with genre chips.

   This view is reachable as a Library tab AND as /tracks direct.
   When mounted inside Library, the view__head is omitted (parent
   already rendered it); when used standalone it shows its own.
   ============================================================ */

import { createResource, createSignal, For, Show } from "solid-js";
import { libListGenres, libGetTracks, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { route } from "../router";
import { TrackRowTable } from "../components/TrackRowTable";

export default function Tracks() {
  const [genre, setGenre] = createSignal<string | null>(null);

  const [genres] = createResource(async () => {
    try { return (await libListGenres()).filter((g: any) => g.track_count > 0); } catch { return []; }
  });

  const [tracks] = createResource(genre, async (g): Promise<Track[]> => {
    try { return await libGetTracks({ genre: g ?? null, limit: 500 }); } catch { return []; }
  });

  function play(t: Track) {
    const all = tracks() ?? [];
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  const standalone = () => route().path === "/tracks";

  return (
    <>
      <Show when={standalone()}>
        <header class="view__head">
          <div><h1>Tracks</h1></div>
        </header>
      </Show>

      <div class="view__body">
        <div class="toolbar">
          <button class={`chip${genre() === null ? " active" : ""}`} onClick={() => setGenre(null)}>All</button>
          <For each={genres() ?? []}>
            {(g: any) => (
              <button
                class={`chip${genre() === g.name ? " active" : ""}`}
                onClick={() => setGenre(g.name)}
              >
                {g.name}
              </button>
            )}
          </For>
        </div>

        <div class="tracks">
          <div class="tracks__head tracks__idx">#</div>
          <div class="tracks__head">Title</div>
          <div class="tracks__head">Album</div>
          <div class="tracks__head">Genre</div>
          <div class="tracks__head tracks__mono">Length</div>

          <For each={tracks() ?? []}>
            {(t, i) => (
              <TrackRowTable
                track={t}
                index={i() + 1}
                onClick={() => play(t)}
                contextList={tracks() ?? []}
              />
            )}
          </For>

          <Show when={(tracks() ?? []).length === 0 && !tracks.loading}>
            <div style={{ "grid-column": "1 / -1", padding: "32px", "text-align": "center", color: "var(--fg-5)" }}>
              Nenhuma track encontrada.
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
