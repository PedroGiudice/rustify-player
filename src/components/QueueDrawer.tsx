/* ============================================================
   components/QueueDrawer.tsx — Right-side slide-over showing
   the live queue + recently played history.

   Reactive to player.queue, player.queueIndex.
   Opens on Q key or 'rustify:open-queue' custom event. O evento
   alterna; com detail { open: boolean } força o estado (a ação
   "Open queue" da palette pede abrir, não alternar).
   ============================================================ */

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Icon, ICONS } from "./Icon";
import { TrackRowList } from "./TrackRowList";
import { player, setQueue } from "../store/player";
import { playTrack, playQueueUpcoming } from "./PlayerBar";
import { fmtDur } from "../lib/format";
import { isTypingContext } from "../lib/keyboard";
import { pushEscLayer } from "../lib/escLayers";

export const QUEUE_EVENT = "rustify:open-queue";

function totalRemaining(): string {
  const upcoming = player.queue.slice(player.queueIndex + 1);
  const ms = upcoming.reduce((acc, t) => acc + (t.duration_ms ?? 0), 0);
  if (!ms) return "0:00";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function QueueDrawer() {
  const [open, setOpen] = createSignal(false);

  onMount(() => {
    const onOpenEvt = (e: Event) => {
      const want = (e as CustomEvent<{ open?: boolean } | null>).detail?.open;
      setOpen((v) => (typeof want === "boolean" ? want : !v));
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingContext(e)) return;
      if (
        e.key.toLowerCase() === "q" && !e.ctrlKey && !e.metaKey && !e.altKey
      ) { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener(QUEUE_EVENT, onOpenEvt);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener(QUEUE_EVENT, onOpenEvt);
      window.removeEventListener("keydown", onKey);
    });
  });

  // Esc fecha a gaveta pela pilha única (lib/escLayers): o menu de contexto
  // aberto por cima fecha antes, e o App não sai do cinema no mesmo toque.
  createEffect(() => {
    if (!open()) return;
    onCleanup(pushEscLayer(() => setOpen(false)));
  });

  const upcoming = () => player.queue.slice(player.queueIndex + 1);

  return (
    <>
      <div class="queue-scrim" data-open={open() ? "true" : "false"} onClick={() => setOpen(false)} />
      <aside class="queue-drawer" data-open={open() ? "true" : "false"} data-screen-label="Queue">
        <div class="queue-drawer__head">
          <div>
            <h3 class="queue-drawer__title">Queue</h3>
            <div class="queue-drawer__meta">
              {upcoming().length} tracks · {totalRemaining()} remaining
            </div>
          </div>
          <button class="queue-drawer__close" title="Close (Esc)" onClick={() => setOpen(false)}>
            <Icon name={ICONS.close} size={12} />
          </button>
        </div>

        <div class="queue-drawer__body">
          <Show when={player.currentTrack}>
            {(t) => (
              <>
                <div class="queue-drawer__section-label"><span>Now playing</span></div>
                <TrackRowList track={t()} onClick={() => playTrack(t())} size="compact" />
              </>
            )}
          </Show>

          <Show when={upcoming().length > 0}>
            <div class="queue-drawer__section-label">
              <span>Up next · {upcoming().length}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // Mantem a track atual tocando, descarta o resto da fila.
                  if (player.currentTrack) setQueue([player.currentTrack], 0);
                }}
              >
                Clear
              </button>
            </div>
            <For each={upcoming()}>
              {(track) => <TrackRowList track={track} onClick={() => playQueueUpcoming(track)} size="compact" />}
            </For>
          </Show>

          <Show when={upcoming().length === 0 && !player.currentTrack}>
            <div class="empty-state">
              <p class="empty-state__title">Fila vazia</p>
              <p class="empty-state__hint">Toque algo pra começar.</p>
            </div>
          </Show>
        </div>
      </aside>
    </>
  );
}
