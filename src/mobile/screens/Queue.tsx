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
import { Empty, LibGate, SecHead, ViewHead } from "../components/ui";
import {
  current,
  pb,
  queue,
  queueContextId,
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

  /* A fila abre na faixa ATUAL (mobile-5): "Já tocadas" vem antes e só
     cresce com a continuidade ligada — no topo, a tela mostrava o passado e
     "A seguir" ficava abaixo da dobra. Microtask: roda depois de o shell
     zerar a rolagem da entrada nova; ao VOLTAR, a restauração por quadro
     (nav.restoreScroll) vem depois e devolve a posição que o usuário deixou. */
  const scrollToNow = (el: HTMLElement) => {
    queueMicrotask(() => {
      if (!split().past.length) return;
      const view = el.closest<HTMLElement>(".view");
      if (!view) return;
      const gap = el.getBoundingClientRect().top - view.getBoundingClientRect().top;
      view.scrollTop = Math.max(0, view.scrollTop + gap - 8);
    });
  };
  const total = () => queue().length;

  const sub = () => {
    if (!total()) return undefined;
    const up = split().upcoming.length;
    const rest = fmtRemaining(queueRemainingMs());
    return `${up} a seguir · ${rest} restantes · origem ${originLabel(queueOrigin(), queueContextId())}`;
  };

  return (
    <div class="screen">
      <ViewHead title="Queue" sub={sub()} />

      {/* Sem o acervo carregado, cada item viraria "Faixa fora do acervo" —
          falso quando o que falhou foi a carga (mobile-12). */}
      <LibGate>
        <Show
          when={total() || current()}
          fallback={<Empty title="Fila vazia" hint="Toque uma faixa, pasta ou álbum para montar a fila." />}
        >
          <Show when={split().past.length}>
            <div class="sec" style={{ padding: 0 }}>
              <div style={{ padding: "0 20px" }}>
                <SecHead label="Já tocadas" />
              </div>
              {/* Esmaecido, mas no piso de 3:1 contra o --s-base (mobile-5,
                  mesmo critério das linhas inativas da letra no desktop):
                  com .62 a duração (--t4) caía para 2,17:1. .85 é o mínimo,
                  com folga de arredondamento, que leva a --t4 a 3,06:1. */}
              <div class="rowlist list-lite" style={{ padding: "0 20px", opacity: 0.85 }}>
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
              <div class="sec qnow" ref={scrollToNow}>
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
      </LibGate>
    </div>
  );
}
