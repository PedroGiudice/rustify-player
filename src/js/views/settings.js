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

      <section class="settings-section" id="st-ee-section" hidden>
        <h3 class="settings-section__title">EasyEffects</h3>

        <div class="settings-row">
          <label class="settings-row__label" for="st-ee-preset">Preset</label>
          <div class="settings-row__control">
            <select id="st-ee-preset" class="settings-input"></select>
            <span class="settings-row__hint" id="st-ee-current"></span>
          </div>
        </div>

        <p class="settings-section__note">
          EasyEffects presets live in ~/.config/easyeffects/output/. Changes
          take effect immediately — the running EE daemon handles the switch.
        </p>
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
        <h3 class="settings-section__title">Updates</h3>

        <div class="settings-row">
          <label class="settings-row__label">Status</label>
          <div class="settings-row__control" id="st-update-status">
            <span class="settings-row__value settings-row__value--muted">Not checked</span>
          </div>
        </div>

        <div class="settings-row">
          <label class="settings-row__label">Action</label>
          <div class="settings-row__control" id="st-update-actions">
            <button class="settings-button" id="st-check-update">Check for updates</button>
          </div>
        </div>
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

    // Update checker
    const checkBtn = body.querySelector("#st-check-update");
    const updateStatus = body.querySelector("#st-update-status");
    const updateActions = body.querySelector("#st-update-actions");

    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = "Checking...";
      updateStatus.innerHTML = `<span class="settings-row__value settings-row__value--muted">Checking...</span>`;

      try {
        const result = await invoke("check_for_update");

        if (result.error) {
          updateStatus.innerHTML = `<span class="settings-row__value settings-row__value--muted">${esc(result.message)}</span>`;
          checkBtn.textContent = "Check for updates";
          checkBtn.disabled = false;
          return;
        }

        const publishedAgo = result.published_at ? relativeTime(result.published_at) : "";

        if (result.update_available) {
          updateStatus.innerHTML = `
            <span class="status-pill status-pill--warn">Update available</span>
            <span class="settings-row__hint">v${esc(result.current_version)} \u2192 v${esc(result.latest_version)}${publishedAgo ? ` (published ${publishedAgo})` : ""}</span>
          `;
          updateActions.innerHTML = `
            <button class="settings-button settings-button--primary" id="st-install-update">Install Update</button>
            <button class="settings-button" id="st-check-update">Check again</button>
          `;
          bindInstallBtn(body);
          bindCheckBtn(body, updateStatus, updateActions);
        } else {
          updateStatus.innerHTML = `
            <span class="status-pill status-pill--ok">Up to date</span>
            <span class="settings-row__hint">v${esc(result.current_version)}${publishedAgo ? ` (published ${publishedAgo})` : ""}</span>
          `;
          checkBtn.textContent = "Check again";
          checkBtn.disabled = false;
        }
      } catch (err) {
        updateStatus.innerHTML = `<span class="settings-row__value settings-row__value--muted">Check failed: ${esc(String(err))}</span>`;
        checkBtn.textContent = "Retry";
        checkBtn.disabled = false;
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

    // EasyEffects presets — graceful: hides the section when EE is absent.
    await hydrateEEPresets(body);
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

function bindInstallBtn(body) {
  const installBtn = body.querySelector("#st-install-update");
  if (!installBtn) return;
  installBtn.addEventListener("click", async () => {
    installBtn.disabled = true;
    installBtn.textContent = "Installing...";
    try {
      await invoke("install_update");
      const statusEl = body.querySelector("#st-update-status");
      statusEl.innerHTML = `
        <span class="status-pill status-pill--ok">Installed</span>
        <span class="settings-row__hint">Update installed. Please restart Rustify.</span>
      `;
      installBtn.textContent = "Restart required";
    } catch (err) {
      installBtn.textContent = "Install failed";
      installBtn.disabled = false;
      const statusEl = body.querySelector("#st-update-status");
      statusEl.innerHTML += `<br><span class="settings-row__value settings-row__value--muted">${esc(String(err))}</span>`;
    }
  });
}

function bindCheckBtn(body, updateStatus, updateActions) {
  const newCheckBtn = body.querySelector("#st-check-update");
  if (!newCheckBtn) return;
  // Re-render triggers a full load(), so just re-navigate
  newCheckBtn.addEventListener("click", () => {
    window.location.hash = "/settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

function relativeTime(isoStr) {
  try {
    const then = new Date(isoStr);
    const now = new Date();
    const diffMs = now - then;
    const diffSecs = Math.floor(diffMs / 1000);
    if (diffSecs < 60) return "just now";
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    return then.toLocaleDateString();
  } catch (_) {
    return "";
  }
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

async function hydrateEEPresets(body) {
  const section = body.querySelector("#st-ee-section");
  const select = body.querySelector("#st-ee-preset");
  const currentEl = body.querySelector("#st-ee-current");
  if (!section || !select) return;

  let presets = [];
  try {
    presets = await invoke("ee_list_presets");
  } catch (_) {
    // EE not installed or no config dir — keep section hidden.
    return;
  }
  if (!Array.isArray(presets) || presets.length === 0) {
    return;
  }

  let current = "";
  try {
    current = await invoke("ee_get_current_preset");
  } catch (_) {
    current = "";
  }

  const renderOptions = (cur) => {
    select.innerHTML = presets
      .map(
        (name) =>
          `<option value="${esc(name)}"${name === cur ? " selected" : ""}>${esc(name)}</option>`
      )
      .join("");
    currentEl.textContent = cur ? `Active: ${cur}` : "";
  };
  renderOptions(current);
  section.hidden = false;

  select.addEventListener("change", async (e) => {
    const name = e.target.value;
    if (!name) return;
    select.disabled = true;
    try {
      await invoke("ee_apply_preset", { name });
      const refreshed = await invoke("ee_get_current_preset").catch(() => name);
      renderOptions(refreshed);
    } catch (err) {
      currentEl.textContent = `Failed: ${String(err)}`;
    } finally {
      select.disabled = false;
    }
  });
}
