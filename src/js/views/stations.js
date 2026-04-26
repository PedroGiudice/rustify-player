import { playTrack, setQueue } from "../components/player-bar.js";
import { showTrackMenu } from "../components/context-menu.js";
import { formatMs } from "../utils/format.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

const state = {
  viewMode: "list",
  stations: [],
  activeStation: null,
  tracks: [],
};

export function render() {
  const el = document.createElement("article");
  el.className = "view";

  el.addEventListener("click", async (e) => {
    const backBtn = e.target.closest(".js-back");
    if (backBtn) {
      state.viewMode = "list";
      state.activeStation = null;
      state.tracks = [];
      updateDOM(el);
      return;
    }

    const playBtn = e.target.closest(".station-card__play");
    if (playBtn) {
      e.stopPropagation();
      const card = playBtn.closest(".station-card");
      const id = Number(card.dataset.id);
      try {
        const tracks = await invoke("lib_list_mood_tracks", { moodId: id });
        if (tracks.length > 0) {
          // Shuffle
          for (let i = tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
          }
          setQueue(tracks, 0);
          playTrack(tracks[0]);
        }
      } catch (err) {
        console.error("[stations] play failed:", err);
      }
      return;
    }

    const card = e.target.closest(".station-card");
    if (card) {
      const id = Number(card.dataset.id);
      const station = state.stations.find((s) => s.id === id);
      if (station) {
        state.activeStation = station;
        state.viewMode = "detail";
        try {
          state.tracks = await invoke("lib_list_mood_tracks", { moodId: id });
        } catch (err) {
          console.error("[stations] load tracks failed:", err);
          state.tracks = [];
        }
        updateDOM(el);
      }
      return;
    }

    const moreBtn = e.target.closest(".more-btn");
    if (moreBtn) {
      const row = moreBtn.closest(".track-row");
      if (row) {
        const idx = state.tracks.findIndex((t) => t.id == row.dataset.trackId);
        if (idx >= 0) showTrackMenu(e, state.tracks[idx], state.tracks, idx);
      }
      return;
    }

    const trackRow = e.target.closest(".track-row");
    if (trackRow) {
      const idx = state.tracks.findIndex((t) => t.id == trackRow.dataset.trackId);
      if (idx >= 0) {
        setQueue(state.tracks, idx);
        playTrack(state.tracks[idx]);
      }
      return;
    }
  });

  el.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".track-row");
    if (!row) return;
    const idx = state.tracks.findIndex((t) => t.id == row.dataset.trackId);
    if (idx >= 0) showTrackMenu(e, state.tracks[idx], state.tracks, idx);
  });

  load(el);
  return el;
}

async function load(el) {
  try {
    state.stations = await invoke("lib_list_moods");
    state.viewMode = "list";
    state.activeStation = null;
    state.tracks = [];
    updateDOM(el);
  } catch (err) {
    el.innerHTML = `
      <div class="empty-state">
        <p class="empty-state__title">Failed to load stations</p>
        <p class="empty-state__hint">${esc(String(err))}</p>
      </div>
    `;
  }
}

function updateDOM(el) {
  if (state.viewMode === "list") {
    el.innerHTML = renderList();
  } else {
    el.innerHTML = renderDetail();
  }
}

function renderList() {
  const cards = state.stations
    .map((s) => {
      const color = s.accent_color || "";
      const style = color ? `style="--station-color: ${escAttr(color)}"` : "";
      return `
        <div class="station-card" data-id="${s.id}" ${style}>
          <div class="station-card__info">
            <div class="station-card__title">${esc(s.name)}</div>
            <div class="station-card__count">${s.track_count} tracks</div>
          </div>
          <button class="station-card__play" aria-label="Play ${esc(s.name)}">
            <svg class="icon icon--filled"><use href="#icon-play"></use></svg>
          </button>
        </div>
      `;
    })
    .join("");

  return `
    <header class="view__header">
      <h1 class="view__title">Stations</h1>
      <div class="view__stats">
        <span>${state.stations.length} stations</span>
        <span class="view__stats-sep">&bull;</span>
        <span>AI generated moods</span>
      </div>
    </header>
    <div class="view__body">
      <div class="station-grid">${cards}</div>
    </div>
  `;
}

function renderDetail() {
  const s = state.activeStation;
  const rows = state.tracks
    .map(
      (t, i) => `
      <tr class="track-row" data-track-id="${t.id}" data-path="${escAttr(t.path)}">
        <td class="track-table__td track-table__td--cover">${t.album_cover_path ? `<img src="${convertFileSrc(t.album_cover_path)}" loading="lazy" alt="">` : ""}</td>
        <td class="track-table__td track-table__td--num">${i + 1}</td>
        <td class="track-table__td track-table__td--title">${esc(t.title)}</td>
        <td class="track-table__td">${esc(t.artist_name || "—")}</td>
        <td class="track-table__td">${esc(t.album_title || "—")}</td>
        <td class="track-table__td track-table__td--dur">${formatMs(t.duration_ms)}</td>
        <td class="track-table__td track-table__td--more"><button class="more-btn" aria-label="More"><svg class="icon icon--sm"><use href="#icon-more-vertical"></use></svg></button></td>
      </tr>`
    )
    .join("");

  return `
    <header class="view__header">
      <div style="display:flex;align-items:center;gap:var(--space-3)">
        <button class="icon-btn js-back" aria-label="Back to stations">
          <svg class="icon"><use href="#icon-chevron-left"></use></svg>
        </button>
        <h1 class="view__title">${esc(s.name)}</h1>
      </div>
      <div class="view__stats">
        <span>${s.track_count} tracks</span>
        <span class="view__stats-sep">&bull;</span>
        <span>Station</span>
      </div>
    </header>
    <div class="view__body">
      <table class="track-table">
        <thead>
          <tr>
            <th class="track-table__th track-table__th--cover"></th>
            <th class="track-table__th track-table__th--num">#</th>
            <th class="track-table__th">Title</th>
            <th class="track-table__th">Artist</th>
            <th class="track-table__th">Album</th>
            <th class="track-table__th track-table__th--dur">Duration</th>
            <th class="track-table__th track-table__th--more"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
