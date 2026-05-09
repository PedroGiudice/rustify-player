/* ============================================================
   views/Settings.tsx — Configuracoes completas.
   Markup identico ao settings.js vanilla.
   ============================================================ */

import { createSignal, createResource, Show, For, onMount } from "solid-js";
import { libSnapshot, libGetAlbums, libGetArtists, libListGenres, libRescan, setVolume, checkForUpdate, installUpdate, restartApp, listThemes, applyThemeByName, normGetState, normSetEnabled } from "../tauri";
import type { ThemeInfo, ContrastCheck } from "../tauri";

const APP_VERSION = "0.2.1";

function embedStatusClass(s: any): string {
  if (s.tracks_total === 0) return "status-pill--dim";
  if (s.embeddings_done === s.tracks_total) return "status-pill--ok";
  if (s.embeddings_failed > 0) return "status-pill--warn";
  return "status-pill--dim";
}

function embedStatusLabel(s: any): string {
  if (s.tracks_total === 0) return "Idle";
  if (s.embeddings_done === s.tracks_total) return "Complete";
  if (s.embeddings_pending > 0) return "Pending";
  if (s.embeddings_failed > 0) return "Partial";
  return "Idle";
}

function relativeTime(isoStr: string): string {
  try {
    const then = new Date(isoStr);
    const now = new Date();
    const diffMs = now.getTime() - then.getTime();
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
  } catch { return ""; }
}

function ThemeSection() {
  const [themes] = createResource(listThemes);
  const [active, setActive] = createSignal(localStorage.getItem("rustify-theme") || "");
  const [contrast, setContrast] = createSignal<ContrastCheck[]>([]);

  async function select(filename: string) {
    const checks = await applyThemeByName(filename);
    setActive(filename);
    setContrast(checks);
  }

  function resetTheme() {
    const root = document.documentElement;
    root.removeAttribute("style");
    localStorage.removeItem("rustify-theme");
    setActive("");
    setContrast([]);
  }

  const failingChecks = () => contrast().filter(c => !c.pass_aa);

  return (
    <section class="settings-section">
      <h3 class="settings-section__title">Theme</h3>
      <div class="settings-row">
        <label class="settings-row__label">Active theme</label>
        <div class="settings-row__control">
          <Show when={themes()} fallback={<span>Loading...</span>}>
            {(t) => (
              <select
                class="settings-input"
                value={active()}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  if (v) select(v); else resetTheme();
                }}
              >
                <option value="">Default (Copper)</option>
                <For each={t()}>
                  {(theme) => <option value={theme.filename}>{theme.name}</option>}
                </For>
              </select>
            )}
          </Show>
        </div>
      </div>
      <Show when={failingChecks().length > 0}>
        <div class="settings-row">
          <label class="settings-row__label">Contrast</label>
          <div class="settings-row__control" style="flex-direction: column; align-items: flex-start; gap: 4px;">
            <For each={failingChecks()}>
              {(c) => (
                <span class="status-pill status-pill--warn" style="font-size: 10px;">
                  {c.pair}: {c.ratio.toFixed(1)}:1 (needs 4.5:1)
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={contrast().length > 0 && failingChecks().length === 0}>
        <div class="settings-row">
          <label class="settings-row__label">Contrast</label>
          <span class="status-pill status-pill--ok">All pairs pass WCAG AA</span>
        </div>
      </Show>
      <p class="settings-section__note">
        Themes: ~/.local/share/rustify-player/themes/ — drop YAML files to add custom themes.
      </p>
    </section>
  );
}

