/* ============================================================
   Album.tsx — porte de S.album do handoff.

   O álbum é derivado do acervo em memória (não há command de
   álbum no v0), ordenado por track_number. Play → origin
   `album_seq`, que é exatamente o caso "álbum em sequência" do
   contrato.
   ============================================================ */

import { For, Show, createMemo } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { TrackRow } from "../components/TrackRow";
import { Empty, TopBar } from "../components/ui";
import { navigate } from "../nav";
import { albums, playAlbum, playTrackFrom, shuffleList, tracks } from "../store";
import { fmtTotal, tracksOfAlbum } from "../derive";

export function Album(props: { param: string | null }) {
  const key = () => props.param ?? "";
  const album = createMemo(() => albums().find((a) => a.key === key()) ?? null);
  const list = createMemo(() => tracksOfAlbum(tracks(), key()));

  return (
    <div class="screen">
      <TopBar />
      <Show when={album()} fallback={<Empty title="Álbum não encontrado" hint="Ele pode ter saído do acervo no último re-scan." />}>
        {(a) => (
          <>
            <div class="hero">
              <Cover path={a().cover} seed={a().key} cls="art" icon="disc" />
              <div style={{ "min-width": 0 }}>
                <h1>{a().title}</h1>
                <Show when={a().artist}>
                  <button
                    class="by"
                    style={{ background: "none", border: 0, padding: 0, color: "var(--t2)", "font-family": "inherit", "font-size": "12.5px", "margin-top": "6px" }}
                    onClick={() => navigate("/artist", a().artist!)}
                  >
                    {a().artist}
                  </button>
                </Show>
                <div class="meta">
                  {[a().year, `${list().length} faixas`, fmtTotal(list().map((t) => t.duration_ms))]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
            </div>
            <div class="actions">
              <button class="btn btn--pri" onClick={() => void playAlbum(list(), a().key)}>
                <Icon.play />
                Play
              </button>
              <button class="btn" onClick={() => void shuffleList(list())}>
                <Icon.shuffle />
                Shuffle
              </button>
            </div>
            <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
              <For each={list()}>
                {(t, i) => (
                  <TrackRow
                    track={t}
                    ordinal={t.track_number ?? i() + 1}
                    sub={t.artist_name ?? ""}
                    onPlay={() => void playTrackFrom(list(), i())}
                  />
                )}
              </For>
            </div>
            <div style={{ height: "20px" }} />
          </>
        )}
      </Show>
    </div>
  );
}
