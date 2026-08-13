/* ============================================================
   Library.tsx — porte de S.library do handoff.

   As facetas são as que os dados do v0 sustentam: Pastas (=
   playlists, lib_list_folders), Álbuns e Artistas (derivados do
   acervo em memória) e Faixas (lib_list_tracks). "Genres" saiu
   por não ter tela de destino; de "Collections" sobrou a Fila —
   Stations e History não existem no v0.
   ============================================================ */

import { For, Show, createSignal } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { TrackRow } from "../components/TrackRow";
import { Empty, LazyList, SecHead, ViewHead } from "../components/ui";
import { navigate } from "../nav";
import { albums, artists, folders, libReady, playTrackFrom, tracks } from "../store";
import { fmtCount } from "../derive";

type Facet = "folders" | "albums" | "artists" | "tracks";
const FACETS: Array<{ id: Facet; label: string }> = [
  { id: "folders", label: "Pastas" },
  { id: "albums", label: "Álbuns" },
  { id: "artists", label: "Artistas" },
  { id: "tracks", label: "Faixas" },
];

export function Library() {
  const [facet, setFacet] = createSignal<Facet>("folders");
  const sub = () =>
    `${fmtCount(tracks().length)} faixas · ${albums().length} álbuns · ${artists().length} artistas`;

  return (
    <div class="screen">
      <ViewHead title="Library" sub={libReady() ? sub() : "carregando acervo…"} />

      <div class="chiprow">
        <For each={FACETS}>
          {(f) => (
            <button class="chip" attr:data-on={facet() === f.id ? "" : undefined} onClick={() => setFacet(f.id)}>
              {f.label}
            </button>
          )}
        </For>
      </div>

      <Show when={libReady()} fallback={<Empty title="Carregando biblioteca…" />}>
        <Show when={facet() === "folders"}>
          <Show when={folders().length} fallback={<Empty title="Nenhuma pasta" hint="As pastas de 1º nível de Music viram playlists." />}>
            <div class="rowlist">
              <For each={folders()}>
                {(f) => (
                  <button class="rowitem" onClick={() => navigate("/folder", f.name)}>
                    <Cover seed={f.name} />
                    <div style={{ flex: 1, "min-width": 0 }}>
                      <div class="rt">{f.name}</div>
                      <div class="rowsub">{f.track_count} faixas</div>
                    </div>
                    <Icon.chev />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>

        <Show when={facet() === "albums"}>
          <Show when={albums().length} fallback={<Empty title="Nenhum álbum" hint="As faixas do acervo não têm tag de álbum." />}>
            <div class="sec">
              <div class="grid">
                <LazyList items={albums()} chunk={24}>
                  {(a) => (
                    <button class="alb" onClick={() => navigate("/album", a.key)}>
                      <Cover path={a.cover} seed={a.key} cls="art" icon="disc" />
                      <div class="t">{a.title}</div>
                      <div class="s">
                        {[a.artist, a.year].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </button>
                  )}
                </LazyList>
              </div>
            </div>
          </Show>
        </Show>

        <Show when={facet() === "artists"}>
          <Show when={artists().length} fallback={<Empty title="Nenhum artista" />}>
            <div class="rowlist">
              <LazyList items={artists()} chunk={40}>
                {(a) => (
                  <button class="rowitem" onClick={() => navigate("/artist", a.name)}>
                    <Cover path={a.cover} seed={a.name} icon="person" />
                    <div style={{ flex: 1, "min-width": 0 }}>
                      <div class="rt">{a.name}</div>
                      <div class="rowsub">
                        {a.album_count} álbuns · {a.track_count} faixas
                      </div>
                    </div>
                    <Icon.chev />
                  </button>
                )}
              </LazyList>
            </div>
          </Show>
        </Show>

        <Show when={facet() === "tracks"}>
          <Show when={tracks().length} fallback={<Empty title="Acervo vazio" />}>
            <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
              <LazyList items={tracks()} chunk={60}>
                {(t, i) => <TrackRow track={t} onPlay={() => void playTrackFrom(tracks(), i())} />}
              </LazyList>
            </div>
          </Show>
        </Show>

        <div class="sec" style={{ "margin-top": "22px" }}>
          <SecHead label="Coleções" />
          <div class="rowlist">
            <button class="rowitem" style={{ "padding-left": 0, "padding-right": 0 }} onClick={() => navigate("/queue")}>
              <Icon.queue class="lead" />
              <div class="rt">Fila</div>
              <Icon.chev />
            </button>
          </div>
        </div>
        <div style={{ height: "14px" }} />
      </Show>
    </div>
  );
}
