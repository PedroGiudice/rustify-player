/* ============================================================
   Home.tsx — porte de S.home do handoff.

   O protótipo tinha três quick starts (Shuffle / Station /
   Crate): Station entrou com o trilho CMR-190 (stations.json
   exportada do desktop); Crate segue fora (slskd na cmr-auto).
   "Based on your favorites" é o taste snapshot do mesmo trilho.
   "Recently played" (CMR-215) é a shelf entre os quick starts e
   os favoritos: 8 faixas DISTINTAS que contaram como play, do
   anel de recentes do Rust (`lib_recent_plays`). "Genres" segue
   fora (sem tela de destino).
   ============================================================ */

import { For, Show } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { TrackRow } from "../components/TrackRow";
import { Empty, SecHead, ViewHead } from "../components/ui";
import { navigate } from "../nav";
import {
  albums,
  favorites,
  folders,
  libReady,
  playTrackFrom,
  recents,
  shuffleAll,
  stations,
  tracks,
} from "../store";
import { fmtCount } from "../derive";

export function Home() {
  const sub = () => `${fmtCount(tracks().length)} faixas · ${folders().length} pastas`;
  return (
    <div class="screen">
      <ViewHead
        title="Home"
        sub={libReady() ? sub() : "carregando acervo…"}
        right={
          <button class="iconbtn" aria-label="Ajustes" onClick={() => navigate("/settings")}>
            <Icon.settings />
          </button>
        }
      />

      <Show
        when={libReady() && tracks().length > 0}
        fallback={
          <Show when={libReady()} fallback={<Empty title="Carregando biblioteca…" />}>
            <Empty
              title="Acervo vazio"
              hint="Nenhuma faixa em /storage/emulated/0/Music. Sincronize o acervo e use Re-scan em Settings."
            />
          </Show>
        }
      >
        <div class="qs-row">
          <button class="qs" onClick={() => void shuffleAll()}>
            <div class="eyebrow" style={{ color: "var(--accent)" }}>
              Quick start
            </div>
            <h3>Shuffle all</h3>
            <div class="meta">{fmtCount(tracks().length)} tracks</div>
          </button>
          <Show when={stations().length}>
            <button class="qs" onClick={() => navigate("/stations")}>
              <div class="eyebrow">Station</div>
              <h3>Stations</h3>
              <div class="meta">{stations().filter((s) => s.pool_size > 0).length} prontas</div>
            </button>
          </Show>
        </div>

        <Show when={recents().length}>
          <div class="sec">
            <SecHead label="Recently played" />
            <div class="card" style={{ padding: "2px 12px" }}>
              <For each={recents()}>
                {(t, i) => (
                  <TrackRow
                    track={t}
                    context={{ list: recents(), index: i() }}
                    onPlay={() => void playTrackFrom(recents(), i())}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={favorites().length}>
          <div class="sec">
            <SecHead label="Based on your favorites" />
            <div class="grid">
              <For each={favorites().slice(0, 4)}>
                {(t, i) => (
                  <button class="alb" onClick={() => void playTrackFrom(favorites(), i())}>
                    <Cover path={t.album_cover_path} seed={t.id} cls="art" icon="note" />
                    <div class="t">{t.title}</div>
                    <div class="s">{t.artist_name ?? "—"}</div>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={folders().length}>
          <div class="sec">
            <SecHead label="Pastas" link={{ label: "Ver todas", onClick: () => navigate("/library") }} />
            <div class="card" style={{ padding: "2px 12px" }}>
              <For each={folders().slice(0, 5)}>
                {(f) => (
                  <button class="trk" onClick={() => navigate("/folder", f.name)}>
                    <Cover seed={f.name} />
                    <div class="info">
                      <div class="tt">{f.name}</div>
                      <div class="ts">{f.track_count} faixas</div>
                    </div>
                    <Icon.chev />
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={albums().length}>
          <div class="sec">
            <SecHead label="Álbuns" link={{ label: "Ver todos", onClick: () => navigate("/library") }} />
            <div class="grid">
              <For each={albums().slice(0, 4)}>
                {(a) => (
                  <button class="alb" onClick={() => navigate("/album", a.key)}>
                    <Cover path={a.cover} seed={a.key} cls="art" icon="disc" />
                    <div class="t">{a.title}</div>
                    <div class="s">{a.artist ?? "—"}</div>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <div style={{ height: "10px" }} />
      </Show>
    </div>
  );
}
