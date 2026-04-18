const { invoke } = window.__TAURI__.core;

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
    const [snap, genres] = await Promise.all([
      invoke("lib_snapshot"),
      invoke("lib_list_genres"),
    ]);
    const populated = genres.filter((g) => g.track_count > 0);

    stats.innerHTML = `
      <span class="view__stats-item">${snap.tracks_total} tracks</span>
      <span class="view__stats-sep">&bull;</span>
      <span class="view__stats-item">${populated.length} genres</span>
      <span class="view__stats-sep">&bull;</span>
      <span class="view__stats-item">${snap.embeddings_done}/${snap.tracks_total} embedded</span>
    `;

    body.innerHTML = `
      <section class="home-section">
        <h2 class="home-section__title">Quick Start</h2>
        <div class="home-actions">
          <button class="home-action" id="shuffle-all">
            <span class="home-action__label">Shuffle All</span>
            <span class="home-action__hint">${snap.tracks_total} tracks, true random</span>
          </button>
          <a class="home-action" href="#/library">
            <span class="home-action__label">Browse Library</span>
            <span class="home-action__hint">filter by genre</span>
          </a>
          <a class="home-action" href="#/albums">
            <span class="home-action__label">Albums</span>
            <span class="home-action__hint">browse by album</span>
          </a>
        </div>
      </section>

      <section class="home-section">
        <h2 class="home-section__title">Genres</h2>
        <div class="genre-chips">
          ${populated.map((g) => `
            <a class="chip" href="#/library?genre=${g.id}">${g.name} (${g.track_count})</a>
          `).join("")}
        </div>
      </section>
    `;

    body.querySelector("#shuffle-all").addEventListener("click", async () => {
      try {
        const tracks = await invoke("lib_shuffle", { limit: 50 });
        if (tracks.length > 0) {
          await invoke("player_play", { path: tracks[0].path });
          for (let i = 1; i < Math.min(tracks.length, 5); i++) {
            await invoke("player_enqueue_next", { path: tracks[i].path });
          }
        }
      } catch (err) {
        console.error("[home] shuffle failed:", err);
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
  }
}
