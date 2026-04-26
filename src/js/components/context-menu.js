// Context menu — shared component for track rows and player bar.
// Shows actions: Play, Play Next, Add to Queue, Like/Unlike, Go to Album, Go to Artist.
// Positioned at cursor, dismissed on click-outside or Esc.

import { playTrack, setQueue, enqueueNext, enqueueEnd } from "./player-bar.js";
import { navigate } from "../router.js";

const { invoke } = window.__TAURI__.core;

let menuEl = null;
let cleanup = null;

function ensureDOM() {
  if (menuEl) return;
  menuEl = document.createElement("div");
  menuEl.className = "ctx-menu";
  menuEl.hidden = true;
  document.body.appendChild(menuEl);
}

function dismiss() {
  if (!menuEl) return;
  menuEl.hidden = true;
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}

/**
 * Show context menu for a track.
 * @param {MouseEvent} e - the contextmenu or click event
 * @param {object} track - Track object with id, path, title, artist_name, album_id, artist_id
 * @param {object[]} [tracks] - optional surrounding track list (for "Play" to set queue)
 * @param {number} [trackIndex] - index of the track in the list
 */
export function showTrackMenu(e, track, tracks, trackIndex) {
  e.preventDefault();
  e.stopPropagation();
  ensureDOM();

  const items = [
    { label: "Play", icon: "icon-play", action: () => {
      if (tracks && trackIndex != null) {
        setQueue(tracks, trackIndex);
      }
      playTrack(track);
    }},
    { label: "Play Next", icon: "icon-skip-next", action: () => {
      enqueueNext(track);
    }},
    { label: "Add to Queue", icon: "icon-queue-music", action: () => {
      enqueueEnd(track);
    }},
    { type: "separator" },
    { label: "Like", icon: "icon-flame", id: "ctx-like", action: async (itemEl) => {
      if (!track.id) return;
      const liked = await invoke("lib_toggle_like", { trackId: track.id });
      itemEl.querySelector(".ctx-menu__label").textContent = liked ? "Unlike" : "Like";
    }},
    { type: "separator" },
  ];

  if (track.album_id) {
    items.push({ label: "Go to Album", icon: "icon-album", action: () => {
      navigate(`/album/${track.album_id}`);
    }});
  }
  if (track.artist_id) {
    items.push({ label: "Go to Artist", icon: "icon-person", action: () => {
      navigate(`/artist/${track.artist_id}`);
    }});
  }

  renderMenu(items, e.clientX, e.clientY, track);
}

/**
 * Show context menu for the player bar (currently playing track).
 * @param {MouseEvent} e
 * @param {object} track
 */
export function showPlayerMenu(e, track) {
  e.preventDefault();
  e.stopPropagation();
  ensureDOM();

  const items = [];

  if (track.album_id) {
    items.push({ label: "Go to Album", icon: "icon-album", action: () => {
      navigate(`/album/${track.album_id}`);
    }});
  }
  if (track.artist_id) {
    items.push({ label: "Go to Artist", icon: "icon-person", action: () => {
      navigate(`/artist/${track.artist_id}`);
    }});
  }

  if (items.length === 0) return;

  renderMenu(items, e.clientX, e.clientY, track);
}

async function renderMenu(items, x, y, track) {
  // Pre-fetch like state for the like item
  let isLiked = false;
  if (track.id) {
    try {
      isLiked = await invoke("lib_is_liked", { trackId: track.id });
    } catch (_) {}
  }

  menuEl.innerHTML = items
    .map((item, i) => {
      if (item.type === "separator") {
        return `<div class="ctx-menu__sep"></div>`;
      }
      const likeLabel = item.id === "ctx-like" ? (isLiked ? "Unlike" : "Like") : item.label;
      return `
        <button class="ctx-menu__item" data-idx="${i}">
          <svg class="icon icon--sm" aria-hidden="true"><use href="#${item.icon}"></use></svg>
          <span class="ctx-menu__label">${likeLabel}</span>
        </button>`;
    })
    .join("");

  // Position: keep within viewport
  menuEl.hidden = false;
  const rect = menuEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + rect.width > vw ? vw - rect.width - 8 : x;
  const top = y + rect.height > vh ? vh - rect.height - 8 : y;
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;

  // Bind click on items
  const onClick = (ev) => {
    const btn = ev.target.closest(".ctx-menu__item");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    const item = items[idx];
    if (item && item.action) {
      item.action(btn);
    }
    // Dismiss unless it's the like toggle (keep menu open for feedback)
    if (!item || item.id !== "ctx-like") {
      dismiss();
    }
  };
  menuEl.addEventListener("click", onClick);

  // Dismiss on click-outside or Esc
  const onClickOutside = (ev) => {
    if (!menuEl.contains(ev.target)) dismiss();
  };
  const onKeydown = (ev) => {
    if (ev.key === "Escape") dismiss();
  };

  // Delay to avoid the triggering click from immediately closing
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onClickOutside, { capture: true });
    document.addEventListener("keydown", onKeydown);
  });

  cleanup = () => {
    menuEl.removeEventListener("click", onClick);
    document.removeEventListener("pointerdown", onClickOutside, { capture: true });
    document.removeEventListener("keydown", onKeydown);
  };
}
