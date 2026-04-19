import { playTrack, setQueue } from "../components/player-bar.js";

const { invoke } = window.__TAURI__.core;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Playlists</h1>
      <div class="view__stats" id="pl-stats"></div>
    </header>
    <div class="view__body" id="pl-body">
      <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
    </div>
  `;
  loadFolders(view);
  return view;
}

async function loadFolders(view) {
  const stats = view.querySelector("#pl-stats");
  const body = view.querySelector("#pl-body");

  try {
    const folders = await invoke("lib_list_folders");

    if (folders.length === 0) {
      stats.innerHTML = "";
      body.innerHTML = `
        <div class="empty-state">
          <p class="empty-state__title">No folders found</p>
          <p class="empty-state__hint">Add a music folder in Settings to see playlists</p>
        </div>
      `;
      return;
    }

    const totalTracks = folders.reduce((sum, f) => sum + (f.track_count || 0), 0);
    stats.innerHTML = `<span class="view__stats-item">${folders.length} folders</span><span class="view__stats-item">${totalTracks} tracks</span>`;

    body.innerHTML = `<div class="folder-list" id="pl-folders"></div>`;
    const list = body.querySelector("#pl-folders");

    list.innerHTML = folders
      .map((f) => {
        const name = f.name || "";
        const label = name === "" ? "Unsorted" : name;
        return `
          <button class="folder-item" data-folder="${escAttr(name)}" type="button">
            <span class="folder-item__name">${esc(label)}</span>
            <span class="folder-item__count">${f.track_count} tracks</span>
          </button>`;
      })
      .join("");

    list.addEventListener("click", (e) => {
      const btn = e.target.closest(".folder-item");
      if (!btn) return;
      const folder = btn.dataset.folder;
      openFolder(view, folder);
    });
  } catch (err) {
    body.innerHTML = `
      <div class="empty-state">
        <p class="empty-state__title">Failed to load folders</p>
        <p class="empty-state__hint">${esc(String(err))}</p>
      </div>
    `;
  }
}

async function openFolder(view, folder) {
  const stats = view.querySelector("#pl-stats");
  const body = view.querySelector("#pl-body");
  const title = view.querySelector(".view__title");
  const label = folder === "" ? "Unsorted" : folder;

  title.textContent = label;
  stats.innerHTML = "";
  body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Loading...</p></div>`;

  // Insert back button inside title element
  let backBtn = title.querySelector("#pl-back");
  if (!backBtn) {
    backBtn = document.createElement("button");
    backBtn.id = "pl-back";
    backBtn.className = "view__back";
    backBtn.type = "button";
    backBtn.setAttribute("aria-label", "Back to folders");
    backBtn.textContent = "\u2190";
    title.insertBefore(backBtn, title.firstChild);
    backBtn.addEventListener("click", () => {
      backBtn.remove();
      title.textContent = "Playlists";
      loadFolders(view);
    });
  }

  try {
    const tracks = await invoke("lib_list_folder_tracks", { folder });
    stats.innerHTML = `<span class="view__stats-item">${tracks.length} tracks</span>`;

    if (tracks.length === 0) {
      body.innerHTML = `
        <div class="empty-state">
          <p class="empty-state__title">No tracks in this folder</p>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <table class="track-table">
        <thead>
          <tr>
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

    tbody.addEventListener("dblclick", (e) => {
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
        <p class="empty-state__title">Failed to load tracks</p>
        <p class="empty-state__hint">${esc(String(err))}</p>
      </div>
    `;
  }
}

function renderRows(tbody, tracks) {
  tbody.innerHTML = tracks
    .map(
      (t, i) => `
    <tr class="track-row" data-track-id="${t.id}" data-path="${escAttr(t.path)}">
      <td class="track-table__td track-table__td--num">${t.track_number ?? i + 1}</td>
      <td class="track-table__td track-table__td--title">${esc(t.title)}</td>
      <td class="track-table__td">${esc(t.artist_name || "\u2014")}</td>
      <td class="track-table__td">${esc(t.album_title || "\u2014")}</td>
      <td class="track-table__td">${esc(t.genre_name || "\u2014")}</td>
      <td class="track-table__td track-table__td--dur">${formatDuration(t.duration_ms)}</td>
    </tr>`
    )
    .join("");
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "\u2014";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
