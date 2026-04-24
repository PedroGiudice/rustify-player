import { playTrack, setQueue } from "../components/player-bar.js";
import { navigate } from "../router.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Home</h1>
      <div class="view__stats" id="home-stats"></div>
    </header>
    <div class="view__body" id="home-body">
      <p class="empty-state__hint">Loading...</p>
    </div>
  `;
  load(view);
  return view;
}

async function load(view) {
  const stats = view.querySelector("#home-stats");
  const body = view.querySelector("#home-body");
  try {
    const [snap, genres, recentTracks, albums, recs] = await Promise.all([
      invoke("lib_snapshot"),
      invoke("lib_list_genres"),
      invoke("lib_list_history", { limit: 8 }).catch(() => []),
      invoke("lib_list_albums", { limit: 8 }).catch(() => []),
      invoke("lib_recommendations").catch(() => ({ most_played: [], based_on_top: [], discover: [] })),
    ]);
    const populated = genres.filter((g) => g.track_count > 0);

    stats.innerHTML = `
      <span>${snap.tracks_total} tracks</span>
      <span class="view__stats-sep">\u2022</span>
      <span>${populated.length} genres</span>
      <span class="view__stats-sep">\u2022</span>
      <span>${snap.embeddings_done}/${snap.tracks_total} embedded</span>
    `;

    body.innerHTML = `
      <section class="home-section">
        <h2 class="home-section__title">Quick Start</h2>
        <div class="home-actions">
          <button class="home-action" id="shuffle-all">
            <span class="home-action__label">Shuffle All</span>
            <span class="home-action__hint">${snap.tracks_total} tracks</span>
          </button>
          <a class="home-action" href="#/library">
            <span class="home-action__label">Browse Library</span>
            <span class="home-action__hint">folders &amp; genres</span>
          </a>
          <a class="home-action" href="#/albums">
            <span class="home-action__label">Albums</span>
            <span class="home-action__hint">browse by album</span>
          </a>
          <a class="home-action" href="#/now-playing">
            <span class="home-action__label">Now Playing</span>
            <span class="home-action__hint">full-screen view</span>
          </a>
        </div>
      </section>

      ${recentTracks.length > 0 ? `
        <section class="home-section">
          <h2 class="home-section__title">Recently Played</h2>
          <div class="recent-grid" id="home-recent"></div>
        </section>
      ` : ""}

      ${recs.based_on_top.length > 0 ? `
        <section class="home-section">
          <h2 class="home-section__title">Based on Your Favorites</h2>
          <div class="recent-grid" id="home-recs-top"></div>
        </section>
      ` : ""}

      ${recs.discover.length > 0 ? `
        <section class="home-section">
          <h2 class="home-section__title">Discover</h2>
          <div class="recent-grid" id="home-recs-discover"></div>
        </section>
      ` : ""}

      ${albums.length > 0 ? `
        <section class="home-section">
          <h2 class="home-section__title">Albums</h2>
          <div class="card-grid" id="home-albums"></div>
        </section>
      ` : ""}

      <section class="home-section">
        <h2 class="home-section__title">Stats</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-card__value">${snap.tracks_total}</div>
            <div class="stat-card__label">Tracks</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value">${snap.albums_total || "\u2014"}</div>
            <div class="stat-card__label">Albums</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value">${snap.artists_total || "\u2014"}</div>
            <div class="stat-card__label">Artists</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value">${populated.length}</div>
            <div class="stat-card__label">Genres</div>
          </div>
        </div>
      </section>

      <section class="home-section">
        <h2 class="home-section__title">Genres</h2>
        <div class="genre-chips">
          ${populated.map((g) => `<a class="chip" href="#/library?genre=${g.id}">${g.name} (${g.track_count})</a>`).join("")}
        </div>
      </section>
    `;

    // Recent items
    const recentGrid = body.querySelector("#home-recent");
    if (recentGrid && recentTracks.length > 0) {
      recentTracks.forEach((t) => {
        const item = document.createElement("button");
        item.className = "recent-item";
        item.innerHTML = `
          <div class="recent-item__cover" id="recent-cover-${t.id}"></div>
          <div class="recent-item__meta">
            <div class="recent-item__title">${esc(t.title || "\u2014")}</div>
            <div class="recent-item__sub">${esc(t.artist_name || "\u2014")}</div>
          </div>
        `;
        item.addEventListener("click", () => {
          setQueue([t], 0);
          playTrack(t);
        });
        recentGrid.appendChild(item);

        // Load cover async
        if (t.album_id) {
          invoke("lib_get_album", { id: t.album_id }).then((album) => {
            if (album?.cover_path) {
              const coverEl = body.querySelector(`#recent-cover-${t.id}`);
              if (coverEl) coverEl.innerHTML = `<img src="${convertFileSrc(album.cover_path)}" alt="">`;
            }
          }).catch(() => {});
        }
      });
    }

    // Recommendation grids
    populateRecGrid(body, "#home-recs-top", recs.based_on_top);
    populateRecGrid(body, "#home-recs-discover", recs.discover);

    // Albums cards
    const albumsGrid = body.querySelector("#home-albums");
    if (albumsGrid && albums.length > 0) {
      albums.forEach((a) => {
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.albumId = a.id;
        card.innerHTML = `
          <div class="card__cover card__cover--initials" id="home-album-${a.id}">
            ${initials(a.title)}
            <button class="card__cover-play" data-play-album="${a.id}" aria-label="Play">
              <svg class="icon icon--filled" aria-hidden="true"><use href="#icon-play"></use></svg>
            </button>
          </div>
          <div class="card__label">${esc(a.title)}</div>
          <div class="card__sub">${esc(a.album_artist_name || "\u2014")}</div>
        `;
        albumsGrid.appendChild(card);

        if (a.cover_path) {
          const coverDiv = card.querySelector(`#home-album-${a.id}`);
          const img = new Image();
          img.onload = () => {
            const playBtn = coverDiv.querySelector(".card__cover-play");
            coverDiv.innerHTML = "";
            coverDiv.appendChild(img);
            if (playBtn) coverDiv.appendChild(playBtn);
            img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
            coverDiv.classList.remove("card__cover--initials");
          };
          img.src = convertFileSrc(a.cover_path);
        }
      });

      albumsGrid.addEventListener("click", async (e) => {
        const playBtn = e.target.closest("[data-play-album]");
        if (playBtn) {
          e.stopPropagation();
          const tracks = await invoke("lib_list_tracks", { albumId: Number(playBtn.dataset.playAlbum), limit: 100 });
          if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
          return;
        }
        const card = e.target.closest(".card");
        if (card) navigate(`/album/${card.dataset.albumId}`);
      });
    }

    // Shuffle all
    body.querySelector("#shuffle-all").addEventListener("click", async () => {
      try {
        const tracks = await invoke("lib_shuffle", { limit: 50 });
        if (tracks.length > 0) {
          setQueue(tracks, 0);
          playTrack(tracks[0]);
        }
      } catch (err) {
        console.error("[home] shuffle failed:", err);
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
  }
}

function populateRecGrid(body, selector, tracks) {
  const grid = body.querySelector(selector);
  if (!grid || tracks.length === 0) return;

  tracks.forEach((t) => {
    const item = document.createElement("button");
    item.className = "recent-item";
    item.innerHTML = `
      <div class="recent-item__cover">${t.album_cover_path ? `<img src="${convertFileSrc(t.album_cover_path)}" alt="">` : ""}</div>
      <div class="recent-item__meta">
        <div class="recent-item__title">${esc(t.title || "—")}</div>
        <div class="recent-item__sub">${esc(t.artist_name || "—")}</div>
      </div>
    `;
    item.addEventListener("click", () => {
      setQueue(tracks, tracks.indexOf(t));
      playTrack(t);
    });
    grid.appendChild(item);
  });
}

function initials(name) {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
