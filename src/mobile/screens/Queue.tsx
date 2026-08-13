/* ============================================================
   Queue.tsx — porte de S.queue do handoff.

   A fila REAL vive no Kotlin e o plugin não expõe leitura dela: o
   que esta tela mostra é o espelho do último set_queue (persistido
   em localStorage para sobreviver ao WebView dormir), com o índice
   corrente vindo do serviço. Tocar uma linha chama skip_to_index —
   quem move a fila continua sendo o serviço.

   Sem reordenar: não há command para isso (o handle de arrastar do
   protótipo saiu).
   ============================================================ */

import { For, Show } from "solid-js";
import { TrackRow } from "../components/TrackRow";
import { Empty, SecHead, ViewHead } from "../components/ui";
import { current, pb, queue, queueOrigin, skipToIndex } from "../store";
import { originLabel } from "../derive";

export function Queue() {
  const upcoming = () => queue().slice(Math.max(0, pb.index + 1));
  return (
    <div class="screen">
      <ViewHead
        title="Queue"
        sub={queue().length ? `${queue().length} na fila · origem ${originLabel(queueOrigin())}` : undefined}
      />

      <Show
        when={queue().length || current()}
        fallback={<Empty title="Fila vazia" hint="Toque uma faixa, pasta ou álbum para montar a fila." />}
      >
        <Show when={current()}>
          {(t) => (
            <div class="sec">
              <div class="eyebrow" style={{ "margin-bottom": "10px" }}>
                Tocando agora
              </div>
              <div class="card" style={{ padding: "2px 12px", "border-color": "var(--accent-c)" }}>
                <TrackRow track={t()} onPlay={() => {}} />
              </div>
            </div>
          )}
        </Show>

        <Show
          when={upcoming().length}
          fallback={
            <Show when={queue().length === 0}>
              <div class="sec">
                <Empty
                  title="Fila indisponível"
                  hint="O app reiniciou e o serviço seguiu tocando: o conteúdo da fila vive no player nativo e não é legível pela interface."
                />
              </div>
            </Show>
          }
        >
          <div class="sec" style={{ padding: 0 }}>
            <div style={{ padding: "0 20px" }}>
              <SecHead label="A seguir" />
            </div>
            <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
              <For each={upcoming()}>
                {(t, i) => (
                  <TrackRow
                    track={t}
                    onPlay={() => void skipToIndex(pb.index + 1 + i())}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
        <div style={{ height: "14px" }} />
      </Show>
    </div>
  );
}
