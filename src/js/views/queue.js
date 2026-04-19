// Queue view — shows current playback queue with drag handle.
import { playTrack, setQueue } from "../components/player-bar.js";

const { invoke } = window.__TAURI__.core;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Queue</h1>
      <div class="view__stats" id="q-stats"></div>
    </header>
    <div class="view__body" id="q-body"><p class="empty-state__hint">Loading...</p></div>
  `;
  load(view);
  return view;
}

async function load(view) {
  const stats = view.querySelector("#q-stats");
  const body = view.querySelector("#q-body");

  try {
    const state = await invoke("get_state");
    const queue = state?.queue || [];

    stats.innerHTML = `<span>${queue.length} in queue</span>`;

    if (queue.length === 0) {
      body.innerHTML = `<div class="empty-state">
        <svg class="empty-state__icon" aria-hidden="true"><use href="#icon-queue-music"></use></svg>
        <p class="empty-state__title">Queue is empty</p>
        <p class="empty-state__hint">Play an album or track to build a queue</p>
      </div>`;
      return;
    }

    const list = document.createElement("div");
    list.className = "queue-list";

    queue.forEach((t, i) => {
      const isCurrent = state.queue_position === i;
      const row = document.createElement("div");
      row.className = `queue-row${isCurrent ? " is-current" : ""}`;
      row.dataset.idx = i;
      row.innerHTML = `
        <div class="queue-row__handle">
          <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-drag"></use></svg>
        </div>
        <div class="queue-row__meta">
          <div class="queue-row__title">${esc(t.title || "\u2014")}</div>
          <div class="queue-row__sub">${esc(t.artist_name || "\u2014")} \u2022 ${esc(t.album_title || "")}</div>
        </div>
        <div class="queue-row__dur">${fmtDur(t.duration_secs)}</div>
        <div></div>
      `;
      list.appendChild(row);
    });

    body.innerHTML = "";
    body.appendChild(list);

    list.addEventListener("click", (e) => {
      const row = e.target.closest(".queue-row");
      if (row) {
        const idx = Number(row.dataset.idx);
        setQueue(queue, idx);
        playTrack(queue[idx]);
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
  }
}

function fmtDur(secs) {
  if (!secs) return "\u2014";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
