// Album detail view — hero with cover + metadata, track table.
import { playTrack, setQueue } from "../components/player-bar.js";
import { navigate } from "../router.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

export function render(albumId) {
  const view = document.createElement("article");
  view.className = "view view--hero";
  view.innerHTML = `<div class="album-detail" id="album-detail"><p class="empty-state__hint">Loading...</p></div>`;
  if (albumId) load(view, Number(albumId));
  return view;
}

async function load(view, albumId) {
  const container = view.querySelector("#album-detail");
  try {
    const [album, tracks] = await Promise.all([
      invoke("lib_get_album", { id: albumId }),
      invoke("lib_list_tracks", { albumId, limit: 200 }),
    ]);

    if (!album) {
      container.innerHTML = `<div class="empty-state"><p class="empty-state__title">Album not found</p></div>`;
      return;
    }

    const coverHTML = album.cover_path
      ? `<img src="${convertFileSrc(album.cover_path)}" alt="${esc(album.title)}">`
      : `<span style="font-size:var(--text-display-lg);font-weight:var(--fw-bold);color:var(--primary)">${initials(album.title)}</span>`;

    const totalDur = tracks.reduce((s, t) => s + (t.duration_secs || 0), 0);
    const durStr = `${Math.floor(totalDur / 60)}m`;

    container.innerHTML = `
      <div class="album-detail__hero">
        <div class="album-detail__cover">${coverHTML}</div>
        <div class="album-detail__meta">
          <button class="view__back" id="album-back" aria-label="Back">
            <svg class="icon" aria-hidden="true"><use href="#icon-arrow-left"></use></svg>
          </button>
          <div class="album-detail__eyebrow">Album${album.year ? ` \u2022 ${album.year}` : ""}</div>
          <h1 class="album-detail__title">${esc(album.title)}</h1>
          <div class="album-detail__artist" id="album-artist">${esc(album.album_artist_name || "\u2014")}</div>
          <div class="album-detail__stats">
            <span>${tracks.length} tracks</span>
            <span class="view__stats-sep">\u2022</span>
            <span>${durStr}</span>
          </div>
          <div class="album-detail__actions">
            <button class="settings-button settings-button--primary" id="album-play-all">
              <svg class="icon icon--sm icon--filled" aria-hidden="true"><use href="#icon-play"></use></svg>
              Play
            </button>
            <button class="settings-button" id="album-shuffle">
              <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-shuffle"></use></svg>
              Shuffle
            </button>
          </div>
        </div>
      </div>
      <table class="track-table" id="album-tracks">
        <thead><tr>
          <th class="track-table__th track-table__th--num">#</th>
          <th class="track-table__th">Title</th>
          <th class="track-table__th track-table__th--dur">Dur</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    `;

    const tbody = container.querySelector("#album-tracks tbody");
    tracks.forEach((t, i) => {
      const tr = document.createElement("tr");
      tr.className = "track-row";
      tr.dataset.idx = i;
      tr.innerHTML = `
        <td class="track-table__td track-table__td--num">${t.track_number || i + 1}</td>
        <td class="track-table__td track-table__td--title">${esc(t.title || "\u2014")}</td>
        <td class="track-table__td track-table__td--dur">${fmtDur(t.duration_secs)}</td>
      `;
      tbody.appendChild(tr);
    });

    // Events
    container.querySelector("#album-back").addEventListener("click", () => navigate("/albums"));
    container.querySelector("#album-artist").addEventListener("click", () => {
      if (album.artist_id) navigate(`/artist/${album.artist_id}`);
    });
    container.querySelector("#album-play-all").addEventListener("click", () => {
      if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
    });
    container.querySelector("#album-shuffle").addEventListener("click", () => {
      const shuffled = [...tracks].sort(() => Math.random() - 0.5);
      if (shuffled.length) { setQueue(shuffled, 0); playTrack(shuffled[0]); }
    });
    tbody.addEventListener("click", (e) => {
      const row = e.target.closest(".track-row");
      if (row) {
        const idx = Number(row.dataset.idx);
        setQueue(tracks, idx);
        playTrack(tracks[idx]);
      }
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
  }
}

function fmtDur(secs) {
  if (!secs) return "\u2014";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function initials(name) {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
