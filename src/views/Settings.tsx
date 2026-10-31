/* ============================================================
   views/Settings.tsx — Settings só com o que é dela (B20, 31/10).

   Painéis:
   1. Tema — tema YAML (o tema é o modo) + calculadora de contraste.
   2. Reprodução — Retomar ao abrir (preferência lida pelo PlayerBar).
   3. Biblioteca — uma linha (faixas · álbuns · artistas) + Reescanear, e
      quando o celular sincronizou plays e curtidas (B14), âmbar após 24 h.
   4. Atualização — fluxo de update (check / install / restart).
   5. Ponte para o Tweaks — densidade, barra lateral, fundo, ritmo e
      normalização moram no Tweaks; o volume, na barra do player. Antes,
      quatro deles (Compact sidebar, Beat sync, Volume, Normalizar) se
      repetiam aqui, e o texto da normalização dizia −14 LUFS fixo.
   6. Diagnóstico (fechado) — pastas, embeddings, qdrant, contagens,
      atalho e o "About" (versão, Tauri, backend, identificador, licença).
      Os valores fixos daqui precisam bater com o Cargo.toml.

   PRESERVADO (NÃO QUEBRAR):
   - Update flow (checkForUpdate / installUpdate / restartApp)
   - Library stats (libSnapshot + albums/artists/genres counts)
   - Theme picker dinâmico via listThemes / applyThemeByName
   ============================================================ */

import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon, ICONS } from "../components/Icon";
import { Switch } from "../components/Switch";
import {
  libSnapshot, libGetAlbums, libGetArtists, libListGenres,
  libRescan,
  listThemes, applyThemeByName, loadTheme, watchTheme, unwatchTheme, onThemeChanged,
  clearThemeVars,
  checkForUpdate, installUpdate, restartApp,
  libSyncStatus, onSyncReceived,
  type ContrastCheck, type DeviceSync,
} from "../tauri";
import { mergeSync, syncDetail, syncLine, syncStale } from "../lib/syncStatus";
import { applyTweaks, setTweaksOpen } from "../store/tweaks";
import { resumeOnLaunch, setResumeOnLaunch } from "../store/player";

// ── Helpers locais ──────────────────────────────────────────────

/** Classifica um par de contraste segundo WCAG 2.1 */
function wcagLabel(c: ContrastCheck): string {
  if (c.pass_aaa) return "AAA";
  if (c.pass_aa)  return "AA";
  // AA-large: 3:1 pra texto grande (>=18pt ou >=14pt bold)
  if (c.ratio >= 3.0) return "AA-large";
  return "fail";
}

/** Classe CSS para o badge de classificacao: AA/AAA ok, AA-large (so texto
    grande) warn, abaixo de 3:1 err. Estilo em extractor-lab.css (.status-pill). */
