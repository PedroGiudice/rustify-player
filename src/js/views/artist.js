// Artist detail — hero with giant name, bio, albums grid, top tracks.
import { playTrack, setQueue } from "../components/player-bar.js";
import { navigate } from "../router.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

export function render(artistName) {
  const view = document.createElement("article");
  view.className = "view view--hero";
  view.innerHTML = `<div class="artist-detail" id="artist-detail"><p class="empty-state__hint">Loading...</p></div>`;
  if (artistName) load(view, decodeURIComponent(artistName));
  return view;
}

async function load(view, artistName) {
  const container = view.querySelector("#artist-detail");
  try {
    const albums = await invoke("lib_list_albums", { artist: artistName, limit: 100 });
    const artist = { name: artistName, track_count: 0, album_count: albums.length };

    container.innerHTML = `
      <div class="artist-detail__hero">
        <button class="view__back" id="artist-back" aria-label="Back">
          <svg class="icon" aria-hidden="true"><use href="#icon-arrow-left"></use></svg>
        </button>
        <div class="artist-detail__eyebrow">Artist</div>
        <h1 class="artist-detail__name">${esc(artist.name)}</h1>
        <div class="artist-detail__stats">
          <span>${albums.length} albums</span>
        </div>
      </div>
      <section class="home-section">
        <h2 class="home-section__title">Discography</h2>
        <div class="card-grid" id="artist-albums"></div>
      </section>
    `;

    const grid = container.querySelector("#artist-albums");
    albums.forEach((a) => {
      const coverHTML = a.cover_path
        ? `<img src="${convertFileSrc(a.cover_path)}" alt="">`
        : `<span>${initials(a.title)}</span>`;

      const card = document.createElement("div");
      card.className = "card";
      card.dataset.albumId = a.title;
      card.innerHTML = `
        <div class="card__cover ${a.cover_path ? "" : "card__cover--initials"}">
          ${coverHTML}
          <button class="card__cover-play" data-play-album="${a.title}" aria-label="Play">
            <svg class="icon icon--filled" aria-hidden="true"><use href="#icon-play"></use></svg>
          </button>
        </div>
        <div class="card__label">${esc(a.title)}</div>
        <div class="card__sub">${a.year || "\u2014"}</div>
      `;
      grid.appendChild(card);
    });

    container.querySelector("#artist-back").addEventListener("click", () => navigate("/artists"));

    grid.addEventListener("click", async (e) => {
      const playBtn = e.target.closest("[data-play-album]");
      if (playBtn) {
        e.stopPropagation();
        const tracks = await invoke("lib_list_tracks", { album: Number(playBtn.dataset.playAlbum), limit: 100 });
        if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
        return;
      }
      const card = e.target.closest(".card");
      if (card) navigate(`/album/${card.dataset.albumId}`);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
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
