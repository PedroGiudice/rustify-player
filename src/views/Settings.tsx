/* ============================================================
   views/Settings.tsx — Library, Audio, Theme, Updates.

   Pos-redesign Extractor Lab: panel + toggle-row + segmented.
   Logica restaurada do Settings pre-redesign (commit c3c2a9e)
   pra nao perder Library stats, Theme picker, Volume slider,
   Loudness normalization e principalmente o fluxo de Update
   (check / install / restart).
   ============================================================ */

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { Icon, ICONS } from "../components/Icon";
import {
  libSnapshot, libGetAlbums, libGetArtists, libListGenres,
  libRescan, setVolume, normGetState, normSetEnabled,
  listThemes, applyThemeByName, watchTheme,
  checkForUpdate, installUpdate, restartApp,
  type ContrastCheck,
} from "../tauri";
import { player, setPlayer } from "../store/player";

function relativeTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "";
  try {
    const then = new Date(isoStr);
    const diffSecs = Math.floor((Date.now() - then.getTime()) / 1000);
    if (diffSecs < 60) return "just now";
    if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)} min ago`;
    if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)} h ago`;
    return then.toLocaleDateString();
  } catch { return ""; }
}

function embedStatus(s: any): { cls: string; label: string } {
  if (!s || s.tracks_total === 0) return { cls: "status-pill--dim", label: "Idle" };
  if (s.embeddings_done === s.tracks_total) return { cls: "status-pill--ok", label: "Complete" };
  if (s.embeddings_failed > 0) return { cls: "status-pill--warn", label: "Partial" };
  if (s.embeddings_pending > 0) return { cls: "status-pill--dim", label: "Pending" };
  return { cls: "status-pill--dim", label: "Idle" };
}

