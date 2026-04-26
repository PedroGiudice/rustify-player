# Stations View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Stations view (`#/stations`) that displays AI-generated mood playlists as a card grid with per-station accent colors, and a detail view showing tracks in a table.

**Architecture:** New view file `stations.js` ported from preview HTML. Responsive card grid with inline `--station-color` CSS custom properties for per-card accent. Two view modes (list/detail) managed via local state object. New CSS classes in `components.css`. New sidebar item. New SVG icon in sprite.

**Tech Stack:** Vanilla JS (ES modules), CSS custom properties, Tauri IPC (`invoke`).

**Reference:** `~/Downloads/rustify-stations-preview.html` — approved layout, state pattern, event delegation.

---

### Task 1: Add radio icon to SVG sprite

**Files:**
- Modify: `src/assets/icons.svg` (add new `<symbol>`)

- [ ] **Step 1: Add radio icon symbol**

Add this symbol to `src/assets/icons.svg` before the closing `</svg>` tag. This is from Lucide (Iconify set `lucide:radio`):

```xml
<symbol id="icon-radio" viewBox="0 0 24 24">
  <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
  <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
  <circle cx="12" cy="12" r="2"></circle>
  <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
  <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>
</symbol>
```

- [ ] **Step 2: Verify icon renders**

Open the app or check the sprite file loads correctly. The icon should be usable as `<use href="#icon-radio">`.

- [ ] **Step 3: Commit**

```bash
git add src/assets/icons.svg
git commit -m "feat(icons): add radio icon for stations view"
```

---

### Task 2: Add Stations CSS to components.css

**Files:**
- Modify: `src/styles/components.css` (append station classes at end)

- [ ] **Step 1: Add station CSS classes**

Append the following to the end of `src/styles/components.css`:

```css
/* ===== Stations ===== */
.station-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
}

.station-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  background: linear-gradient(135deg, var(--station-color, transparent) 8%, var(--surface-container) 60%);
  border: 1px solid var(--divider);
  border-left: 3px solid var(--station-color, var(--primary));
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-standard);
}

.station-card:hover {
  border-color: color-mix(in srgb, var(--station-color, var(--primary)) 50%, transparent);
  border-left-color: var(--station-color, var(--primary));
}

.station-card__info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.station-card__title {
  font-family: var(--font-display);
  font-size: var(--text-headline-lg);
  font-weight: var(--fw-regular);
  color: var(--on-surface);
  letter-spacing: var(--tracking-tighter);
}

.station-card__count {
  font-family: var(--font-body);
  font-size: var(--text-label-md);
  color: var(--on-surface-mute);
}

.station-card__play {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--station-color, var(--primary));
  color: var(--on-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: transform var(--dur-fast) var(--ease-standard),
              filter var(--dur-fast) var(--ease-standard);
}

.station-card__play .icon {
  transform: translateX(1px);
  fill: currentColor;
  stroke: none;
}

.station-card__play:hover {
  transform: scale(1.05);
  filter: brightness(1.1);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles/components.css
git commit -m "feat(css): add station card styles with accent color support"
```

---

### Task 3: Create stations.js view

**Files:**
- Create: `src/js/views/stations.js`

- [ ] **Step 1: Create the stations view file**

Create `src/js/views/stations.js` with the following content:

```javascript
import { playTrack, setQueue } from "../components/player-bar.js";
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
    e.preventDefault();
    invoke("player_enqueue_next", { path: row.dataset.path }).catch((err) =>
      console.error("[stations] enqueue failed:", err)
    );
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
        <td class="track-table__td track-table__td--num">${i + 1}</td>
        <td class="track-table__td track-table__td--title">${esc(t.title)}</td>
        <td class="track-table__td">${esc(t.artist_name || "—")}</td>
        <td class="track-table__td">${esc(t.album_title || "—")}</td>
        <td class="track-table__td track-table__td--dur">${formatMs(t.duration_ms)}</td>
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
            <th class="track-table__th track-table__th--num">#</th>
            <th class="track-table__th">Title</th>
            <th class="track-table__th">Artist</th>
            <th class="track-table__th">Album</th>
            <th class="track-table__th track-table__th--dur">Duration</th>
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
```

- [ ] **Step 2: Verify icon-chevron-left exists in sprite**

Check if `#icon-chevron-left` is in `src/assets/icons.svg`. If not, add:

```xml
<symbol id="icon-chevron-left" viewBox="0 0 24 24">
  <polyline points="15 18 9 12 15 6"></polyline>
</symbol>
```

- [ ] **Step 3: Commit**

```bash
git add src/js/views/stations.js src/assets/icons.svg
git commit -m "feat(stations): create stations view with card grid and detail mode"
```

---

### Task 4: Register route and sidebar item

**Files:**
- Modify: `src/js/router.js` (add `/stations` route)
- Modify: `src/js/components/sidebar.js` (add Stations nav item)

- [ ] **Step 1: Add route to router.js**

In `src/js/router.js`, add the stations route to the `routes` object, after the `/playlists` entry:

```javascript
"/stations": () => import("./views/stations.js"),
```

The routes object should now include:
```javascript
"/playlists":  () => import("./views/playlists.js"),
"/stations":   () => import("./views/stations.js"),
"/queue":      () => import("./views/queue.js"),
```

- [ ] **Step 2: Add sidebar item**

In `src/js/components/sidebar.js`, add a Stations entry to `NAV_ITEMS` between `playlists` and `queue`:

```javascript
{ route: "/stations",  icon: "radio",       label: "Stations" },
```

The array should now include:
```javascript
{ route: "/playlists", icon: "queue-music", label: "Playlists" },
{ route: "/stations",  icon: "radio",       label: "Stations" },
{ route: "/queue",     icon: "queue-music", label: "Queue" },
```

- [ ] **Step 3: Commit**

```bash
git add src/js/router.js src/js/components/sidebar.js
git commit -m "feat(stations): register route and add sidebar nav item"
```

---

### Task 5: Manual smoke test

**Files:** None (verification only)

- [ ] **Step 1: Build and run**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

If clean, run the app via `cargo tauri dev` or build with `./scripts/release.sh` depending on project workflow.

- [ ] **Step 2: Verify stations view**

1. Click "Stations" in sidebar — should show card grid with 8 stations
2. Each card should have colored left border, colored play button, and subtle gradient background matching its accent_color
3. Click a card — should show detail view with track table and back button
4. Click back button — returns to card grid
5. Click play button on a card — should shuffle and play station tracks
6. Click a track row in detail — should set queue and play

- [ ] **Step 3: Final commit (if any fixes needed)**

Fix any issues found during smoke test and commit.
