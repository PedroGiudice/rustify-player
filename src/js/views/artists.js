import { navigate } from "../router.js";

const { invoke } = window.__TAURI__.core;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Artists</h1>
      <div class="view__stats" id="ar-stats"></div>
      <div class="view__toolbar">
        <input class="search-input" id="ar-search" placeholder="Search artists..." type="text">
      </div>
    </header>
    <div class="view__body" id="ar-body"><p class="empty-state__hint">Loading...</p></div>
  `;
  load(view);
  return view;
}

async function load(view) {
  const stats = view.querySelector("#ar-stats");
  const body = view.querySelector("#ar-body");
  const search = view.querySelector("#ar-search");

  try {
    const artists = await invoke("lib_list_artists", { limit: 500 });
    stats.innerHTML = `<span>${artists.length} artists</span>`;
    if (artists.length === 0) {
      body.innerHTML = `<div class="empty-state"><p class="empty-state__title">No artists yet</p></div>`;
      return;
    }

    const renderGrid = (filtered) => {
      body.innerHTML = `
        <div class="card-grid">
          ${filtered.map((a) => `
            <div class="card" data-artist-id="${a.id}">
              <div class="card__cover card__cover--initials">${initials(a.name)}</div>
              <div class="card__label">${esc(a.name)}</div>
              <div class="card__sub">${a.track_count || 0} tracks</div>
            </div>
          `).join("")}
        </div>
      `;
    };

    renderGrid(artists);

    search.addEventListener("input", () => {
      const q = search.value.toLowerCase();
      renderGrid(artists.filter((a) => a.name.toLowerCase().includes(q)));
    });

    body.addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (card) navigate(`/artist/${card.dataset.artistId}`);
    });
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
  }
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
