const { invoke } = window.__TAURI__.core;

const APP_VERSION = "0.1.0";
const DEFAULT_VOLUME = 0.8;

export function render() {
  const view = document.createElement("article");
  view.className = "view";
  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Settings</h1>
      <div class="view__stats"><span class="view__stats-item">v${APP_VERSION}</span></div>
    </header>
    <div class="view__body" id="st-body">
      <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
    </div>
  `;
  load(view);
  return view;
}

async function load(view) {
  const body = view.querySelector("#st-body");

  try {
    const [snapshot, albums, artists, genres] = await Promise.all([
      invoke("lib_snapshot"),
      invoke("lib_list_albums", { limit: 10000 }),
      invoke("lib_list_artists", { limit: 10000 }),
      invoke("lib_list_genres"),
    ]);

    const genresPopulated = genres.filter((g) => g.track_count > 0).length;
    const volumePct = Math.round(DEFAULT_VOLUME * 100);

    body.innerHTML = `
      <section class="settings-section">
        <h3 class="settings-section__title">Library</h3>

        <div class="settings-row">
          <label class="settings-row__label" for="st-root">Music root</label>
          <input type="text" id="st-root" class="settings-input" value="~/Music" readonly />
        </div>

        <div class="settings-row">
          <label class="settings-row__label">Re-scan</label>
          <div class="settings-row__control">
            <button class="settings-button" id="st-rescan">Re-scan library</button>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <span class="stat-card__value">${snapshot.tracks_total}</span>
            <span class="stat-card__label">Tracks</span>
          </div>
          <div class="stat-card">
            <span class="stat-card__value">${albums.length}</span>
            <span class="stat-card__label">Albums</span>
          </div>
          <div class="stat-card">
            <span class="stat-card__value">${artists.length}</span>
            <span class="stat-card__label">Artists</span>
          </div>
          <div class="stat-card">
            <span class="stat-card__value">${genresPopulated}</span>
            <span class="stat-card__label">Genres</span>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Audio</h3>

        <div class="settings-row">
          <label class="settings-row__label" for="st-volume">Volume</label>
          <div class="settings-row__control">
            <input type="range" id="st-volume" class="settings-range" min="0" max="100" value="${volumePct}" />
            <span class="settings-range__value" id="st-volume-val">${volumePct}%</span>
          </div>
        </div>

        <div class="settings-row">
          <label class="settings-row__label" for="st-device">Output device</label>
          <select id="st-device" class="settings-input" disabled>
            <option>System default</option>
          </select>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Embedding</h3>

        <div class="settings-row">
          <label class="settings-row__label">Status</label>
          <div class="settings-row__control">
            <span class="status-pill ${embedStatusClass(snapshot)}">${embedStatusLabel(snapshot)}</span>
            <span class="settings-row__hint">${snapshot.embeddings_done}/${snapshot.tracks_total} tracks embedded</span>
          </div>
        </div>

        <p class="settings-section__note">
          Embeddings power similarity search via MERT-v1-95M running on the remote service.
          Similarity queries require embeddings to be populated.
        </p>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">About</h3>

        <div class="settings-row">
          <label class="settings-row__label">Version</label>
          <span class="settings-row__value">${APP_VERSION}</span>
        </div>

        <div class="settings-row">
          <label class="settings-row__label">Repository</label>
          <span class="settings-row__value settings-row__value--muted">rustify-player</span>
        </div>
      </section>
    `;

    const rescanBtn = body.querySelector("#st-rescan");
    rescanBtn.addEventListener("click", async () => {
      rescanBtn.disabled = true;
      rescanBtn.textContent = "Scanning...";
      try {
        await invoke("lib_rescan");
        rescanBtn.textContent = "Scan started";
        setTimeout(() => {
          rescanBtn.disabled = false;
          rescanBtn.textContent = "Re-scan library";
        }, 5000);
      } catch (e) {
        rescanBtn.textContent = "Scan failed";
        rescanBtn.disabled = false;
      }
    });

    const slider = body.querySelector("#st-volume");
    const valueLabel = body.querySelector("#st-volume-val");
    slider.addEventListener("input", (e) => {
      const pct = parseInt(e.target.value, 10);
      valueLabel.textContent = `${pct}%`;
      invoke("player_set_volume", { volume: pct / 100 }).catch((err) =>
        console.error("[player] set_volume failed:", err)
      );
    });
  } catch (err) {
    body.innerHTML = `
      <div class="empty-state">
        <p class="empty-state__title">Failed to load settings</p>
        <p class="empty-state__hint">${esc(String(err))}</p>
      </div>
    `;
  }
}

function embedStatusClass(s) {
  if (s.tracks_total === 0) return "status-pill--dim";
  if (s.embeddings_done === s.tracks_total) return "status-pill--ok";
  if (s.embeddings_failed > 0) return "status-pill--warn";
  return "status-pill--dim";
}

function embedStatusLabel(s) {
  if (s.tracks_total === 0) return "Idle";
  if (s.embeddings_done === s.tracks_total) return "Complete";
  if (s.embeddings_pending > 0) return "Pending";
  if (s.embeddings_failed > 0) return "Partial";
  return "Idle";
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
