import { playTrack } from "../components/player-bar.js";

const { invoke } = window.__TAURI__.core;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Local Library</h1>
      <div class="view__stats" id="lib-stats"></div>
    </header>
    <div class="view__body" id="lib-body">
      <div class="empty-state">
        <p class="empty-state__title">Loading...</p>
      </div>
    </div>
  `;

  loadLibrary(view);
  return view;
}

async function loadLibrary(view) {
  const stats = view.querySelector("#lib-stats");
  const body = view.querySelector("#lib-body");

  try {
    const [snapshot, genres, tracks] = await Promise.all([
      invoke("lib_snapshot"),
      invoke("lib_list_genres"),
      invoke("lib_list_tracks", { limit: 200 }),
    ]);

    const populated = genres.filter((g) => g.track_count > 0);
    stats.innerHTML = `
      <span class="view__stats-item">${snapshot.tracks_total} tracks</span>
      <span class="view__stats-sep">&bull;</span>
      <span class="view__stats-item">${populated.length} genres</span>
      ${snapshot.embeddings_done > 0 ? `
        <span class="view__stats-sep">&bull;</span>
        <span class="view__stats-item">${snapshot.embeddings_done} embeddings</span>
      ` : ""}
    `;

    if (tracks.length === 0) {
      body.innerHTML = `
        <div class="empty-state">
          <p class="empty-state__title">No tracks indexed yet</p>
          <p class="empty-state__hint">Point to a music folder in Settings</p>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <div class="genre-chips" id="genre-chips"></div>
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
        <tbody id="track-rows"></tbody>
      </table>
    `;

    const chips = body.querySelector("#genre-chips");
    chips.innerHTML = populated
      .map(
        (g) => `<button class="chip" data-genre-id="${g.id}">${g.name} (${g.track_count})</button>`
      )
      .join("");

    chips.addEventListener("click", async (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      const genreId = Number(btn.dataset.genreId);
      const active = btn.classList.contains("chip--active");

      chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("chip--active"));
      if (!active) {
        btn.classList.add("chip--active");
        const filtered = await invoke("lib_list_tracks", { genreId, limit: 200 });
        renderTracks(body.querySelector("#track-rows"), filtered);
      } else {
        renderTracks(body.querySelector("#track-rows"), tracks);
      }
    });

    renderTracks(body.querySelector("#track-rows"), tracks);
  } catch (err) {
    body.innerHTML = `
      <div class="empty-state">
        <p class="empty-state__title">Failed to load library</p>
        <p class="empty-state__hint">${err}</p>
      </div>
    `;
  }
}

function renderTracks(tbody, tracks) {
  tbody.innerHTML = tracks
    .map(
      (t, i) => `
    <tr class="track-row" data-track-id="${t.id}" data-path="${escapeAttr(t.path)}">
      <td class="track-table__td track-table__td--num">${i + 1}</td>
      <td class="track-table__td track-table__td--title">${esc(t.title)}</td>
      <td class="track-table__td">${esc(t.artist_name || "—")}</td>
      <td class="track-table__td">${esc(t.album_title || "—")}</td>
      <td class="track-table__td track-table__td--dur">${formatDuration(t.duration_secs)}</td>
    </tr>
  `
    )
    .join("");

  tbody.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".track-row");
    if (!row) return;
    const path = row.dataset.path;
    const track = tracks.find((t) => t.id == row.dataset.trackId);
    if (track) {
      playTrack(track);
    }
  });
}

function formatDuration(secs) {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function escapeAttr(s) {
  return s.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