function wcagBadgeClass(c: ContrastCheck): string {
  const label = wcagLabel(c);
  if (label === "AAA" || label === "AA") return "status-pill status-pill--ok";
  if (label === "AA-large") return "status-pill status-pill--warn";
  return "status-pill status-pill--err";
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
  // ── Sync do celular (B14): lido ao abrir, atualizado a cada lote ──
  // null = ainda lendo ou o comando falhou (a linha não aparece).
  const [syncs, setSyncs] = createSignal<DeviceSync[] | null>(null);
  const [nowMs, setNowMs] = createSignal(Date.now());
  onMount(() => {
    libSyncStatus().then(setSyncs).catch(() => setSyncs(null));
    let unlisten: (() => void) | undefined;
    let alive = true;
    onSyncReceived((d) => { setSyncs((l) => mergeSync(l ?? [], d)); setNowMs(Date.now()); })
      .then((u) => { if (alive) unlisten = u; else u(); })
      .catch(() => {});
    // "há 12 min" anda sozinho com a tela aberta.
    const tick = setInterval(() => setNowMs(Date.now()), 60_000);
    onCleanup(() => { alive = false; unlisten?.(); clearInterval(tick); });
  });

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

  // Erro da última tentativa de aplicar tema (YAML inválido, arquivo sumiu).
  const [themeError, setThemeError] = createSignal<string | null>(null);

  async function selectThemeFile(filename: string, select?: HTMLSelectElement) {
    setThemeError(null);
    if (!filename) {
      // Default: tira só as vars do tema (o resto do inline — zoom, Tweaks,
      // adaptive ink — fica), derruba o watcher e re-aplica os Tweaks por
      // cima do :root, sem o ink do tema.
      clearThemeVars();
      localStorage.removeItem("rustify-theme");
      unwatchTheme().catch((e) => console.warn("[theme] unwatch failed:", e));
      setActiveTheme("");
      setContrast([]);
      window.dispatchEvent(new CustomEvent("rustify:theme-applied", {
        detail: { ink: null },
      }));
      applyTweaks();
      return;
    }
    try {
      const checks = await applyThemeByName(filename);
      setActiveTheme(filename);
      setContrast(checks);
    } catch (e) {
      // O tema anterior segue na tela; o <select> (não controlado pelo
      // DOM) voltaria mentindo — devolve a seleção ao tema ativo.
      setThemeError(String(e));
      if (select) select.value = activeTheme();
      return;
    }
    // Hot-reload: o watcher emite "theme-changed" e quem re-aplica é o
    // listener do boot (wireThemeHotReload); o daqui só refaz o contraste.
    watchTheme(filename).catch((e) => console.warn("[theme] watch failed:", e));
  }

  // Falha = nem texto grande passa (< 3:1). AA-large conta à parte: é
  // válido pra texto grande e não pode inflar o contador de falhas.
  const failingContrast = () => contrast().filter((c) => wcagLabel(c) === "fail");
  const largeOnlyContrast = () => contrast().filter((c) => wcagLabel(c) === "AA-large");

  function toggleResume() {
    setResumeOnLaunch(!resumeOnLaunch());
  }

  // ── Tema: diagnóstico ao abrir + contraste no hot-reload ──────
  onMount(() => {
    // Diagnóstico do tema ativo ao abrir (sem isto a tabela só aparecia
    // depois de uma nova seleção ou de um hot-reload). loadTheme é leitura
    // pura: não re-aplica nada.
    const current = activeTheme();
    if (current) {
      loadTheme(current)
        .then((r) => { if (activeTheme() === current) setContrast(r.contrast); })
        .catch((e) => console.warn("[theme] contrast on open failed:", e));
    }

    // Hot-reload de tema: quem APLICA é o listener do boot
    // (wireThemeHotReload). Este só atualiza a calculadora — e só para o
    // tema ativo: evento atrasado de outro arquivo não troca a tabela.
    const unlisten = onThemeChanged((filename) => {
      if (!filename || filename !== activeTheme()) return;
      loadTheme(filename)
        .then((r) => setContrast(r.contrast))
        .catch((e) => console.warn("[theme] refresh contrast failed:", e));
    });
    // `onThemeChanged` retorna uma Promise<UnlistenFn>; cancelamos no cleanup.
    onCleanup(() => { unlisten.then((fn) => fn()).catch(() => {}); });
  });

  // ── Re-scan (preservado) ─────────────────────────────────────
  const [scanning, setScanning] = createSignal(false);
  const [scanLabel, setScanLabel] = createSignal("Reescanear");

  function handleRescan() {
    setScanning(true);
    setScanLabel("Reescaneando…");
    libRescan()
      .then(() => {
        setScanLabel("Iniciado");
        setTimeout(() => { setScanning(false); setScanLabel("Reescanear"); }, 5000);
      })
      .catch(() => { setScanLabel("Falhou, tentar de novo"); setScanning(false); });
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
          <p class="view__head-hint">Tema, retomada, biblioteca e atualização · v{version() ?? "—"}</p>
        </div>
      </header>

      <div class="set">
        {/* ── 1. Tema ─────────────────────────────────────────── */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">Tema</h3>
          </div>

          {/* Theme YAML picker — mantido pra estilos custom ── */}
          <div class="set-row">
            <div>
              <div class="set-row__label" id="set-theme-label">Tema</div>
              <div class="set-row__hint">Arquivos YAML em ~/.local/share/rustify-player/themes/.</div>
            </div>
            <div class="set-row__control">
              <Show
                when={themes()}
                fallback={<span class="mono" style={{ "font-size": "var(--fs-label)", color: "var(--fg-5)" }}>loading…</span>}
              >
                {(t) => (
                  <span class="select-shell">
                  <select
                    class="set-folder-btn"
                    aria-labelledby="set-theme-label"
                    value={activeTheme()}
                    onChange={(e) => selectThemeFile(e.currentTarget.value, e.currentTarget)}
                  >
                    <option value="">Default (Extractor Lab)</option>
                    <For each={t()}>
                      {(theme) => <option value={theme.filename}>{theme.name}</option>}
                    </For>
                  </select>
                  <Icon class="select-shell__chev" name={ICONS.chevronDown} size={14} />
                  </span>
                )}
              </Show>
            </div>
          </div>

          <Show when={themeError()}>
            <div class="set-row">
              <div class="set-row__hint" role="alert" style={{ color: "var(--rose-fg)" }}>
                Tema não aplicado: {themeError()}
              </div>
            </div>
          </Show>

          <Show when={contrast().length > 0}>
            <div class="set-row set-row--col">
              <div style={{ width: "100%" }}>
                <div class="set-row__label" style={{ "margin-bottom": "8px" }}>
                  Contraste WCAG
                  <Show when={failingContrast().length > 0}>
                    <span
                      class="status-pill status-pill--err"
                      style={{ "margin-left": "8px", "vertical-align": "middle" }}
                    >
                      {`${failingContrast().length} falha(s)`}
                    </span>
                  </Show>
                  <Show when={largeOnlyContrast().length > 0}>
                    <span
                      class="status-pill status-pill--warn"
                      style={{ "margin-left": "8px", "vertical-align": "middle" }}
                    >
                      {`${largeOnlyContrast().length} só AA-large`}
                    </span>
                  </Show>
                  <Show when={failingContrast().length === 0 && largeOnlyContrast().length === 0}>
                    <span
                      class="status-pill status-pill--ok"
                      style={{ "margin-left": "8px", "vertical-align": "middle" }}
                    >
                      AA ok
                    </span>
                  </Show>
                </div>
                {/* Tabela compacta com todos os pares */}
                <div style={{ display: "grid", "grid-template-columns": "1fr auto auto", gap: "2px 12px", "font-size": "var(--fs-label)", "font-family": "var(--font-mono)", "font-variant-numeric": "tabular-nums" }}>
                  <For each={contrast()}>
                    {(c) => (
                      <>
                        <span style={{ color: "var(--fg-4)", "overflow": "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{c.pair}</span>
                        <span style={{ color: "var(--fg-3)", "text-align": "right" }}>{c.ratio.toFixed(2)}:1</span>
                        <span class={wcagBadgeClass(c)} style={{ padding: "1px 5px", "line-height": "1.6" }}>{wcagLabel(c)}</span>
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

        </div>

        {/* ── 2. Reprodução ───────────────────────────────────── */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">Reprodução</h3>
          </div>
          <div class="set-row">
            <div>
              <div class="set-row__label" id="set-resume-label">Retomar ao abrir</div>
              <div class="set-row__hint">Reabre a última faixa na última posição.</div>
            </div>
            <div class="set-row__control">
              <Switch checked={resumeOnLaunch()} onChange={toggleResume} labelledBy="set-resume-label" />
            </div>
          </div>
        </div>

        {/* ── 3. Biblioteca: uma linha + Reescanear ───────────── */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">Biblioteca</h3>
          </div>
          <div class="set-row">
            <div>
              <div class="set-row__label set-num">
                <Show when={data()} fallback="Contando…">
                  {tracksTotal()} faixas · {albumsCount()} álbuns · {artistsCount()} artistas
                </Show>
              </div>
              <div class="set-row__hint">Relê a pasta ~/Music e indexa o que mudou.</div>
            </div>
            <div class="set-row__control">
              <button
                class="set-folder-btn set-folder-btn--accent"
                disabled={scanning()}
                onClick={handleRescan}
                type="button"
              >
                <Icon name={ICONS.refresh} size={12} />
                {scanLabel()}
              </button>
            </div>
          </div>
          <Show when={syncs()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <div class="set-row">
                    <div>
                      <div class="set-row__label">Celular</div>
                      <div class="set-row__hint">
                        Nenhum sync registrado. O S24 manda as escutas pela tailnet com este app aberto.
                      </div>
                    </div>
                  </div>
                }
              >
                <For each={list()}>
                  {(d) => (
                    <div class="set-row set-sync" data-stale={syncStale(d, nowMs()) ? "true" : undefined}>
                      <div>
                        <div class="set-row__label set-num">
                          <span class="set-sync__dot" aria-hidden="true" />
                          {syncLine(d, nowMs())}
                        </div>
                        <div class="set-row__hint set-num">
                          {syncDetail(d)}
                          <Show when={syncStale(d, nowMs())}> · mais de 24 h sem notícia do aparelho</Show>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </div>

        {/* ── 4. Atualização ──────────────────────────────────── */}
        <div class="set-panel">
          <div class="set-panel__head">
            <h3 class="set-panel__title">Atualização</h3>
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
                  Você está na última — v{updateResult()?.current_version ?? version()}
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

        </div>

        {/* ── 5. Ponte para o Tweaks: uma fonte por controle ──── */}
        <div class="set-panel">
          <div class="set-row">
            <div>
              <div class="set-row__label">Aparência, fundo e som</div>
              <div class="set-row__hint">
                Densidade, barra lateral, fontes, fundo animado, ritmo e normalização ficam no
                Tweaks; o volume, na barra do player.
              </div>
            </div>
            <div class="set-row__control">
              <button class="set-folder-btn" type="button" onClick={() => setTweaksOpen(true)}>
                Abrir o Tweaks
              </button>
            </div>
          </div>
        </div>

        {/* ── 6. Diagnóstico (fechado): o texto técnico ───────── */}
        <details class="set-panel set-diag">
          <summary class="set-panel__head set-diag__summary">
            <h3 class="set-panel__title">Diagnóstico</h3>
            <Icon class="set-diag__chev" name={ICONS.chevronDown} size={14} />
          </summary>

          <div class="set-row">
            <div>
              <div class="set-row__label">Pasta de música</div>
              <div class="set-row__hint mono">~/Music</div>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-row__label">Dados do app</div>
              <div class="set-row__hint mono">~/.local/share/rustify-player</div>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-row__label">Embeddings</div>
              <div class="set-row__hint set-num">
                {embedDone()} de {tracksTotal()} faixas com embedding; alimentam as stations e o rádio.
              </div>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-row__label">qdrant</div>
              <div class="set-row__hint mono">localhost:6333 · vectors mert 768 · lyrics 1024</div>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-row__label">Atalho do modo cinema</div>
              <div class="set-row__hint">No Now Playing, esconde toda a moldura.</div>
            </div>
            <div class="set-row__control">
              <span class="kbd set-kbd">F</span>
            </div>
          </div>

          <Show when={data()}>
            <div class="stat-grid set-diag__stats">
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
        </details>
      </div>
    </article>
  );
}
