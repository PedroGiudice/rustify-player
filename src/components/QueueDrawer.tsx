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
import { player, setQueue, moveUpcoming, removeUpcoming } from "../store/player";
import { dropIndex, shiftFor } from "../lib/queueDrag";
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

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Duração do assentamento (FLIP) e da saída de uma linha. */
const SETTLE_MS = 240;
const LEAVE_MS = 180;

/**
 * FLIP: mede onde cada linha está, aplica a mudança na fila e anima cada
 * linha da posição antiga até a nova. O For do Solid reaproveita o mesmo nó
 * para o mesmo objeto de faixa, então a linha é a mesma antes e depois.
 * O rect inclui o transform corrente: a linha arrastada assenta de onde foi solta.
 */
function flip(list: HTMLElement | undefined, mutate: () => void) {
  if (!list || reducedMotion()) { mutate(); return; }
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".qrow"));
  const before = new Map(rows.map((el) => [el, el.getBoundingClientRect().top]));
  for (const el of rows) { el.style.transition = "none"; el.style.transform = ""; }
  mutate();
  for (const el of list.querySelectorAll<HTMLElement>(".qrow")) {
    const top0 = before.get(el);
    el.style.transition = "";
    if (top0 === undefined) continue;
    const dy = top0 - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    el.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
      { duration: SETTLE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }
}

export function QueueDrawer() {
  let listEl: HTMLDivElement | undefined;
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

  // ── Editar a fila: arrastar, tirar, Alt+setas ───────────────────
  const rowsOf = () => Array.from(listEl?.querySelectorAll<HTMLElement>(".qrow") ?? []);
  const focusGrip = (i: number) =>
    requestAnimationFrame(() => rowsOf()[i]?.querySelector<HTMLElement>(".qrow__grip")?.focus());

  function moveTo(from: number, to: number) {
    flip(listEl, () => moveUpcoming(from, to));
    focusGrip(to);
  }

  function removeAt(i: number) {
    const row = rowsOf()[i];
    const done = () => flip(listEl, () => removeUpcoming(i));
    if (!row || reducedMotion()) { done(); return; }
    row.style.pointerEvents = "none";
    row.animate(
      [{ transform: "translateX(0)", opacity: 1 }, { transform: "translateX(24px)", opacity: 0 }],
      { duration: LEAVE_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    ).onfinish = () => {
      row.getAnimations().forEach((a) => a.cancel());
      row.style.pointerEvents = "";
      done();
    };
  }

  function onGripKey(e: KeyboardEvent, i: number) {
    const n = upcoming().length;
    if (e.altKey && e.key === "ArrowUp" && i > 0) { e.preventDefault(); moveTo(i, i - 1); }
    else if (e.altKey && e.key === "ArrowDown" && i < n - 1) { e.preventDefault(); moveTo(i, i + 1); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeAt(i); focusGrip(Math.min(i, n - 2)); }
  }

  /** Arraste pela alça: a linha segue o ponteiro 1:1 e as vizinhas abrem espaço. */
  function startDrag(e: PointerEvent, from: number) {
    if (e.button !== 0) return;
    const grip = e.currentTarget as HTMLElement;
    const rows = rowsOf();
    const row = rows[from];
    if (!row) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const rowH = row.getBoundingClientRect().height;
    const y0 = e.clientY;
    let to = from;
    listEl!.dataset.dragging = "true";
    row.classList.add("qrow--lifted");

    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      row.style.transform = `translateY(${dy}px)`;
      const next = dropIndex(from, dy, rowH, rows.length);
      if (next === to) return;
      to = next;
      rows.forEach((el, k) => {
        if (k === from) return;
        const shift = shiftFor(k, from, to, rowH);
        el.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };
    const finish = (ev: PointerEvent) => {
      grip.releasePointerCapture(ev.pointerId);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", finish);
      grip.removeEventListener("pointercancel", cancel);
      row.classList.remove("qrow--lifted");
      delete listEl!.dataset.dragging;
      flip(listEl, () => moveUpcoming(from, to));
    };
    const cancel = (ev: PointerEvent) => { to = from; finish(ev); };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", finish);
    grip.addEventListener("pointercancel", cancel);
  }

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
            <div class="qlist" ref={listEl}>
              <For each={upcoming()}>
                {(track, i) => (
                  <div class="qrow">
                    <button
                      class="qrow__grip"
                      aria-label={`Mover ${track.title ?? "faixa"} na fila`}
                      title="Arrastar para reordenar (Alt+↑/↓; Delete tira)"
                      onPointerDown={(e) => startDrag(e, i())}
                      onKeyDown={(e) => onGripKey(e, i())}
                    >
                      <Icon name={ICONS.grip} size={14} />
                    </button>
                    <div class="qrow__track">
                      <TrackRowList track={track} onClick={() => playQueueUpcoming(track)} size="compact" />
                    </div>
                    <button
                      class="qrow__remove"
                      aria-label={`Tirar ${track.title ?? "faixa"} da fila`}
                      title="Tirar da fila"
                      onClick={(e) => { e.stopPropagation(); removeAt(i()); }}
                    >
                      <Icon name={ICONS.close} size={12} />
                    </button>
                  </div>
                )}
              </For>
            </div>
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
