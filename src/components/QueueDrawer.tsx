/* ============================================================
   components/QueueDrawer.tsx — Right-side slide-over showing
   the live queue + recently played history.

   Reactive to player.queue, player.queueIndex.
   Opens on Q key or 'rustify:open-queue' custom event.
   ============================================================ */

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon, ICONS } from "./Icon";
import { CoverArt } from "./CoverArt";
import { player } from "../store/player";
import { coverUrl, type Track } from "../tauri";
import { playTrack } from "./PlayerBar";

export const QUEUE_EVENT = "rustify:open-queue";

function fmtDur(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

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
    const onOpenEvt = () => setOpen((v) => !v);
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "Escape" && open()) { e.preventDefault(); setOpen(false); }
      else if (e.key.toLowerCase() === "q") { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener(QUEUE_EVENT, onOpenEvt);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener(QUEUE_EVENT, onOpenEvt);
      window.removeEventListener("keydown", onKey);
    });
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
                <QRow track={t()} current />
              </>
            )}
          </Show>

          <Show when={upcoming().length > 0}>
            <div class="queue-drawer__section-label">
              <span>Up next · {upcoming().length}</span>
              <button>Clear</button>
            </div>
            <For each={upcoming()}>
              {(track) => <QRow track={track} />}
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

function QRow(props: { track: Track; current?: boolean }) {
  return (
    <div
      class={`qrow${props.current ? " qrow--current" : ""}`}
      onClick={() => playTrack(props.track)}
    >
      <CoverArt
        seed={props.track.album_title || props.track.id}
        src={coverUrl(props.track.album_cover_path)}
        size="sm"
        class="qrow__cover"
        style={{ width: "36px", height: "36px" }}
      />
      <div class="qrow__meta">
        <div class="qrow__title">{props.track.title || "—"}</div>
        <div class="qrow__sub">
          {props.track.artist_name || "—"}
          {props.track.album_title && <> · {props.track.album_title}</>}
        </div>
      </div>
      <div class="qrow__time">{fmtDur(props.track.duration_ms)}</div>
    </div>
  );
}
