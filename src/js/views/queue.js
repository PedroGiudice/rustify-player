// Queue view — shows current playback queue.
import { playTrack, setQueue, getQueue } from "../components/player-bar.js";
import { formatMs } from "../utils/format.js";

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

function load(view) {
  const stats = view.querySelector("#q-stats");
  const body = view.querySelector("#q-body");

  const { tracks: queue, position } = getQueue();

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
    const isCurrent = position === i;
    const row = document.createElement("div");
    row.className = `queue-row${isCurrent ? " is-current" : ""}`;
    row.dataset.idx = i;
    row.innerHTML = `
      <div class="queue-row__handle">
        <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-drag"></use></svg>
      </div>
      <div class="queue-row__meta">
        <div class="queue-row__title">${esc(t.title || "—")}</div>
        <div class="queue-row__sub">${esc(t.artist_name || "—")} • ${esc(t.album_title || "")}</div>
      </div>
      <div class="queue-row__dur">${formatMs(t.duration_ms)}</div>
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
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
