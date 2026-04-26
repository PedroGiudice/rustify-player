import { playTrack, setQueue } from "../components/player-bar.js";
import { navigate } from "../router.js";

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
    stats.innerHTML = `<span>${albums.length} albums</span>`;
    if (albums.length === 0) {
      body.innerHTML = `<div class="empty-state"><p class="empty-state__title">No albums yet</p></div>`;
      return;
    }

    const renderGrid = (filtered) => {
      body.innerHTML = `
        <div class="card-grid">
          ${filtered.map((a) => `
            <div class="card" data-album-id="${a.id}">
              <div class="card__cover card__cover--initials" id="album-cover-${a.id}">
                ${initials(a.title)}
                <button class="card__cover-play" data-play-album="${a.id}" aria-label="Play album">
                  <svg class="icon icon--filled" aria-hidden="true"><use href="#icon-play"></use></svg>
                </button>
              </div>
              <div class="card__label">${esc(a.title)}</div>
              <div class="card__sub">${esc(a.album_artist_name || "\u2014")}${a.year ? ` \u2022 ${a.year}` : ""}</div>
            </div>
          `).join("")}
        </div>
      `;

      // Covers
      filtered.forEach(async (a) => {
        if (!a.cover_path) return;
        const coverDiv = body.querySelector(`#album-cover-${a.id}`);
        if (!coverDiv) return;
        const img = new Image();
        img.onload = () => {
          // Keep the play FAB, replace initials with image
          const playBtn = coverDiv.querySelector(".card__cover-play");
          coverDiv.innerHTML = "";
          coverDiv.appendChild(img);
          if (playBtn) coverDiv.appendChild(playBtn);
          img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
          coverDiv.classList.remove("card__cover--initials");
        };
        img.src = convertFileSrc(a.cover_path);
      });
    };

    renderGrid(albums);

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

    // Click card → album detail; click play FAB → play
    body.addEventListener("click", async (e) => {
      const playBtn = e.target.closest("[data-play-album]");
      if (playBtn) {
        e.stopPropagation();
        const albumId = Number(playBtn.dataset.playAlbum);
        const tracks = await invoke("lib_list_tracks", { albumId, limit: 100 });
        if (tracks.length > 0) {
          setQueue(tracks, 0);
          playTrack(tracks[0]);
        }
        return;
      }
      const card = e.target.closest(".card");
      if (card) {
        navigate(`/album/${card.dataset.albumId}`);
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
