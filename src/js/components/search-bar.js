// Global search bar — lives in the titlebar center area.
// Adapts backend and display based on active route.
//
// Context modes:
//   "global"   — IPC lib_search, shows dropdown with tracks/albums/artists sections
//   "playlist" — IPC lib_search_playlists, shows dropdown with folder groups
//   "filter"   — client-side, dispatches search-filter event for active view to handle
//   "none"     — search hidden (settings, signal, now-playing)

import { playTrack, setQueue } from "./player-bar.js";
import { navigate } from "../router.js";
import { formatMs } from "../utils/format.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

const ROUTE_CONTEXT = {
  "/home":        "global",
  "/tracks":      "global",
  "/artists":     "global",
  "/albums":      "global",
  "/playlists":   "playlist",
  "/stations":    "filter",
  "/queue":       "filter",
  "/history":     "filter",
  "/library":     "filter",
  "/now-playing": "none",
  "/signal":      "none",
  "/settings":    "none",
};

const PLACEHOLDERS = {
  global:   "Search tracks, albums, artists…",
  playlist: "Search playlists…",
  filter:   "Filter…",
  none:     "",
};

let currentContext = "global";
let debounceTimer = null;
let ui = {};
let isOpen = false;

export function mountSearchBar(container) {
  container.innerHTML = `
    <div class="search-bar" id="search-bar">
      <button class="search-bar__trigger" id="search-trigger" aria-label="Search (Ctrl+K)">
        <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-search"></use></svg>
        <span class="search-bar__hint">Ctrl+K</span>
      </button>
      <div class="search-bar__input-wrap" id="search-wrap" hidden>
        <svg class="icon icon--sm search-bar__icon" aria-hidden="true"><use href="#icon-search"></use></svg>
        <input class="search-bar__input" id="search-input"
               type="text" autocomplete="off" spellcheck="false" />
        <kbd class="search-bar__kbd">Esc</kbd>
      </div>
      <div class="search-bar__dropdown" id="search-dropdown" hidden></div>
    </div>
  `;

  ui = {
    bar: container.querySelector("#search-bar"),
    trigger: container.querySelector("#search-trigger"),
    wrap: container.querySelector("#search-wrap"),
    input: container.querySelector("#search-input"),
    dropdown: container.querySelector("#search-dropdown"),
  };

  ui.input.placeholder = PLACEHOLDERS[currentContext];

  // Open search
  ui.trigger.addEventListener("click", () => openSearch());

  // Input handling
  ui.input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = ui.input.value.trim();
    if (!q) {
      closeDropdown();
      if (currentContext === "filter") {
        window.dispatchEvent(new CustomEvent("search-filter", { detail: { query: "" } }));
      }
      return;
    }
    debounceTimer = setTimeout(() => handleQuery(q), 250);
  });

  // Escape to close
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSearch();
      e.stopPropagation();
    }
  });

  // Click outside closes dropdown
  document.addEventListener("click", (e) => {
    if (isOpen && !ui.bar.contains(e.target)) {
      closeSearch();
    }
  });

  // Ctrl+K shortcut
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      if (currentContext !== "none") openSearch();
    }
  });

  // Route changes
  window.addEventListener("route-changed", (e) => {
    const path = e.detail?.path || "/home";
    currentContext = ROUTE_CONTEXT[path] || "global";
    ui.input.placeholder = PLACEHOLDERS[currentContext];

    if (currentContext === "none") {
      ui.trigger.hidden = true;
      closeSearch();
    } else {
      ui.trigger.hidden = false;
    }

    // Clear on route change
    ui.input.value = "";
    closeDropdown();
  });

  // Dropdown click delegation
  ui.dropdown.addEventListener("click", (e) => {
    const trackItem = e.target.closest("[data-track-id]");
    if (trackItem) {
      const trackData = JSON.parse(trackItem.dataset.trackJson);
      setQueue([trackData], 0);
      playTrack(trackData);
      closeSearch();
      return;
    }

    const albumItem = e.target.closest("[data-album-id]");
    if (albumItem) {
      navigate(`/album/${albumItem.dataset.albumId}`);
      closeSearch();
      return;
    }

    const artistItem = e.target.closest("[data-artist-id]");
    if (artistItem) {
      navigate(`/artist/${artistItem.dataset.artistId}`);
      closeSearch();
      return;
    }

    const folderItem = e.target.closest("[data-folder]");
    if (folderItem) {
      // Navigate to playlists — the folder click is handled by playlists view
      navigate("/playlists");
      closeSearch();
      return;
    }
  });
}

function openSearch() {
  ui.trigger.hidden = true;
  ui.wrap.hidden = false;
  ui.input.focus();
  isOpen = true;
}

function closeSearch() {
  ui.wrap.hidden = true;
  ui.trigger.hidden = currentContext === "none";
  ui.input.value = "";
  closeDropdown();
  isOpen = false;
}

function closeDropdown() {
  ui.dropdown.hidden = true;
  ui.dropdown.innerHTML = "";
}