export default function Settings() {
  // ── Dados da biblioteca + versao ─────────────────────────────
  const [data] = createResource(async () => {
    const [snapshot, albums, artists, genres] = await Promise.all([
      libSnapshot().catch(() => ({ tracks_total: 0, albums_total: 0, artists_total: 0, embeddings_done: 0, embeddings_pending: 0, embeddings_failed: 0 })),
      libGetAlbums({ limit: 10000 }).catch(() => []),
      libGetArtists({ limit: 10000 }).catch(() => []),
      libListGenres().catch(() => []),
    ]);
    return { snapshot, albums, artists, genres };
  });

  const [version] = createResource(async () => {
    try { return await (window as any).__TAURI__?.app?.getVersion?.() ?? "—"; }
    catch { return "—"; }
  });

  // ── Theme picker ─────────────────────────────────────────────
  const [themes] = createResource(listThemes);
  const [activeTheme, setActiveTheme] = createSignal(localStorage.getItem("rustify-theme") || "");
  const [contrast, setContrast] = createSignal<ContrastCheck[]>([]);

  async function selectTheme(filename: string) {
    if (!filename) {
      document.documentElement.removeAttribute("style");
      localStorage.removeItem("rustify-theme");
      setActiveTheme("");
      setContrast([]);
      return;
    }
    const checks = await applyThemeByName(filename);
    setActiveTheme(filename);
    setContrast(checks);
    watchTheme(filename).catch((e) => console.warn("[theme] watch failed:", e));
  }

  const failingContrast = () => contrast().filter((c) => !c.pass_aa);

  // ── Volume + normalize ───────────────────────────────────────
  const volumePct = () => Math.round(player.volume * 100);

  function onVolumeChange(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    const vol = val / 100;
    setPlayer("volume", vol);
    setPlayer("isMuted", false);
    setVolume(vol).catch((err) => console.error("[player] set_volume failed:", err));
  }

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

  function toggleNorm() {
    const next = !normEnabled();
    setNormEnabled(next);
    localStorage.setItem("rustify-norm-enabled", String(next));
    normSetEnabled(next).catch((err) => {
      console.error("[norm] set_enabled failed:", err);
      setNormEnabled(!next);
      localStorage.setItem("rustify-norm-enabled", String(!next));
    });
  }

  // ── Re-scan ──────────────────────────────────────────────────
  const [scanning, setScanning] = createSignal(false);
  const [scanLabel, setScanLabel] = createSignal("Re-scan");

  function handleRescan() {
    setScanning(true);
    setScanLabel("Scanning...");
    libRescan()
      .then(() => {
        setScanLabel("Started");
        setTimeout(() => { setScanning(false); setScanLabel("Re-scan"); }, 5000);
      })
      .catch(() => { setScanLabel("Failed"); setScanning(false); });
  }

  // ── Update flow ──────────────────────────────────────────────
  const [updateStatus, setUpdateStatus] = createSignal<string | null>(null);
  const [updateResult, setUpdateResult] = createSignal<any>(null);
  const [checking, setChecking] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);

  async function handleCheckUpdate() {
    setChecking(true);
    setUpdateStatus("Checking...");
    try {
      const result = await checkForUpdate();
      setUpdateResult(result);
      if (result?.error) setUpdateStatus(result.message ?? "Check failed");
      else if (result?.update_available) setUpdateStatus("update_available");
      else setUpdateStatus("up_to_date");
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
      <header class="view__head">
        <div>
          <h1>Settings</h1>
          <p class="view__head-hint">Library, audio, theme, updates.</p>
        </div>
        <div class="view__stats">
          <span><b>v{version() ?? "—"}</b></span>
        </div>
      </header>

      <div class="view__body" style={{ "max-width": "760px" }}>

        {/* ── Library ────────────────────────────────────────── */}
        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Library</h3>
          </div>

          <Show when={data()}>
            {(d) => {
              const snap = d().snapshot;
              const populated = d().genres.filter((g: any) => g.track_count > 0).length;
              const st = embedStatus(snap);
              return (
                <>
                  <div class="stat-grid">
                    <div class="stat-tile">
                      <span class="stat-tile__label">TRACKS</span>
                      <span class="stat-tile__value">{snap.tracks_total}</span>
                      <span class="stat-tile__sub">indexed</span>
                    </div>
                    <div class="stat-tile">
                      <span class="stat-tile__label">ALBUMS</span>
                      <span class="stat-tile__value">{d().albums.length}</span>
                      <span class="stat-tile__sub">distinct</span>
                    </div>
                    <div class="stat-tile">
                      <span class="stat-tile__label">ARTISTS</span>
                      <span class="stat-tile__value">{d().artists.length}</span>
                      <span class="stat-tile__sub">distinct</span>
                    </div>
                    <div class="stat-tile">
                      <span class="stat-tile__label">GENRES</span>
                      <span class="stat-tile__value">{populated}</span>
                      <span class="stat-tile__sub">populated</span>
                    </div>
                  </div>

                  <div class="toggle-row">
                    <div>
                      <div class="toggle-row__label">Music root</div>
                      <div class="toggle-row__hint mono">~/Music</div>
                    </div>
                    <button
                      class="chip"
                      disabled
                      title="Backend ainda nao expoe lib_set_library_path"
                    >
                      Trocar…
                    </button>
                  </div>

                  <div class="toggle-row">
                    <div>
                      <div class="toggle-row__label">Re-scan biblioteca</div>
                      <div class="toggle-row__hint">Re-indexa metadados e gera embeddings faltantes.</div>
                    </div>
                    <button
                      class="chip"
                      disabled={scanning()}
                      onClick={handleRescan}
                    >
                      <Icon name={ICONS.bolt} size={12} /> {scanLabel()}
                    </button>
                  </div>

                  <div class="toggle-row">
                    <div>
                      <div class="toggle-row__label">Embeddings</div>
                      <div class="toggle-row__hint">
                        {snap.embeddings_done}/{snap.tracks_total} tracks · powered by MERT-v1-95M
                      </div>
                    </div>
                    <span class={`status-pill ${st.cls}`}>{st.label}</span>
                  </div>
                </>
              );
            }}
          </Show>
        </section>

        {/* ── Audio ──────────────────────────────────────────── */}
        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Audio</h3>
          </div>

          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Volume</div>
              <div class="toggle-row__hint">Aplicado no engine; sincroniza com o slider do PlayerBar.</div>
            </div>
            <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
              <input
                type="range"
                class="slider"
                min="0"
                max="100"
                value={volumePct()}
                onInput={onVolumeChange}
                style={{ width: "180px" }}
              />
              <span class="mono" style={{ "font-size": "11px", color: "var(--fg-5)", "min-width": "32px" }}>
                {volumePct()}%
              </span>
            </div>
          </div>

          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Normalizar volume entre faixas</div>
              <div class="toggle-row__hint">EBU R128 alvo −14 LUFS, entre EQ e Limiter.</div>
            </div>
            <button
              class="toggle"
              aria-pressed={normEnabled() ? "true" : "false"}
              onClick={toggleNorm}
              type="button"
            />
          </div>

          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Output device</div>
              <div class="toggle-row__hint">PipeWire default sink.</div>
            </div>
            <select class="chip" disabled>
              <option>System default</option>
            </select>
          </div>
        </section>

        {/* ── Theme ──────────────────────────────────────────── */}
        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Theme</h3>
          </div>

          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Active theme</div>
              <div class="toggle-row__hint">YAMLs em ~/.local/share/rustify-player/themes/</div>
            </div>
            <Show when={themes()} fallback={<span class="mono" style={{ "font-size": "11px", color: "var(--fg-5)" }}>loading…</span>}>
              {(t) => (
                <select
                  class="chip"
                  value={activeTheme()}
                  onChange={(e) => selectTheme(e.currentTarget.value)}
                >
                  <option value="">Default (Extractor Lab)</option>
                  <For each={t()}>
                    {(theme) => <option value={theme.filename}>{theme.name}</option>}
                  </For>
                </select>
              )}
            </Show>
          </div>

          <Show when={contrast().length > 0}>
            <div class="toggle-row">
              <div>
                <div class="toggle-row__label">Contrast (WCAG AA)</div>
                <Show
                  when={failingContrast().length > 0}
                  fallback={<div class="toggle-row__hint">All pairs pass AA.</div>}
                >
                  <div class="toggle-row__hint">
                    <For each={failingContrast()}>
                      {(c) => <div>{c.pair}: {c.ratio.toFixed(1)}:1 (needs 4.5:1)</div>}
                    </For>
                  </div>
                </Show>
              </div>
              <span class={`status-pill ${failingContrast().length > 0 ? "status-pill--warn" : "status-pill--ok"}`}>
                {failingContrast().length > 0 ? `${failingContrast().length} fail` : "AA pass"}
              </span>
            </div>
          </Show>
        </section>

        {/* ── Updates ────────────────────────────────────────── */}
        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Updates</h3>
          </div>

          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Status</div>
              <div class="toggle-row__hint">
                <Show when={updateStatus() === "update_available"}>
                  v{updateResult()?.current_version} → v{updateResult()?.latest_version}
                  {updateResult()?.published_at ? ` (publicado ${relativeTime(updateResult().published_at)})` : ""}
                </Show>
                <Show when={updateStatus() === "up_to_date"}>
                  Voce esta na ultima — v{updateResult()?.current_version ?? version()}
                </Show>
                <Show when={updateStatus() === "installed"}>
                  Update instalado — reinicie pra aplicar.
                </Show>
                <Show when={updateStatus() && !["update_available", "up_to_date", "installed", "Checking..."].includes(updateStatus()!)}>
                  {updateStatus()}
                </Show>
                <Show when={updateStatus() === "Checking..."}>
                  Verificando no GitHub releases…
                </Show>
                <Show when={!updateStatus()}>
                  Clique em "Check for updates" pra verificar.
                </Show>
              </div>
            </div>

            <Show
              when={updateStatus() === "installed"}
              fallback={
                <Show
                  when={updateStatus() === "update_available"}
                  fallback={
                    <button class="chip" disabled={checking()} onClick={handleCheckUpdate}>
                      {checking() ? "Checking..." : "Check for updates"}
                    </button>
                  }
                >
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button class="chip" disabled={installing()} onClick={handleInstall}>
                      {installing() ? "Installing..." : "Install Update"}
                    </button>
                    <button class="chip" disabled={checking()} onClick={handleCheckUpdate}>
                      Recheck
                    </button>
                  </div>
                </Show>
              }
            >
              <button class="chip" onClick={() => restartApp()}>
                Restart Now
              </button>
            </Show>
          </div>
        </section>

        {/* ── About ──────────────────────────────────────────── */}
        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Sobre</h3>
          </div>
          <p class="mono" style={{ "font-size": "12px", color: "var(--fg-5)" }}>
            rustify-player · v{version() ?? "—"} · Tauri 2 + SolidJS · Extractor Lab UI
          </p>
        </section>

      </div>
    </article>
  );
}
