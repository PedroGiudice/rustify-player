# Global Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global search bar in the titlebar that adapts its backend and display based on the active route. Replaces per-view search inputs in tracks, albums, and artists views.

**Architecture:** New `search-bar.js` component mounted in the titlebar center area. Listens to `route-changed` events to switch context (IPC vs client-side filter, placeholder text). Dropdown results panel positioned below titlebar. Ctrl+K shortcut to focus. Views that need client-side filtering dispatch a `search-filter` custom event that the active view listens to.

**Tech Stack:** Vanilla JS, CSS, Tauri IPC (`invoke`), custom events.

---

### Task 1: Add search icon to SVG sprite

**Files:**
- Modify: `src/assets/icons.svg` (add `icon-search` symbol)

- [ ] **Step 1: Add search icon**

Add this symbol to `src/assets/icons.svg` before the closing `</svg>`. From Lucide:

```xml
<symbol id="icon-search" viewBox="0 0 24 24">
  <circle cx="11" cy="11" r="8"></circle>
  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
</symbol>
```

- [ ] **Step 2: Commit**

```bash
git add src/assets/icons.svg
git commit -m "feat(icons): add search icon"
```

---

### Task 2: Create search-bar.js component

**Files:**
- Create: `src/js/components/search-bar.js`

- [ ] **Step 1: Create the search bar component**

Create `src/js/components/search-bar.js`:

```javascript
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
      const results = await invoke("lib_search", { query: q, limit: 8 });
      renderGlobalResults(results);
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

function renderGlobalResults(results) {
  const { tracks, albums, artists } = results;

  if (!tracks.length && !albums.length && !artists.length) {
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
```

- [ ] **Step 2: Commit**

```bash
git add src/js/components/search-bar.js
git commit -m "feat(search): create global search bar component"
```

---

### Task 3: Add search bar CSS

**Files:**
- Modify: `src/styles/components.css` (append search bar styles)

- [ ] **Step 1: Add CSS**

Append to `src/styles/components.css`:

```css
/* ===== Search bar (titlebar) ===== */
.search-bar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}

.search-bar__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 22px;
  padding: 0 var(--space-3);
  background: color-mix(in srgb, var(--surface-container-low) 80%, transparent);
  border: 1px solid var(--divider);
  color: var(--on-surface-mute);
  font-size: var(--text-label-xs);
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}

.search-bar__trigger:hover {
  color: var(--on-surface-variant);
  border-color: var(--divider-hi);
}

.search-bar__hint {
  font-size: var(--text-label-xs);
  font-family: var(--font-mono);
  color: var(--on-surface-mute);
  letter-spacing: 0.02em;
}

.search-bar__input-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 24px;
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--divider-hi);
  min-width: 280px;
}

.search-bar__icon {
  color: var(--on-surface-mute);
  flex-shrink: 0;
}

.search-bar__input {
  background: transparent;
  border: none;
  outline: none;
  color: var(--on-surface);
  font-family: var(--font-body);
  font-size: var(--text-body-sm);
  width: 100%;
}

.search-bar__input::placeholder {
  color: var(--on-surface-mute);
}

.search-bar__kbd {
  font-family: var(--font-mono);
  font-size: var(--text-label-xs);
  color: var(--on-surface-mute);
  padding: 1px 4px;
  border: 1px solid var(--divider);
  flex-shrink: 0;
}

.search-bar__dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  width: 400px;
  max-height: 420px;
  overflow-y: auto;
  background: var(--surface-container);
  border: 1px solid var(--divider-hi);
  z-index: 100;
  scrollbar-width: thin;
}

.search-section {
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--divider);
}

.search-section:last-child {
  border-bottom: none;
}

.search-section__label {
  padding: var(--space-1) var(--space-4);
  font-size: var(--text-label-sm);
  font-weight: var(--fw-medium);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--on-surface-mute);
}

.search-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  transition: background var(--dur-fast);
}

.search-item:hover {
  background: var(--surface-container-high);
}

.search-item__cover {
  width: 32px;
  height: 32px;
  background: var(--surface-container-high);
  flex-shrink: 0;
}

.search-item__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.search-item__meta {
  min-width: 0;
  flex: 1;
}

.search-item__title {
  font-size: var(--text-body-sm);
  color: var(--on-surface);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-item__sub {
  font-size: var(--text-label-sm);
  color: var(--on-surface-mute);
}

.search-item__more {
  padding: var(--space-1) var(--space-4);
  font-size: var(--text-label-sm);
  color: var(--on-surface-mute);
  font-style: italic;
}

.search-empty {
  padding: var(--space-4);
  text-align: center;
  font-size: var(--text-body-sm);
  color: var(--on-surface-mute);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles/components.css
git commit -m "feat(search): add search bar CSS styles"
```

---

### Task 4: Mount search bar in titlebar and update main.js

**Files:**
- Modify: `src/index.html` (replace titlebar center content)
- Modify: `src/main.js` (import and mount search bar)

- [ ] **Step 1: Update titlebar center in index.html**

In `src/index.html`, replace the titlebar center div:

```html
      <div class="titlebar__center" data-tauri-drag-region>
        <span class="titlebar__title">Kinetic <b>Vault</b></span>
      </div>
```

With:

```html
      <div class="titlebar__center" id="titlebar-center"></div>
```

- [ ] **Step 2: Update main.js to mount search bar**

In `src/main.js`, add the import at the top:

```javascript
import { mountSearchBar } from "./js/components/search-bar.js";
```

