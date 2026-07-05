/* ============================================================
   views/Settings.tsx — Settings hi-fi com 4 paineis.

   Recriacao da view Settings seguindo o mockup do handoff
   (data-screen="settings"). 4 paineis verticais:

   1. Appearance — Theme segmented (Light/Dark/Auto),
      Compact sidebar tog, Cinema mode kbd, Beat sync segmented
      (Off/Subtle/Default/Pulse) persistindo em rustify-mock-sync.
   2. Playback — Resume on launch tog, Volume slider, Normalize tog.
      (Tier 0 removeu crossfade, gapless, output device, scrobble.)
   3. Library — Music folder (read-only), Re-scan (accent), Embeddings
      (read-only stat), qdrant status (read-only), library stats tile grid.
   4. About — grid 6 items mono (Version, Tauri, Backend,
      Identifier, Branch, License).

   PRESERVADO do Settings antigo (NAO QUEBRAR):
   - Update flow (checkForUpdate / installUpdate / restartApp)
   - Library stats (libSnapshot + albums/artists/genres counts)
   - Volume + normalize (norm_get_state)
   - Theme picker dinamico via listThemes / applyThemeByName
   ============================================================ */

import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  libSnapshot, libGetAlbums, libGetArtists, libListGenres,
  libRescan, setVolume, normGetState, normSetEnabled,
  listThemes, applyThemeByName, watchTheme, onThemeChanged,
  checkForUpdate, installUpdate, restartApp,
  type ContrastCheck,
} from "../tauri";
import { applyTweaks } from "../store/tweaks";
import { player, setPlayer } from "../store/player";

// ── Helpers locais ──────────────────────────────────────────────

/** Classifica um par de contraste segundo WCAG 2.1 */
function wcagLabel(c: ContrastCheck): string {
  if (c.pass_aaa) return "AAA";
  if (c.pass_aa)  return "AA";
  // AA-large: 3:1 pra texto grande (>=18pt ou >=14pt bold)
  if (c.ratio >= 3.0) return "AA-large";
  return "fail";
}

/** Classe CSS para o badge de classificacao */
function wcagBadgeClass(c: ContrastCheck): string {
  if (c.pass_aaa) return "status-pill status-pill--ok";
  if (c.pass_aa)  return "status-pill status-pill--ok";
  // warn para AA-large (3:1) e para fail — components.css nao tem --err
  return "status-pill status-pill--warn";
}

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

// ── localStorage keys que dialogam com T10 (SpectrumCanvas) ─────
const SYNC_KEY = "rustify-mock-sync";
type SyncMode = "off" | "subtle" | "default" | "pulse";
function loadSyncMode(): SyncMode {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw === "off" || raw === "subtle" || raw === "default" || raw === "pulse") return raw;
  } catch {}
  return "default";
}
function saveSyncMode(m: SyncMode) {
  try { localStorage.setItem(SYNC_KEY, m); } catch {}
}

// Outros toggles client-only (futuro: persistir via store plugin)
const COMPACT_KEY = "rustify-mock-compact-sidebar";
const RESUME_KEY  = "rustify-mock-resume-launch";

// Tema theme picker — bridge entre seg (Light/Dark/Auto) e o
// listThemes existente. Light/Dark/Auto sao "modes" cosmeticos
// que afetam document.body[data-theme]. O picker custom continua
// disponivel pra YAMLs custom (mas movemos pra dentro do mesmo
// painel pra nao quebrar fluidez).
type ThemeMode = "light" | "dark" | "auto";
const THEME_MODE_KEY = "rustify-theme-mode";
function loadThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_MODE_KEY);
    if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  } catch {}
  return "light";
}

function applyThemeMode(m: ThemeMode) {
  try {
    if (m === "auto") {
      document.body.removeAttribute("data-theme");
    } else {
      document.body.setAttribute("data-theme", m);
    }
    localStorage.setItem(THEME_MODE_KEY, m);
  } catch {}
}

