# Like / Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add like/favorites functionality with a pixel art flame icon toggle in the player bar, and a "Liked Songs" entry in the playlists view.

**Architecture:** Flame icon SVG added to sprite. Like button in player-bar left block (next to track meta). State synced via `lib_is_liked()` on track change and `lib_toggle_like()` on click. "Liked Songs" as special entry at top of playlists view using `lib_list_liked()`.

**Tech Stack:** Vanilla JS, CSS, Tauri IPC (`invoke`).

---

### Task 1: Add flame icon to SVG sprite

**Files:**
- Modify: `src/assets/icons.svg` (add `icon-flame` symbol)

- [ ] **Step 1: Add flame icon symbol**

Add this symbol to `src/assets/icons.svg` before the closing `</svg>` tag. This is a vectorized version of the `firemusic.jpg` pixel art (note+flame, 12x15 grid):

```xml
<symbol id="icon-flame" viewBox="0 0 12 15">
  <path d="M6,0h1v1h-1zM6,1h2v1h-2zM6,2h3v1h-3zM3,3h1v1h-1zM5,3h2v1h-2zM8,3h1v1h-1zM2,4h1v1h-1zM4,4h2v1h-2zM8,4h1v1h-1zM2,5h3v1h-3zM8,5h3v1h-3zM2,6h1v1h-1zM7,6h2v1h-2zM10,6h1v1h-1zM2,7h1v1h-1zM5,7h4v1h-4zM0,8h4v1h-4zM8,8h4v1h-4zM0,9h1v1h-1zM2,9h1v1h-1zM8,9h1v1h-1zM10,9h2v1h-2zM0,10h1v1h-1zM6,10h3v1h-3zM10,10h2v1h-2zM0,11h2v1h-2zM3,11h2v1h-2zM6,11h2v1h-2zM10,11h1v1h-1zM1,12h1v1h-1zM3,12h2v1h-2zM9,12h2v1h-2zM2,13h2v1h-2zM8,13h2v1h-2zM4,14h3v1h-3z" fill="currentColor"/>
</symbol>
```

- [ ] **Step 2: Commit**

```bash
git add src/assets/icons.svg
git commit -m "feat(icons): add pixel art flame icon for like/favorites"
```

---

### Task 2: Add like button to player bar

**Files:**
- Modify: `src/js/components/player-bar.js` (add like button + logic)
- Modify: `src/styles/components.css` (add like button styles)

- [ ] **Step 1: Add like button HTML in mountPlayerBar**

In `src/js/components/player-bar.js`, inside `mountPlayerBar()`, add a like button after the `player-bar__track-meta` div (inside `player-bar__block--left`). Change this section:

```javascript
      <div class="player-bar__track-meta">
        <span class="player-bar__track-label" id="pb-label">
          <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-music-note"></use></svg>
          No Track
        </span>
        <span class="player-bar__track-title" id="pb-title">—</span>
        <span class="player-bar__track-artist" id="pb-artist">—</span>
      </div>
```

To:

```javascript
      <div class="player-bar__track-meta">
        <span class="player-bar__track-label" id="pb-label">
          <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-music-note"></use></svg>
          No Track
        </span>
        <span class="player-bar__track-title" id="pb-title">—</span>
        <span class="player-bar__track-artist" id="pb-artist">—</span>
      </div>
      <button class="icon-btn like-btn" id="pb-like" aria-label="Like" aria-pressed="false" hidden>
        <svg class="icon" aria-hidden="true"><use href="#icon-flame"></use></svg>
      </button>
```

- [ ] **Step 2: Cache the like button in cacheUI**

In the `cacheUI` function, add:

```javascript
likeBtn: root.querySelector("#pb-like"),
```

- [ ] **Step 3: Add like button binding**

Add a new function `bindLike()` after `bindVolume()`:

```javascript
function bindLike() {
  ui.likeBtn.addEventListener("click", async () => {
    if (!currentTrack?.id) return;
    try {
      const liked = await invoke("lib_toggle_like", { trackId: currentTrack.id });
      updateLikeUI(liked);
    } catch (err) {
      console.error("[like] toggle failed:", err);
    }
  });
}
```

- [ ] **Step 4: Add updateLikeUI helper**

Add after `bindLike()`:

```javascript
function updateLikeUI(liked) {
  ui.likeBtn.setAttribute("aria-pressed", liked ? "true" : "false");
  ui.likeBtn.classList.toggle("is-liked", liked);
}
```

- [ ] **Step 5: Call bindLike in mountPlayerBar**

In `mountPlayerBar`, add `bindLike();` after `bindVolume();`:

```javascript
  cacheUI(root);
  bindTransport();
  bindSeek();
  bindVolume();
  bindLike();
  listenEngine();
```

- [ ] **Step 6: Sync like state on track change**

In the `playTrack` function, after `ui.artist.textContent = ...` and before the album cover loading, add:

```javascript
  // Sync like state
  if (track.id) {
    ui.likeBtn.hidden = false;
    invoke("lib_is_liked", { trackId: track.id })
      .then((liked) => updateLikeUI(liked))
      .catch(() => updateLikeUI(false));
  } else {
    ui.likeBtn.hidden = true;
    updateLikeUI(false);
  }
```

- [ ] **Step 7: Add CSS for like button**

Append to `src/styles/components.css` (player bar section):

```css
/* ===== Like button ===== */
.like-btn {
  flex-shrink: 0;
  color: var(--on-surface-mute);
  transition: color var(--dur-fast) var(--ease-standard),
              transform var(--dur-fast) var(--ease-standard);
}

.like-btn:hover {
  color: var(--on-surface-variant);
}

.like-btn.is-liked {
  color: var(--primary);
}

.like-btn.is-liked .icon {
  filter: drop-shadow(0 0 4px var(--primary));
}
```

