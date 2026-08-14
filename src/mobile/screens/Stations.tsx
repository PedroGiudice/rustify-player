/* ============================================================
   Stations.tsx — porte de S.stations do handoff, adaptado ao
   trilho real (CMR-190): as stations vêm PRONTAS do desktop
   (stations.json com pool precomputado) — sem criação nem
   delete no aparelho. O que sobrou do protótipo: a lista de
   stcards. O livecard e o mood sheet ficam pra quando houver
   sessão de station rastreada / criação local.
   ============================================================ */

import { For, Show } from "solid-js";
import { Icon } from "../icons";
import { Empty, ViewHead } from "../components/ui";
import { playStation, stations } from "../store";
import { toneFor } from "../derive";
import type { StationMeta } from "../types";

function tags(st: StationMeta): string {
  if (st.kind === "mood") return `mood · ${st.query ?? ""}`;
  return "seed · dos seus favoritos";
}

export function Stations() {
  return (
    <div class="screen">
      <ViewHead
        title="Stations"
        sub={stations().length ? `${stations().length} do desktop · re-rank local` : undefined}
      />
      <Show
        when={stations().length}
        fallback={
          <Empty
            title="Sem stations no aparelho"
            hint="Rode o export no desktop (export_manifest.py --deploy) e sincronize o acervo."
          />
        }
      >
        <div class="sec">
          <div class="stlist">
            <For each={stations()}>
              {(st) => {
                const dead = st.pool_size === 0;
                return (
                  <div class="stcard" attr:data-dead={dead ? "" : undefined}>
                    <div
                      class="stcard__tile"
                      style={{
                        background: `var(--tone-${toneFor(st.id)})`,
                        "border-color": `var(--tone-${toneFor(st.id)}-b)`,
                      }}
                    >
                      <Icon.sparkle />
                    </div>
                    <button
                      class="stcard__body"
                      disabled={dead}
                      onClick={() => void playStation(st)}
                    >
                      <div class="stcard__top">
                        <div class="stcard__n">{st.name}</div>
                      </div>
                      <div class="stcard__tags">{tags(st)}</div>
                      <div class="stcard__meta">
                        {dead ? "sem candidatas no acervo" : `${st.pool_size} candidatas`}
                      </div>
                    </button>
                    <div class="stcard__acts">
                      <button
                        class="iconbtn sm"
                        aria-label={`Tocar ${st.name}`}
                        disabled={dead}
                        onClick={() => void playStation(st)}
                      >
                        <Icon.play />
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
        <div style={{ height: "12px" }} />
      </Show>
    </div>
  );
}
