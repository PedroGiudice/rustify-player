/* ============================================================
   Home.tsx — porte de S.home do handoff.

   O protótipo tinha três quick starts (Shuffle / Station /
   Crate): station e crate não existem no v0, então sobrou o
   Shuffle all — que é real (set_queue do acervo embaralhado,
   origin `shuffle`). "Recently played" e "Genres" também saíram:
   não há command de histórico no v0.
   ============================================================ */

import { For, Show } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { Empty, SecHead, ViewHead } from "../components/ui";
import { navigate } from "../nav";
import { albums, folders, libReady, shuffleAll, tracks } from "../store";
import { fmtCount } from "../derive";

export function Home() {
  const sub = () => `${fmtCount(tracks().length)} faixas · ${folders().length} pastas`;
  return (
    <div class="screen">
      <ViewHead
        title="Home"
        sub={libReady() ? sub() : "carregando acervo…"}
        right={
          <div style={{ display: "flex", gap: "2px" }}>
            <button class="iconbtn" aria-label="Fila" onClick={() => navigate("/queue")}>
              <Icon.queue />
            </button>
            <button class="iconbtn" aria-label="Ajustes" onClick={() => navigate("/settings")}>
              <Icon.settings />
            </button>
          </div>
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
        </div>

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
