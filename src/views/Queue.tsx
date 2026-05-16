/* ============================================================
   views/Queue.tsx — Full-page queue view (separate from the
   slide-over drawer). Useful for reorganizing long queues.
   ============================================================ */

import { For, Show } from "solid-js";
import { player } from "../store/player";
import { CoverArt } from "../components/CoverArt";
import { playTrack } from "../components/PlayerBar";
import { coverUrl, type Track } from "../tauri";

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function Queue() {
  const upcoming = () => player.queue.slice(player.queueIndex + 1);
  const past = () => player.queue.slice(0, player.queueIndex);

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Queue</h1>
          <p class="view__head-hint">
            {upcoming().length} tracks próximos · {past().length} já reproduzidos
          </p>
        </div>
      </header>

      <div class="view__body">
        <Show when={player.currentTrack}>
          {(t) => (
            <section>
              <div class="section__head"><h2 class="section__title">Now playing</h2></div>
              <QueueRow track={t()} current />
            </section>
          )}
        </Show>

        <Show when={upcoming().length > 0}>
          <section>
            <div class="section__head"><h2 class="section__title">Up next · {upcoming().length}</h2></div>
            <div class="row-list">
              <For each={upcoming()}>
                {(t) => <QueueRow track={t} />}
              </For>
            </div>
          </section>
        </Show>

        <Show when={past().length > 0}>
          <section>
            <div class="section__head"><h2 class="section__title">History · {past().length}</h2></div>
            <div class="row-list">
              <For each={past().slice().reverse()}>
                {(t) => <QueueRow track={t} muted />}
              </For>
            </div>
          </section>
        </Show>

        <Show when={!player.currentTrack && upcoming().length === 0}>
          <div class="empty-state">
            <p class="empty-state__title">Fila vazia</p>
            <p class="empty-state__hint">Toque algo da Library pra começar.</p>
          </div>
        </Show>
      </div>
    </article>
  );
}

function QueueRow(props: { track: Track; current?: boolean; muted?: boolean }) {
  return (
    <div
      class="row"
      style={{
        "grid-template-columns": "40px 1fr auto 60px",
        opacity: props.muted ? 0.55 : 1,
        background: props.current ? "var(--blue-bg)" : undefined,
      }}
      onClick={() => playTrack(props.track)}
    >
      <CoverArt
        seed={props.track.album_title || props.track.id}
        src={coverUrl(props.track.album_cover_path)}
        size="sm"
        class="row__cover"
        style={{ width: "40px", height: "40px" }}
      />
      <div class="row__meta">
        <div class="row__title" style={{ color: props.current ? "var(--blue-fg)" : undefined }}>
          {props.track.title || "—"}
        </div>
        <div class="row__sub">
          {props.track.artist_name || "—"}{props.track.album_title && <> · {props.track.album_title}</>}
        </div>
      </div>
      <div />
      <div class="row__time">{fmtDur(props.track.duration_ms)}</div>
    </div>
  );
}