- [ ] **Step 8: Commit**

```bash
git add src/js/components/player-bar.js src/styles/components.css
git commit -m "feat(like): add flame like toggle to player bar"
```

---

### Task 3: Add "Liked Songs" to playlists view

**Files:**
- Modify: `src/js/views/playlists.js` (add liked songs entry at top)

- [ ] **Step 1: Add liked songs entry in loadFolders**

In `src/js/views/playlists.js`, modify the `loadFolders` function. After the `stats.innerHTML = ...` line and before `body.innerHTML = ...`, fetch the liked count and prepend a special entry.

Replace the section that builds the folder list (from `body.innerHTML = ...` through the event listener) with:

```javascript
    // Fetch liked count
    let likedCount = 0;
    try {
      const liked = await invoke("lib_list_liked", { limit: 1 });
      // lib_list_liked returns array; use length as indicator, but we need total count
      // For now just check if any exist
      const allLiked = await invoke("lib_list_liked", {});
      likedCount = allLiked.length;
    } catch (_) {}

    body.innerHTML = `
      ${likedCount > 0 ? `
        <button class="folder-item folder-item--liked" id="pl-liked" type="button">
          <span class="folder-item__name">
            <svg class="icon icon--sm" aria-hidden="true" style="color:var(--primary)"><use href="#icon-flame"></use></svg>
            Liked Songs
          </span>
          <span class="folder-item__count">${likedCount} tracks</span>
        </button>
      ` : ""}
      <div class="folder-list" id="pl-folders"></div>
    `;

    // Liked songs click
    const likedBtn = body.querySelector("#pl-liked");
    if (likedBtn) {
      likedBtn.addEventListener("click", () => openLiked(view));
    }

    const list = body.querySelector("#pl-folders");
```

The rest of the folder rendering stays the same (list.innerHTML = folders.map...).

- [ ] **Step 2: Add openLiked function**

Add this function after `openFolder`:

```javascript
async function openLiked(view) {
  const stats = view.querySelector("#pl-stats");
  const body = view.querySelector("#pl-body");
  const title = view.querySelector(".view__title");

  title.textContent = "Liked Songs";
  stats.innerHTML = "";
  body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Loading...</p></div>`;

  let backBtn = title.querySelector("#pl-back");
  if (!backBtn) {
    backBtn = document.createElement("button");
    backBtn.id = "pl-back";
    backBtn.className = "view__back";
    backBtn.type = "button";
    backBtn.setAttribute("aria-label", "Back to playlists");
    backBtn.textContent = "←";
    title.insertBefore(backBtn, title.firstChild);
    backBtn.addEventListener("click", () => {
      backBtn.remove();
      title.textContent = "Playlists";
      loadFolders(view);
    });
  }

  try {
    const tracks = await invoke("lib_list_liked", {});
    stats.innerHTML = `<span class="view__stats-item">${tracks.length} tracks</span>`;

    if (tracks.length === 0) {
      body.innerHTML = `
        <div class="empty-state">
          <p class="empty-state__title">No liked tracks yet</p>
          <p class="empty-state__hint">Click the flame icon on a track to like it</p>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <table class="track-table">
        <thead>
          <tr>
            <th class="track-table__th track-table__th--cover"></th>
            <th class="track-table__th track-table__th--num">#</th>
            <th class="track-table__th">Title</th>
            <th class="track-table__th">Artist</th>
            <th class="track-table__th">Album</th>
            <th class="track-table__th">Genre</th>
            <th class="track-table__th track-table__th--dur">Duration</th>
          </tr>
        </thead>
        <tbody id="pl-rows"></tbody>
      </table>
    `;

    const tbody = body.querySelector("#pl-rows");
    renderRows(tbody, tracks);

    tbody.addEventListener("click", (e) => {
      const row = e.target.closest(".track-row");
      if (!row) return;
      const idx = tracks.findIndex((t) => t.id == row.dataset.trackId);
      if (idx >= 0) {
        setQueue(tracks, idx);
        playTrack(tracks[idx]);
      }
    });

    tbody.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".track-row");
      if (!row) return;
      e.preventDefault();
      invoke("player_enqueue_next", { path: row.dataset.path }).catch((err) =>
        console.error("[player] enqueue failed:", err)
      );
    });
  } catch (err) {
    body.innerHTML = `
      <div class="empty-state">
        <p class="empty-state__title">Failed to load liked tracks</p>
        <p class="empty-state__hint">${esc(String(err))}</p>
      </div>
    `;
  }
}
```

- [ ] **Step 3: Add CSS for liked entry**

Append to `src/styles/components.css`:

```css
/* Liked songs special entry in playlists */
.folder-item--liked {
  border-left: 3px solid var(--primary);
  margin-bottom: var(--space-3);
}

.folder-item--liked .folder-item__name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/js/views/playlists.js src/styles/components.css
git commit -m "feat(like): add liked songs entry to playlists view"
```

---

### Task 4: Smoke test

**Files:** None (verification only)

- [ ] **Step 1: Verify player bar like button**

1. Play a track — flame icon should appear next to track metadata
2. Click flame — should toggle (fill with accent color when liked, outline when not)
3. Switch tracks — like state should sync per track
4. Like a track, navigate away, come back — state persists

- [ ] **Step 2: Verify liked songs in playlists**

1. Go to Playlists view — "Liked Songs" entry should appear at top if any tracks are liked
2. Click it — should show liked tracks in table
3. Click back — returns to playlists list
4. Unlike all tracks — "Liked Songs" entry should disappear on next visit
