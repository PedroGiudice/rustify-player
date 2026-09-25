/* ============================================================
   views/Settings.tsx — Settings hi-fi com 4 paineis.

   Recriacao da view Settings seguindo o mockup do handoff
   (data-screen="settings"). 4 paineis verticais:

   1. Appearance — tema YAML (o tema é o modo: não há mais seletor
      Light/Dark/Auto, que gravava um body[data-theme] sem CSS),
      Compact sidebar tog e Beat sync (o MESMO estado do Tweaks:
      sidebar e bgBeatMode), Cinema mode kbd.
   2. Playback — Resume on launch tog (preferência lida pelo
      PlayerBar no boot), Volume slider, Normalize tog.
      (Tier 0 removeu crossfade, gapless, output device, scrobble.)
   3. Library — Music folder (read-only), Re-scan (accent), Embeddings
      (read-only stat), qdrant (endpoint e vetores; o status NAO e
      consultado, entao nao e exibido), library stats tile grid.
   4. About — grid mono (Version, Tauri, Backend, Identifier, License).
      Os valores fixos aqui precisam bater com o Cargo.toml.

   PRESERVADO do Settings antigo (NAO QUEBRAR):
   - Update flow (checkForUpdate / installUpdate / restartApp)
   - Library stats (libSnapshot + albums/artists/genres counts)
   - Volume + normalize (norm_get_state)
   - Theme picker dinamico via listThemes / applyThemeByName
   ============================================================ */

import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  libSnapshot, libGetAlbums, libGetArtists, libListGenres,
  libRescan,
  listThemes, applyThemeByName, loadTheme, watchTheme, onThemeChanged,
  clearThemeVars,
  checkForUpdate, installUpdate, restartApp,
  type ContrastCheck,
} from "../tauri";
import { applyTweaks, tweaks, updateTweak, type TweaksState } from "../store/tweaks";
import { player, changeVolume, resumeOnLaunch, setResumeOnLaunch } from "../store/player";

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
      clearThemeVars();
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

  // ── Compact sidebar e Beat sync: o MESMO estado do Tweaks ────
  // (antes gravavam chaves que nenhum outro arquivo lia — cfg-1).
  const compactSidebar = () => tweaks().sidebar === "icons";
  function toggleCompact() {
    updateTweak("sidebar", compactSidebar() ? "labels" : "icons");
  }
  const BEAT_MODES: Array<[TweaksState["bgBeatMode"], string]> = [
    ["off", "Off"], ["speed", "Speed"], ["pulse", "Pulse"],
  ];

  function toggleResume() {
    setResumeOnLaunch(!resumeOnLaunch());
  }

  // ── Volume + normalize (preservado, visual ainda no painel Audio
  //    do Playback — apesar de o mockup nao mostrar volume aqui,
  //    a logica precisa ficar acessivel) ──────────────────────────
  onMount(() => {
    // Hot-reload de tema: quem APLICA é o listener do boot (main.tsx) —
    // registrar um segundo applyThemeByName aqui duplicava IPC e aplicação
    // (achado da auditoria). Este listener só atualiza a calculadora de
    // contraste da view, via loadTheme (leitura pura, não aplica).
    const unlisten = onThemeChanged((filename) => {
      if (!filename) return;
      loadTheme(filename)
        .then((r) => setContrast(r.contrast))
        .catch((e) => console.warn("[theme] refresh contrast failed:", e));
    });
    // `onThemeChanged` retorna uma Promise<UnlistenFn>; cancelamos no cleanup.
    onCleanup(() => { unlisten.then((fn) => fn()).catch(() => {}); });
  });

  // Normalize: fonte ÚNICA é tweaks().loudnessNorm — o effect de loudness
  // do store empurra pro backend. O estado local + localStorage paralelo
  // que vivia aqui revertia silenciosamente (auditoria: o store re-aplicava
  // o valor antigo a cada mudança de qualquer tweak).
  function toggleNorm() {
    updateTweak("loudnessNorm", !tweaks().loudnessNorm);
  }

  const volumePct = () => Math.round(player.volume * 100);
  function onVolumeChange(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    const vol = val / 100;
    // changeVolume persiste (kv-volume) além de store + engine.
    changeVolume(vol).catch((err) => console.error("[player] set_volume failed:", err));
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
          <span>data <b>~/.local/share/rustify-player</b></span>
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

          {/* Theme YAML picker — mantido pra estilos custom ── */}
          <div class="set-row">
            <div>
              <div class="set-row__label">Custom theme YAML</div>
              <div class="set-row__hint">YAMLs em ~/.local/share/rustify-player/themes/.</div>
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
              <div class="set-row__hint">Shows icons only. Same knob as Tweaks › Sidebar.</div>
            </div>
            <div class="set-row__control">
              <button
                class="tog"
                aria-pressed={compactSidebar() ? "true" : "false"}
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
                Mesmo controle do Tweaks: Speed acelera o movimento do fundo no kick;
                Pulse pulsa a amplitude no tempo; Off desliga a reatividade ao beat.
              </div>
            </div>
            <div class="set-row__control">
              <div class="seg">
                <For each={BEAT_MODES}>
                  {([mode, label]) => (
                    <button
                      type="button"
                      aria-pressed={tweaks().bgBeatMode === mode ? "true" : "false"}
                      onClick={() => updateTweak("bgBeatMode", mode)}
                    >
                      {label}
                    </button>
                  )}
                </For>
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
              <button class="tog" aria-pressed={resumeOnLaunch() ? "true" : "false"} onClick={toggleResume} type="button" title="Toggle resume" />
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
              <button class="tog" aria-pressed={tweaks().loudnessNorm ? "true" : "false"} onClick={toggleNorm} type="button" />
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
              <div class="set-row__hint mono">~/Music</div>
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
              <div class="set-row__hint mono">localhost:6333 · vectors mert 768 · lyrics 1024</div>
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
            4. ABOUT (grid mono + update flow preservado
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
              <span class="set-about-item__value">Rust · GStreamer</span>
            </div>
            <div class="set-about-item">
              <span class="set-about-item__label">Identifier</span>
              <span class="set-about-item__value">dev.cmr.rustifyplayer</span>
            </div>
            <div class="set-about-item">
              <span class="set-about-item__label">License</span>
              <span class="set-about-item__value">MIT</span>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