In the `boot()` function, after `mountResources();` and before the RES button wiring, add:

```javascript
  // 4b. Mount search bar in titlebar
  const titlebarCenter = document.getElementById("titlebar-center");
  if (titlebarCenter) mountSearchBar(titlebarCenter);
```

- [ ] **Step 3: Commit**

```bash
git add src/index.html src/main.js
git commit -m "feat(search): mount global search bar in titlebar"
```

---

### Task 5: Remove per-view search inputs and add filter listeners

**Files:**
- Modify: `src/js/views/tracks.js` (remove search input, add filter listener)
- Modify: `src/js/views/albums.js` (remove search input, add filter listener)
- Modify: `src/js/views/artists.js` (remove search input, add filter listener)

- [ ] **Step 1: Update tracks.js**

In `src/js/views/tracks.js`:

1. Remove the search input from the HTML template. Delete:
```html
      <div class="view__toolbar">
        <input type="search" class="search-input" id="tr-search" placeholder="Search title, artist, album…" autocomplete="off" spellcheck="false" />
      </div>
```

2. Remove the `const search = view.querySelector("#tr-search");` line.

3. Remove the `search.addEventListener("input", ...)` block entirely.

4. After the `tbody.addEventListener("contextmenu", ...)` block, add a listener for the global search filter event:

```javascript
    const filterHandler = (e) => {
      const q = (e.detail?.query || "").toLowerCase();
      if (!q) {
        renderRows(tbody, tracks);
        return;
      }
      const filtered = tracks.filter((t) => {
        const hay = `${t.title} ${t.artist_name || ""} ${t.album_title || ""}`.toLowerCase();
        return hay.includes(q);
      });
      renderRows(tbody, filtered);
    };
    window.addEventListener("search-filter", filterHandler);

    // Cleanup on route change
    const cleanup = () => {
      window.removeEventListener("search-filter", filterHandler);
      window.removeEventListener("route-changed", cleanup);
    };
    window.addEventListener("route-changed", cleanup, { once: true });
```

- [ ] **Step 2: Update albums.js**

In `src/js/views/albums.js`:

1. Remove the search input HTML: `<input class="search-input" id="al-search" ...>`
2. Remove the `querySelector("#al-search")` and its event listener.
3. Add a `search-filter` event listener that filters the album cards by name, similar to tracks. The exact implementation depends on the albums view structure — filter by hiding/showing cards:

```javascript
    const filterHandler = (e) => {
      const q = (e.detail?.query || "").toLowerCase();
      const cards = body.querySelectorAll(".card");
      cards.forEach((card) => {
        const label = card.querySelector(".card__label");
        const sub = card.querySelector(".card__sub");
        const text = `${label?.textContent || ""} ${sub?.textContent || ""}`.toLowerCase();
        card.style.display = !q || text.includes(q) ? "" : "none";
      });
    };
    window.addEventListener("search-filter", filterHandler);
    const cleanup = () => {
      window.removeEventListener("search-filter", filterHandler);
      window.removeEventListener("route-changed", cleanup);
    };
    window.addEventListener("route-changed", cleanup, { once: true });
```

- [ ] **Step 3: Update artists.js**

Same pattern as albums — remove `#ar-search` input and its listener, add `search-filter` event listener that hides/shows artist cards by name.

```javascript
    const filterHandler = (e) => {
      const q = (e.detail?.query || "").toLowerCase();
      const cards = body.querySelectorAll(".card");
      cards.forEach((card) => {
        const label = card.querySelector(".card__label");
        const text = (label?.textContent || "").toLowerCase();
        card.style.display = !q || text.includes(q) ? "" : "none";
      });
    };
    window.addEventListener("search-filter", filterHandler);
    const cleanup = () => {
      window.removeEventListener("search-filter", filterHandler);
      window.removeEventListener("route-changed", cleanup);
    };
    window.addEventListener("route-changed", cleanup, { once: true });
```

- [ ] **Step 4: Commit**

```bash
git add src/js/views/tracks.js src/js/views/albums.js src/js/views/artists.js
git commit -m "feat(search): remove per-view search, add global filter listeners"
```

---

### Task 6: Smoke test

**Files:** None (verification only)

- [ ] **Step 1: Verify search bar appears**

1. Titlebar should show search trigger button with "Ctrl+K" hint
2. Click it — input expands with placeholder
3. Press Ctrl+K from any view — input focuses

- [ ] **Step 2: Verify global search (tracks/albums/artists routes)**

1. Navigate to Tracks view, type in search bar
2. Dropdown should show tracks, albums, artists sections
3. Click a track — plays it
4. Click an album — navigates to album view
5. Press Esc — closes search

- [ ] **Step 3: Verify playlist search**

1. Navigate to Playlists view
2. Placeholder should change to "Search playlists..."
3. Type a query — dropdown shows folder groups with matching tracks
4. Results grouped by folder name

- [ ] **Step 4: Verify filter mode**

1. Navigate to Queue or History view
2. Placeholder should change to "Filter..."
3. Type — active view's table/list filters client-side
4. Clear input — shows all items again

- [ ] **Step 5: Verify hidden on certain routes**

1. Navigate to Signal or Settings
2. Search trigger should be hidden
3. Ctrl+K should do nothing

- [ ] **Step 6: Verify per-view search removal**

1. Navigate to Tracks — no local search input in view header
2. Navigate to Albums — no local search input
3. Navigate to Artists — no local search input