async function handleQuery(q) {
  if (currentContext === "filter") {
    window.dispatchEvent(new CustomEvent("search-filter", { detail: { query: q } }));
    return;
  }

  if (currentContext === "global") {
    try {
      const [results, semantic] = await Promise.all([
        invoke("lib_search", { query: q, limit: 8 }),
        invoke("lib_semantic_search", { query: q, limit: 5 }).catch(() => []),
      ]);
      renderGlobalResults(results, semantic);
    } catch (err) {
      console.error("[search] global search failed:", err);
      renderError(err);
    }
    return;
  }

  if (currentContext === "playlist") {
    try {
      const results = await invoke("lib_search_playlists", { query: q, limit: 10 });
      renderPlaylistResults(results);
    } catch (err) {
      console.error("[search] playlist search failed:", err);
      renderError(err);
    }
    return;
  }
}

function renderGlobalResults(results, semantic = []) {
  const { tracks, albums, artists } = results;

  if (!tracks.length && !albums.length && !artists.length && !semantic.length) {
    ui.dropdown.innerHTML = `<div class="search-empty">No results</div>`;
    ui.dropdown.hidden = false;
    return;
  }

  let html = "";

  if (tracks.length > 0) {
    html += `<div class="search-section">
      <div class="search-section__label">Tracks</div>
      ${tracks.map((t) => `
        <div class="search-item" data-track-id="${t.id}" data-track-json='${escJson(t)}'>
          <div class="search-item__cover">${t.album_cover_path ? `<img src="${convertFileSrc(t.album_cover_path)}" alt="">` : ""}</div>
          <div class="search-item__meta">
            <div class="search-item__title">${esc(t.title)}</div>
            <div class="search-item__sub">${esc(t.artist_name || "—")} &middot; ${formatMs(t.duration_ms)}</div>
          </div>
        </div>
      `).join("")}
    </div>`;
  }

  if (albums.length > 0) {
    html += `<div class="search-section">
      <div class="search-section__label">Albums</div>
      ${albums.map((a) => `
        <div class="search-item" data-album-id="${a.id}">
          <div class="search-item__cover">${a.cover_path ? `<img src="${convertFileSrc(a.cover_path)}" alt="">` : ""}</div>
          <div class="search-item__meta">
            <div class="search-item__title">${esc(a.title)}</div>
            <div class="search-item__sub">${esc(a.album_artist_name || "—")}</div>
          </div>
        </div>
      `).join("")}
    </div>`;
  }

  if (artists.length > 0) {
    html += `<div class="search-section">
      <div class="search-section__label">Artists</div>
      ${artists.map((a) => `
        <div class="search-item" data-artist-id="${a.id}">
          <div class="search-item__meta">
            <div class="search-item__title">${esc(a.name)}</div>
          </div>
        </div>
      `).join("")}
    </div>`;
  }

  if (semantic.length > 0) {
    // Deduplicate: remove tracks already shown in textual results
    const textIds = new Set(tracks.map((t) => t.id));
    const unique = semantic.filter((t) => !textIds.has(t.id));
    if (unique.length > 0) {
      html += `<div class="search-section search-section--semantic">
        <div class="search-section__label">By Lyrics</div>
        ${unique.map((t) => `
          <div class="search-item" data-track-id="${t.id}" data-track-json='${escJson(t)}'>
            <div class="search-item__cover">${t.album_cover_path ? `<img src="${convertFileSrc(t.album_cover_path)}" alt="">` : ""}</div>
            <div class="search-item__meta">
              <div class="search-item__title">${esc(t.title)}</div>
              <div class="search-item__sub">${esc(t.artist_name || "—")} &middot; ${formatMs(t.duration_ms)}</div>
            </div>
          </div>
        `).join("")}
      </div>`;
    }
  }

  ui.dropdown.innerHTML = html;
  ui.dropdown.hidden = false;
}

function renderPlaylistResults(results) {
  if (!results.length) {
    ui.dropdown.innerHTML = `<div class="search-empty">No matching playlists</div>`;
    ui.dropdown.hidden = false;
    return;
  }

  const html = results.map((r) => `
    <div class="search-section">
      <div class="search-section__label" data-folder="${escAttr(r.folder)}">${esc(r.folder || "Unsorted")}</div>
      ${r.tracks.slice(0, 3).map((t) => `
        <div class="search-item" data-track-id="${t.id}" data-track-json='${escJson(t)}'>
          <div class="search-item__meta">
            <div class="search-item__title">${esc(t.title)}</div>
            <div class="search-item__sub">${esc(t.artist_name || "—")}</div>
          </div>
        </div>
      `).join("")}
      ${r.tracks.length > 3 ? `<div class="search-item__more">+${r.tracks.length - 3} more</div>` : ""}
    </div>
  `).join("");

  ui.dropdown.innerHTML = html;
  ui.dropdown.hidden = false;
}

function renderError(err) {
  ui.dropdown.innerHTML = `<div class="search-empty">Search failed: ${esc(String(err))}</div>`;
  ui.dropdown.hidden = false;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escJson(obj) {
  return JSON.stringify(obj).replace(/'/g, "&#39;").replace(/</g, "&lt;");
}
