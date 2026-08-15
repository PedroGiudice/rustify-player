/* ============================================================
   Queue.tsx — a fila REAL do serviço.

   A fila vive no ExoPlayer e é lida por `get_queue` (não há mais
   espelho em localStorage). Por isso a tela sobrevive ao WebView
   reiniciar com o serviço tocando — o estado "Fila indisponível"
   deixou de existir.

   Tocar uma linha chama skip_to_index; quem move a fila continua
   sendo o serviço.

   Sem reordenar: não há command para isso (epic A, fase 3).
   ============================================================ */

import { For, Show } from "solid-js";
import { TrackRow } from "../components/TrackRow";
import { Empty, SecHead, ViewHead } from "../components/ui";
import {
  current,
  pb,
  queue,
  queueOrigin,
  queueRemainingMs,
  skipToIndex,
} from "../store";
import { originLabel } from "../derive";
import { fmtRemaining, splitQueue } from "../queueModel";

/** Faixa que está na fila do serviço mas não existe no acervo local
 *  (sync parcial). Ocupa a posição para os índices continuarem certos. */
function MissingRow(props: { index: number }) {
  return (
    <div class="row" style={{ opacity: 0.5 }}>
      <div class="row__main">
        <div class="row__title">Faixa fora do acervo</div>
        <div class="row__sub">posição {props.index + 1} · não está neste aparelho</div>
      </div>
    </div>
  );
}

export function Queue() {
  const split = () => splitQueue(queue(), pb.index);
  const total = () => queue().length;

  const sub = () => {
    if (!total()) return undefined;
    const up = split().upcoming.length;
    const rest = fmtRemaining(queueRemainingMs());
    return `${up} a seguir · ${rest} restantes · origem ${originLabel(queueOrigin())}`;
  };

  return (
    <div class="screen">
      <ViewHead title="Queue" sub={sub()} />

      <Show
        when={total() || current()}
        fallback={<Empty title="Fila vazia" hint="Toque uma faixa, pasta ou álbum para montar a fila." />}
      >
        <Show when={split().past.length}>
          <div class="sec" style={{ padding: 0 }}>
            <div style={{ padding: "0 20px" }}>
              <SecHead label="Já tocadas" />
            </div>
            <div class="rowlist list-lite" style={{ padding: "0 20px", opacity: 0.62 }}>
              <For each={split().past}>
                {(t, i) => (
                  <Show when={t} fallback={<MissingRow index={i()} />}>
                    {(track) => <TrackRow track={track()} onPlay={() => void skipToIndex(i())} />}
                  </Show>
                )}
              </For>
            </div>
          </div>
        </Show>

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

        <Show when={split().upcoming.length}>
          <div class="sec" style={{ padding: 0 }}>
            <div style={{ padding: "0 20px" }}>
              <SecHead label="A seguir" />
            </div>
            <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
              <For each={split().upcoming}>
                {(t, i) => {
                  const at = () => Math.max(0, pb.index) + 1 + i();
                  return (
                    <Show when={t} fallback={<MissingRow index={at()} />}>
                      {(track) => <TrackRow track={track()} onPlay={() => void skipToIndex(at())} />}
                    </Show>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
        <div style={{ height: "14px" }} />
      </Show>
    </div>
  );
}
