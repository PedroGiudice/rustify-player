/* ============================================================
   views/Settings.tsx — Library/Audio/Theme settings.
   ============================================================ */

import { createResource, createSignal, Show } from "solid-js";
import { Icon, ICONS } from "../components/Icon";
import { libRescan } from "../tauri";

const THEMES = ["light", "dark", "auto"] as const;
type Theme = typeof THEMES[number];

export default function Settings() {
  const [theme, setTheme] = createSignal<Theme>(
    (localStorage.getItem("rustify-theme") as Theme) ?? "light",
  );
  const [scrobble, setScrobble] = createSignal(false);
  const [crossfade, setCrossfade] = createSignal(2);
  const [rescanning, setRescanning] = createSignal(false);

  const [version] = createResource(async () => {
    try {
      const app = (window as any).__TAURI__?.app;
      if (app?.getVersion) return await app.getVersion();
      return "—";
    } catch {
      return "—";
    }
  });

  function applyTheme(t: Theme) {
    setTheme(t);
    localStorage.setItem("rustify-theme", t);
    document.body.setAttribute("data-theme", t === "auto" ? "" : t);
  }

  async function handleRescan() {
    if (rescanning()) return;
    setRescanning(true);
    try {
      await libRescan();
    } catch (err) {
      console.error("rescan failed", err);
    } finally {
      setRescanning(false);
    }
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Settings</h1>
          <p class="view__head-hint">Library, audio, appearance.</p>
        </div>
      </header>

      <div class="view__body" style={{ "max-width": "720px" }}>

        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Aparência</h3>
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Tema</div>
              <div class="toggle-row__hint">Light é o padrão Extractor Lab. Auto segue o SO.</div>
            </div>
            <div class="segmented">
              <button class={theme() === "light" ? "active" : ""} onClick={() => applyTheme("light")}>Light</button>
              <button class={theme() === "dark"  ? "active" : ""} onClick={() => applyTheme("dark")}>Dark</button>
              <button class={theme() === "auto"  ? "active" : ""} onClick={() => applyTheme("auto")}>Auto</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Reprodução</h3>
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Crossfade</div>
              <div class="toggle-row__hint">{crossfade()}s entre faixas. 0 desativa.</div>
            </div>
            <input
              type="range" min="0" max="12" step="1"
              class="slider"
              style={{ width: "180px" }}
              value={crossfade()}
              onInput={(e) => setCrossfade(parseInt(e.currentTarget.value, 10))}
            />
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Scrobble (Last.fm)</div>
              <div class="toggle-row__hint">Envia faixas tocadas pro Last.fm.</div>
            </div>
            <button
              class="toggle"
              aria-pressed={scrobble() ? "true" : "false"}
              onClick={() => setScrobble(!scrobble())}
            />
          </div>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Library</h3>
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Pasta da biblioteca</div>
              <div class="toggle-row__hint mono">~/Music/library</div>
            </div>
            <button class="chip">Trocar…</button>
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-row__label">Re-scan</div>
              <div class="toggle-row__hint">Re-indexa metadados e gera embeddings faltantes.</div>
            </div>
            <button
              class="chip"
              onClick={handleRescan}
              disabled={rescanning()}
              title={rescanning() ? "Re-indexando…" : undefined}
            >
              <Icon name={ICONS.bolt} size={12} /> {rescanning() ? "Re-indexando…" : "Re-scan"}
            </button>
          </div>
        </section>

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