export default function Settings() {
  // ── Library data (preservado) ─────────────────────────────────
  const [data] = createResource(async () => {
    const [snapshot, albums, artists, genres] = await Promise.all([
      libSnapshot().catch(() => ({
        tracks_total: 0, albums_total: 0, artists_total: 0,
        embeddings_done: 0, embeddings_pending: 0, embeddings_failed: 0,
      })),
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

  // ── Theme picker (preservado, dentro do painel Appearance) ───
  const [themes] = createResource(listThemes);
  const [activeTheme, setActiveTheme] = createSignal(localStorage.getItem("rustify-theme") || "");
  const [contrast, setContrast] = createSignal<ContrastCheck[]>([]);

  async function selectThemeFile(filename: string) {
    if (!filename) {
      document.documentElement.removeAttribute("style");
      localStorage.removeItem("rustify-theme");
      setActiveTheme("");
      setContrast([]);
      // O removeAttribute acima apaga TODAS as inline vars — inclusive as
      // dos Tweaks (zoom, glow, fontes). Notifica o store (ink do tema
      // deixa de existir) e re-aplica os tweaks por inteiro.
      window.dispatchEvent(new CustomEvent("rustify:theme-applied", {
        detail: { ink: null },
      }));
      applyTweaks();
      return;
    }
    const checks = await applyThemeByName(filename);
    setActiveTheme(filename);
    setContrast(checks);
    // Inicia watcher de hot-reload para este arquivo YAML.
    // Quando o watcher emite "theme-changed", o listener abaixo (no onMount)
    // re-aplica e re-calcula o contraste.
    watchTheme(filename).catch((e) => console.warn("[theme] watch failed:", e));
  }

  const failingContrast = () => contrast().filter((c) => !c.pass_aa);

  // ── Theme mode (Light/Dark/Auto) — seg do Appearance ──────────
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(loadThemeMode());
  function pickThemeMode(m: ThemeMode) {
    setThemeMode(m);
    applyThemeMode(m);
  }

  // ── Beat sync (seg do Appearance, persist em rustify-mock-sync)
  const [syncMode, setSyncMode] = createSignal<SyncMode>(loadSyncMode());
  function pickSync(m: SyncMode) {
    setSyncMode(m);
    saveSyncMode(m);
  }

  // ── Toggles cosmeticos (compact sidebar, resume) ─────
  const [compact, setCompact] = createSignal(localStorage.getItem(COMPACT_KEY) === "true");
  function toggleCompact() {
    const next = !compact();
    setCompact(next);
    try { localStorage.setItem(COMPACT_KEY, String(next)); } catch {}
  }
  const [resumeLaunch, setResumeLaunch] = createSignal(localStorage.getItem(RESUME_KEY) !== "false");
  function toggleResume() {
    const next = !resumeLaunch();
    setResumeLaunch(next);
    try { localStorage.setItem(RESUME_KEY, String(next)); } catch {}
  }

  // ── Volume + normalize (preservado, visual ainda no painel Audio
  //    do Playback — apesar de o mockup nao mostrar volume aqui,
  //    a logica precisa ficar acessivel) ──────────────────────────
  const cachedNorm = localStorage.getItem("rustify-norm-enabled");
  const [normEnabled, setNormEnabled] = createSignal(cachedNorm === null ? true : cachedNorm === "true");

  onMount(() => {
    normGetState()
      .then((on) => {
        setNormEnabled(on);
        localStorage.setItem("rustify-norm-enabled", String(on));
      })
      .catch((e) => console.error("[norm] get_state failed:", e));

    // Re-aplica theme mode salvo no boot pra refletir em document.body.
    applyThemeMode(themeMode());

    // Listener de hot-reload: quando o watcher de arquivo YAML emite
    // "theme-changed", re-aplica o tema e atualiza o contraste calculado.
    // Isso garante que a calculadora reflete o estado atual apos edicoes
    // ao vivo nos YAMLs de tema.
    const unlisten = onThemeChanged((filename) => {
      if (!filename) return;
      applyThemeByName(filename)
        .then((checks) => setContrast(checks))
        .catch((e) => console.warn("[theme] hot-reload failed:", e));
    });
    // `onThemeChanged` retorna uma Promise<UnlistenFn>; cancelamos no cleanup.
    onCleanup(() => { unlisten.then((fn) => fn()).catch(() => {}); });
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

  const volumePct = () => Math.round(player.volume * 100);
  function onVolumeChange(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    const vol = val / 100;
    setPlayer("volume", vol);
    setPlayer("isMuted", false);
    setVolume(vol).catch((err) => console.error("[player] set_volume failed:", err));
  }

  // ── Re-scan (preservado) ─────────────────────────────────────
  const [scanning, setScanning] = createSignal(false);
  const [scanLabel, setScanLabel] = createSignal("Re-scan");

  function handleRescan() {
    setScanning(true);
    setScanLabel("Scanning…");
    libRescan()
      .then(() => {
        setScanLabel("Started");
        setTimeout(() => { setScanning(false); setScanLabel("Re-scan"); }, 5000);
      })
      .catch(() => { setScanLabel("Failed"); setScanning(false); });
  }

  // ── Update flow (preservado) ─────────────────────────────────
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

  // Stats helpers
  const tracksTotal = () => data()?.snapshot.tracks_total ?? 0;
  const embedDone = () => data()?.snapshot.embeddings_done ?? 0;
  const albumsCount = () => data()?.albums.length ?? 0;
  const artistsCount = () => data()?.artists.length ?? 0;
  const genresPopulated = () => (data()?.genres ?? []).filter((g: any) => g.track_count > 0).length;

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Settings</h1>
          <p class="view__head-hint">Library, audio, appearance — v{version() ?? "—"}.</p>
        </div>
        <div class="view__stats">
          <span>config <b>~/.config/rustify-player</b></span>
        </div>
      </header>

      <div class="set">
        {/* ════════════════════════════════════════════════════════
            1. APPEARANCE
            ════════════════════════════════════════════════════════ */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">Appearance</h3>
            <span class="set-panel__sub">light is the default Extractor Lab palette</span>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Theme</div>
              <div class="set-row__hint">
                Light is the default. Auto follows your OS preference. Dark is the legacy editorial-hi-fi theme.
              </div>
            </div>
            <div class="set-row__control">
              <div class="seg">
                <button aria-pressed={themeMode() === "light" ? "true" : "false"} onClick={() => pickThemeMode("light")}>Light</button>
                <button aria-pressed={themeMode() === "dark" ? "true" : "false"} onClick={() => pickThemeMode("dark")}>Dark</button>
                <button aria-pressed={themeMode() === "auto" ? "true" : "false"} onClick={() => pickThemeMode("auto")}>Auto</button>
              </div>
            </div>
          </div>

          {/* Theme YAML picker — mantido pra estilos custom ── */}
          <div class="set-row">
            <div>
              <div class="set-row__label">Custom theme YAML</div>
              <div class="set-row__hint">YAMLs em ~/.local/share/rustify-player/themes/. Independente do mode acima.</div>
            </div>
            <div class="set-row__control">
              <Show
                when={themes()}
                fallback={<span class="mono" style={{ "font-size": "11px", color: "var(--fg-5)" }}>loading…</span>}
              >
                {(t) => (
                  <select
                    class="set-folder-btn"
                    value={activeTheme()}
                    onChange={(e) => selectThemeFile(e.currentTarget.value)}
                  >
                    <option value="">Default (Extractor Lab)</option>
                    <For each={t()}>
                      {(theme) => <option value={theme.filename}>{theme.name}</option>}
                    </For>
                  </select>
                )}
              </Show>
            </div>
          </div>

          <Show when={contrast().length > 0}>
            <div class="set-row set-row--col">
              <div style={{ width: "100%" }}>
                <div class="set-row__label" style={{ "margin-bottom": "8px" }}>
                  Contraste WCAG
                  <span
                    class={`status-pill ${failingContrast().length > 0 ? "status-pill--warn" : "status-pill--ok"}`}
                    style={{ "margin-left": "8px", "font-size": "10px", "vertical-align": "middle" }}
                  >
                    {failingContrast().length > 0 ? `${failingContrast().length} falha(s)` : "AA ok"}
                  </span>
                </div>
                {/* Tabela compacta com todos os pares */}
                <div style={{ display: "grid", "grid-template-columns": "1fr auto auto", gap: "2px 12px", "font-size": "11px", "font-family": "var(--font-mono)" }}>
                  <For each={contrast()}>
                    {(c) => (
                      <>
                        <span style={{ color: "var(--fg-4)", "overflow": "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{c.pair}</span>
                        <span style={{ color: "var(--fg-3)", "text-align": "right" }}>{c.ratio.toFixed(2)}:1</span>
                        <span class={wcagBadgeClass(c)} style={{ padding: "1px 5px", "font-size": "9px", "line-height": "1.6" }}>{wcagLabel(c)}</span>
                      </>
                    )}
                  </For>
                </div>
                <div class="set-row__hint" style={{ "margin-top": "6px" }}>
                  AA = 4.5:1 · AAA = 7:1 · AA-large = 3:1 (texto grande)
                </div>
              </div>
            </div>
          </Show>

          <div class="set-row">
            <div>
              <div class="set-row__label">Compact sidebar</div>
              <div class="set-row__hint">Collapses Coleções labels and shows icons only.</div>
            </div>
            <div class="set-row__control">
              <button
                class="tog"
                aria-pressed={compact() ? "true" : "false"}
                onClick={toggleCompact}
                type="button"
                title="Toggle compact sidebar"
              />
            </div>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Cinema mode shortcut</div>
              <div class="set-row__hint">Hotkey to collapse all chrome on Now Playing.</div>
            </div>
            <div class="set-row__control">
              <span class="kbd" style={{ "font-family": "var(--font-mono)", "font-size": "10.5px", padding: "2px 7px" }}>F</span>
            </div>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Beat sync</div>
              <div class="set-row__hint">
                Controla quanto a animacao do Now Playing reage ao envelope do audio.
                Pulse marca cada kick; Subtle so respira; Off desliga a reatividade.
              </div>
            </div>
            <div class="set-row__control">
              <div class="seg">
                <button aria-pressed={syncMode() === "off" ? "true" : "false"} onClick={() => pickSync("off")}>Off</button>
                <button aria-pressed={syncMode() === "subtle" ? "true" : "false"} onClick={() => pickSync("subtle")}>Subtle</button>
                <button aria-pressed={syncMode() === "default" ? "true" : "false"} onClick={() => pickSync("default")}>Default</button>
                <button aria-pressed={syncMode() === "pulse" ? "true" : "false"} onClick={() => pickSync("pulse")}>Pulse</button>
              </div>
            </div>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════
            2. PLAYBACK
            ════════════════════════════════════════════════════════ */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">Playback</h3>
            <span class="set-panel__sub">PipeWire · default sink</span>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Resume on launch</div>
              <div class="set-row__hint">Re-abre a ultima faixa na ultima posicao.</div>
            </div>
            <div class="set-row__control">
              <button class="tog" aria-pressed={resumeLaunch() ? "true" : "false"} onClick={toggleResume} type="button" title="Toggle resume" />
            </div>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Volume</div>
              <div class="set-row__hint">Sincroniza com o slider do PlayerBar (engine-level).</div>
            </div>
            <div class="set-row__control">
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

          <div class="set-row">
            <div>
              <div class="set-row__label">Normalizar volume entre faixas</div>
              <div class="set-row__hint">EBU R128 alvo −14 LUFS, entre EQ e Limiter.</div>
            </div>
            <div class="set-row__control">
              <button class="tog" aria-pressed={normEnabled() ? "true" : "false"} onClick={toggleNorm} type="button" />
            </div>
          </div>

        </div>

        {/* ════════════════════════════════════════════════════════
            3. LIBRARY (preservado: stats + rescan + embeddings)
            ════════════════════════════════════════════════════════ */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">Library</h3>
            <span class="set-panel__sub">
              {tracksTotal()} tracks · {albumsCount()} albums
            </span>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Music folder</div>
              <div class="set-row__hint mono">~/Music/library</div>
            </div>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Re-scan library</div>
              <div class="set-row__hint">Re-indexa metadados e gera embeddings faltantes.</div>
            </div>
            <div class="set-row__control">
              <button
                class="set-folder-btn set-folder-btn--accent"
                disabled={scanning()}
                onClick={handleRescan}
                type="button"
              >
                {/* @ts-ignore */}
                <iconify-icon icon="lucide:zap" noobserver />
                {scanLabel()}
              </button>
            </div>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">Embeddings</div>
              <div class="set-row__hint">
                {embedDone()} of {tracksTotal()} tracks tem AI embeddings.
                Drives the station recommender.
              </div>
            </div>
          </div>

          <div class="set-row">
            <div>
              <div class="set-row__label">qdrant process</div>
              <div class="set-row__hint mono">localhost:6333 · vec-dim 1024 · status ok</div>
            </div>
          </div>

          {/* Stats grid preservada ─────────────────────────────── */}
          <Show when={data()}>
            <div class="stat-grid" style={{ padding: "13px 20px", "border-top": "1px solid var(--line-3)" }}>
              <div class="stat-tile">
                <span class="stat-tile__label">TRACKS</span>
                <span class="stat-tile__value">{tracksTotal()}</span>
                <span class="stat-tile__sub">indexed</span>
              </div>
              <div class="stat-tile">
                <span class="stat-tile__label">ALBUMS</span>
                <span class="stat-tile__value">{albumsCount()}</span>
                <span class="stat-tile__sub">distinct</span>
              </div>
              <div class="stat-tile">
                <span class="stat-tile__label">ARTISTS</span>
                <span class="stat-tile__value">{artistsCount()}</span>
                <span class="stat-tile__sub">distinct</span>
              </div>
              <div class="stat-tile">
                <span class="stat-tile__label">GENRES</span>
                <span class="stat-tile__value">{genresPopulated()}</span>
                <span class="stat-tile__sub">populated</span>
              </div>
            </div>
          </Show>
        </div>

        {/* ════════════════════════════════════════════════════════
            4. ABOUT (grid 6 items mono + update flow preservado
               integrado como primeira row, antes do grid)
            ════════════════════════════════════════════════════════ */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">About</h3>
            <span class="set-panel__sub">rustify-player · Pedro Giudice</span>
          </div>

          {/* Update flow (preservado) ────────────────────────── */}
          <div class="set-row">
            <div>
              <div class="set-row__label">Updates</div>
              <div class="set-row__hint">
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
                  Clique em "Check for updates" pra verificar no GitHub releases.
                </Show>
              </div>
            </div>
            <div class="set-row__control">
              <Show
                when={updateStatus() === "installed"}
                fallback={
                  <Show
                    when={updateStatus() === "update_available"}
                    fallback={
                      <button class="set-folder-btn" disabled={checking()} onClick={handleCheckUpdate} type="button">
                        {checking() ? "Checking..." : "Check for updates"}
                      </button>
                    }
                  >
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button class="set-folder-btn set-folder-btn--accent" disabled={installing()} onClick={handleInstall} type="button">
                        {installing() ? "Installing..." : "Install Update"}
                      </button>
                      <button class="set-folder-btn" disabled={checking()} onClick={handleCheckUpdate} type="button">
                        Recheck
                      </button>
                    </div>
                  </Show>
                }
              >
                <button class="set-folder-btn set-folder-btn--accent" onClick={() => restartApp()} type="button">
                  Restart Now
                </button>
              </Show>
            </div>
          </div>

          <div class="set-about-grid">
            <div class="set-about-item">
              <span class="set-about-item__label">Version</span>
              <span class="set-about-item__value is-mono-strong">{version() ?? "—"}</span>
            </div>
            <div class="set-about-item">
              <span class="set-about-item__label">Tauri</span>
              <span class="set-about-item__value">2.x</span>
            </div>
            <div class="set-about-item">
              <span class="set-about-item__label">Backend</span>
              <span class="set-about-item__value">Rust · GStreamer · cpal</span>
            </div>
            <div class="set-about-item">
              <span class="set-about-item__label">Identifier</span>
              <span class="set-about-item__value">dev.cmr.rustifyplayer</span>
            </div>
            <div class="set-about-item">
              <span class="set-about-item__label">Branch</span>
              <span class="set-about-item__value">feature/signal-screens-handoff</span>
            </div>
            <div class="set-about-item">
              <span class="set-about-item__label">License</span>
              <span class="set-about-item__value">GPL-3.0</span>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
