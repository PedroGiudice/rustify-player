import { playTrack } from "../components/player-bar.js";

const { invoke } = window.__TAURI__.core;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Tracks</h1>
      <div class="view__stats" id="tr-stats"></div>
      <div class="view__toolbar">
        <input type="search" class="search-input" id="tr-search" placeholder="Search title, artist, album…" autocomplete="off" spellcheck="false" />
      </div>
    </header>
    <div class="view__body" id="tr-body">
      <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
    </div>
  `;
  load(view);
  return view;
}

async function load(view) {
  const stats = view.querySelector("#tr-stats");
  const body = view.querySelector("#tr-body");
  const search = view.querySelector("#tr-search");

  try {
    const tracks = await invoke("lib_list_tracks", { limit: 5000 });
    stats.innerHTML = `<span class="view__stats-item">${tracks.length} tracks</span>`;

    if (tracks.length === 0) {
      body.innerHTML = `
        <div class="empty-state">
          <p class="empty-state__title">No tracks indexed</p>
          <p class="empty-state__hint">Point to a music folder in Settings</p>
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
        <tbody id="tr-rows"></tbody>
      </table>
    `;

    const tbody = body.querySelector("#tr-rows");
    renderRows(tbody, tracks);

    tbody.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".track-row");
      if (!row) return;
      const track = tracks.find((t) => t.id == row.dataset.trackId);
      if (track) {
        playTrack(track);
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

    search.addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) {
        renderRows(tbody, tracks);
        return;
      }
      const filtered = tracks.filter((t) => {
        const hay = `${t.title} ${t.artist_name || ""} ${t.album_title || ""}`.toLowerCase();
        return hay.includes(q);
      });
      renderRows(tbody, filtered);
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
      <td class="track-table__td">${esc(t.artist_name || "—")}</td>
      <td class="track-table__td">${esc(t.album_title || "—")}</td>
      <td class="track-table__td">${esc(t.genre_name || "—")}</td>
      <td class="track-table__td track-table__td--dur">${formatDuration(t.duration_ms)}</td>
    </tr>`
    )
    .join("");
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "—";
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
