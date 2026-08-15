/* ============================================================
   Artist.tsx — porte de S.artist do handoff.

   Derivado do acervo em memória. O botão "Play" do protótipo NÃO
   foi portado de propósito: tocar a discografia inteira em
   sequência não tem origin no contrato (`manual` é faixa
   escolhida, `playlist` é pasta, `album_seq` é álbum) e inventar
   um nome contamina o motor de sinal. Sobrou o Shuffle (origin
   `shuffle`), os álbuns e as faixas — que tocam como `manual`.
   ============================================================ */

import { For, Show, createMemo } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { TrackRow } from "../components/TrackRow";
import { Empty, LazyList, SecHead, TopBar } from "../components/ui";
import { navigate } from "../nav";
import { albums, artists, playTrackFrom, shuffleList, tracks } from "../store";
import { fmtTotal, normalize, tracksOfArtist } from "../derive";

export function Artist(props: { param: string | null }) {
  const name = () => props.param ?? "";
  const artist = createMemo(() => artists().find((a) => normalize(a.name) === normalize(name())) ?? null);
  const list = createMemo(() => tracksOfArtist(tracks(), name()));
  const own = createMemo(() => albums().filter((a) => normalize(a.artist) === normalize(name())));

  return (
    <div class="screen">
      <TopBar />
      <Show when={artist()} fallback={<Empty title="Artista não encontrado" />}>
        {(a) => (
          <>
            <div class="hero">
              <Cover path={a().cover} seed={a().name} cls="art" icon="person" />
              <div style={{ "min-width": 0 }}>
                <h1>{a().name}</h1>
                <div class="meta">
                  {a().album_count} álbuns · {list().length} faixas · {fmtTotal(list().map((t) => t.duration_ms))}
                </div>
              </div>
            </div>
            <div class="actions">
              <button class="btn btn--pri" onClick={() => void shuffleList(list())}>
                <Icon.shuffle />
                Shuffle
              </button>
            </div>

            <Show when={own().length}>
              <div class="sec">
                <SecHead label="Álbuns" />
                <div class="grid">
                  <For each={own()}>
                    {(al) => (
                      <button class="alb" onClick={() => navigate("/album", al.key)}>
                        <Cover path={al.cover} seed={al.key} cls="art" icon="disc" />
                        <div class="t">{al.title}</div>
                        <div class="s">{al.year ?? `${al.track_count} faixas`}</div>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <div class="sec" style={{ padding: 0 }}>
              <div style={{ padding: "0 20px" }}>
                <SecHead label="Faixas" />
              </div>
              <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
                <LazyList items={list()} chunk={50}>
                  {(t, i) => (
                    <TrackRow
                      track={t}
                      context={{ list: list(), index: i() }}
                      sub={t.album_title ?? ""}
                      onPlay={() => void playTrackFrom(list(), i())}
                    />
                  )}
                </LazyList>
              </div>
            </div>
            <div style={{ height: "16px" }} />
          </>
        )}
      </Show>
    </div>
  );
}