export default function Settings() {
  const [data] = createResource(async () => {
    const [snapshot, albums, artists, genres] = await Promise.all([
      libSnapshot(),
      libGetAlbums(10000),
      libGetArtists(10000),
      libListGenres(),
    ]);
    return { snapshot, albums, artists, genres };
  });

  const [volumePct, setVolumePct] = createSignal(80);
  const [scanning, setScanning] = createSignal(false);
  const [scanLabel, setScanLabel] = createSignal("Re-scan library");

  // Loudness normalization toggle. Hydrate from backend on mount; the
  // localStorage cache is used only for the optimistic initial render.
  const cachedNorm = localStorage.getItem("rustify-norm-enabled");
  const [normEnabled, setNormEnabled] = createSignal(cachedNorm === null ? true : cachedNorm === "true");

  onMount(() => {
    normGetState()
      .then((on) => {
        setNormEnabled(on);
        localStorage.setItem("rustify-norm-enabled", String(on));
      })
      .catch((e) => console.error("[norm] get_state failed:", e));
  });

  function handleNormToggle(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    setNormEnabled(checked);
    localStorage.setItem("rustify-norm-enabled", String(checked));
    normSetEnabled(checked).catch((err) => {
      console.error("[norm] set_enabled failed:", err);
      // Revert the optimistic update.
      setNormEnabled(!checked);
      localStorage.setItem("rustify-norm-enabled", String(!checked));
    });
  }

  const [updateStatus, setUpdateStatus] = createSignal<string | null>(null);
  const [updateResult, setUpdateResult] = createSignal<any>(null);
  const [checking, setChecking] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);

  function handleRescan() {
    setScanning(true);
    setScanLabel("Scanning...");
    libRescan().then(() => {
      setScanLabel("Scan started");
      setTimeout(() => { setScanning(false); setScanLabel("Re-scan library"); }, 5000);
    }).catch(() => { setScanLabel("Scan failed"); setScanning(false); });
  }

  function handleVolumeChange(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    setVolumePct(val);
    setVolume(val / 100).catch((err) => console.error("[player] set_volume failed:", err));
  }

  async function handleCheckUpdate() {
    setChecking(true);
    setUpdateStatus("Checking...");
    try {
      const result = await checkForUpdate();
      setUpdateResult(result);
      if (result.error) {
        setUpdateStatus(result.message);
      } else if (result.update_available) {
        setUpdateStatus("update_available");
      } else {
        setUpdateStatus("up_to_date");
      }
    } catch (err) {
      setUpdateStatus(`Check failed: ${err}`);
    } finally {
      setChecking(false);
    }
  }

  async function handleInstall() {
    setInstalling(true);
    try {
      await installUpdate();
      setUpdateStatus("installed");
    } catch (err) {
      setUpdateStatus(`Install failed: ${err}`);
      setInstalling(false);
    }
  }

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Settings</h1>
        <div class="view__stats"><span class="view__stats-item">v{APP_VERSION}</span></div>
      </header>

      <div class="view__body">
        <Show when={data()} fallback={
          <div class="empty-state"><p class="empty-state__title">Loading...</p></div>
        }>
          {(d) => {
            const snap = d().snapshot;
            const genresPopulated = d().genres.filter((g: any) => g.track_count > 0).length;

            return <>
              {/* Library */}
              <section class="settings-section">
                <h3 class="settings-section__title">Library</h3>
                <div class="settings-row">
                  <label class="settings-row__label">Music root</label>
                  <input type="text" class="settings-input" value="~/Music" readonly />
                </div>
                <div class="settings-row">
                  <label class="settings-row__label">Re-scan</label>
                  <div class="settings-row__control">
                    <button class="settings-button" disabled={scanning()} onClick={handleRescan}>{scanLabel()}</button>
                  </div>
                </div>
                <div class="stats-grid">
                  <div class="stat-card">
                    <span class="stat-card__value">{snap.tracks_total}</span>
                    <span class="stat-card__label">Tracks</span>
                  </div>
                  <div class="stat-card">
                    <span class="stat-card__value">{d().albums.length}</span>
                    <span class="stat-card__label">Albums</span>
                  </div>
                  <div class="stat-card">
                    <span class="stat-card__value">{d().artists.length}</span>
                    <span class="stat-card__label">Artists</span>
                  </div>
                  <div class="stat-card">
                    <span class="stat-card__value">{genresPopulated}</span>
                    <span class="stat-card__label">Genres</span>
                  </div>
                </div>
              </section>

              {/* Theme */}
              <ThemeSection />

              {/* Audio */}
              <section class="settings-section">
                <h3 class="settings-section__title">Audio</h3>
                <div class="settings-row">
                  <label class="settings-row__label">Volume</label>
                  <div class="settings-row__control">
                    <input type="range" class="settings-range" min="0" max="100" value={volumePct()} onInput={handleVolumeChange} />
                    <span class="settings-range__value">{volumePct()}%</span>
                  </div>
                </div>
                <div class="settings-row">
                  <label class="settings-row__label">Normalizar volume entre faixas</label>
                  <div class="settings-row__control">
                    <input
                      type="checkbox"
                      class="settings-checkbox"
                      checked={normEnabled()}
                      onChange={handleNormToggle}
                    />
                    <span class="settings-row__hint">
                      Aplica ganho EBU R128 (alvo -14 LUFS) entre EQ e Limiter.
                    </span>
                  </div>
                </div>
                <div class="settings-row">
                  <label class="settings-row__label">Output device</label>
                  <select class="settings-input" disabled>
                    <option>System default</option>
                  </select>
                </div>
              </section>

              {/* Embedding */}
              <section class="settings-section">
                <h3 class="settings-section__title">Embedding</h3>
                <div class="settings-row">
                  <label class="settings-row__label">Status</label>
                  <div class="settings-row__control">
                    <span class={`status-pill ${embedStatusClass(snap)}`}>{embedStatusLabel(snap)}</span>
                    <span class="settings-row__hint">{snap.embeddings_done}/{snap.tracks_total} tracks embedded</span>
                  </div>
                </div>
                <p class="settings-section__note">
                  Embeddings power similarity search via MERT-v1-95M running on the remote service.
                  Similarity queries require embeddings to be populated.
                </p>
              </section>

              {/* Updates */}
              <section class="settings-section">
                <h3 class="settings-section__title">Updates</h3>
                <div class="settings-row">
                  <label class="settings-row__label">Status</label>
                  <div class="settings-row__control">
                    <Show when={updateStatus() === "update_available"}>
                      <span class="status-pill status-pill--warn">Update available</span>
                      <span class="settings-row__hint">
                        v{updateResult()?.current_version} {"→"} v{updateResult()?.latest_version}
                        {updateResult()?.published_at ? ` (published ${relativeTime(updateResult().published_at)})` : ""}
                      </span>
                    </Show>
                    <Show when={updateStatus() === "up_to_date"}>
                      <span class="status-pill status-pill--ok">Up to date</span>
                      <span class="settings-row__hint">v{updateResult()?.current_version}</span>
                    </Show>
                    <Show when={updateStatus() === "installed"}>
                      <span class="status-pill status-pill--ok">Installed</span>
                      <span class="settings-row__hint">Update installed — restart to apply.</span>
                    </Show>
                    <Show when={updateStatus() && !["update_available", "up_to_date", "installed"].includes(updateStatus()!)}>
                      <span class="settings-row__value settings-row__value--muted">{updateStatus()}</span>
                    </Show>
                    <Show when={!updateStatus()}>
                      <span class="settings-row__value settings-row__value--muted">Not checked</span>
                    </Show>
                  </div>
                </div>
                <div class="settings-row">
                  <label class="settings-row__label">Action</label>
                  <div class="settings-row__control">
                    <Show when={updateStatus() === "installed"}>
                      <button class="settings-button settings-button--primary" onClick={() => restartApp()}>
                        Restart Now
                      </button>
                    </Show>
                    <Show when={updateStatus() === "update_available"}>
                      <button class="settings-button settings-button--primary" disabled={installing()} onClick={handleInstall}>
                        {installing() ? "Installing..." : "Install Update"}
                      </button>
                    </Show>
                    <button class="settings-button" disabled={checking()} onClick={handleCheckUpdate}>
                      {checking() ? "Checking..." : "Check for updates"}
                    </button>
                  </div>
                </div>
              </section>

              {/* About */}
              <section class="settings-section">
                <h3 class="settings-section__title">About</h3>
                <div class="settings-row">
                  <label class="settings-row__label">Version</label>
                  <span class="settings-row__value">{APP_VERSION}</span>
                </div>
                <div class="settings-row">
                  <label class="settings-row__label">Repository</label>
                  <span class="settings-row__value settings-row__value--muted">rustify-player</span>
                </div>
              </section>
            </>;
          }}
        </Show>
      </div>
    </article>
  );
}
