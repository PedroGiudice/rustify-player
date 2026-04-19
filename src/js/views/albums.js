import { playTrack } from "../components/player-bar.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Albums</h1>
      <div class="view__stats" id="al-stats"></div>
    </header>
    <div class="view__body" id="al-body"><p class="empty-state__hint">Loading...</p></div>
  `;
  load(view);
  return view;
}

async function load(view) {
  const stats = view.querySelector("#al-stats");
  const body = view.querySelector("#al-body");
  try {
    const albums = await invoke("lib_list_albums", { limit: 500 });
    stats.innerHTML = `<span class="view__stats-item">${albums.length} albums</span>`;
    if (albums.length === 0) {
      body.innerHTML = `<div class="empty-state"><p class="empty-state__title">No albums yet</p></div>`;
      return;
    }
    body.innerHTML = `
      <div class="card-grid">
        ${albums.map((a) => `
          <div class="card" data-album-id="${a.id}">
            <div class="card__cover card__cover--initials" id="album-cover-${a.id}">${initials(a.title)}</div>
            <div class="card__label">${esc(a.title)}</div>
            <div class="card__sub">${esc(a.album_artist_name || "—")}${a.year ? ` &bull; ${a.year}` : ""}</div>
          </div>
        `).join("")}
      </div>
    `;

    // Fetch covers asynchronously
    albums.forEach(async (a) => {
      if (!a.cover_path) return;
      const coverDiv = body.querySelector(`#album-cover-${a.id}`);
      if (!coverDiv) return;
      const img = new Image();
      img.onload = () => {
        coverDiv.innerHTML = "";
        coverDiv.appendChild(img);
        img.style.cssText = "width: 100%; height: 100%; object-fit: cover;";
        coverDiv.classList.remove("card__cover--initials");
      };
      img.src = convertFileSrc(a.cover_path);
    });

    body.addEventListener("click", async (e) => {
      const card = e.target.closest(".card");
      if (!card) return;
      const albumId = Number(card.dataset.albumId);
      const tracks = await invoke("lib_list_tracks", { albumId, limit: 100 });
      if (tracks.length > 0) {
        playTrack(tracks[0]);
        for (let i = 1; i < tracks.length; i++) {
          await invoke("player_enqueue_next", { path: tracks[i].path });
        }
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
  }
}

function initials(name) {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
