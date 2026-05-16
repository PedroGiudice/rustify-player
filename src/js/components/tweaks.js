// Painel Tweaks — flutuante, ajustes minimos de fonte e zoom.
// Alinhado ao design system Extractor Lab: usa tokens --font-sans e --font-mono.
// Persiste em localStorage sob a chave "kv-tweaks".

const { invoke } = window.__TAURI__.core;

const STORAGE_KEY = "kv-tweaks";

// Base font-size do extractor-lab.css (body) — multiplicado pelo fontScale para
// produzir o tamanho final aplicado no <html>.
const BASE_FONT_PX = 14;

const DEFAULTS = {
  fontUI: "",      // vazio => fallback do --font-sans
  fontMono: "",    // vazio => fallback do --font-mono
  fontScale: 1.0,  // 0.85 — 1.25 (uniforme, aplicado em html.style.fontSize)
  zoom: 1.0,       // 0.85 — 1.25 (html.style.zoom; suportado pelo webview Tauri)
};

let state = { ...DEFAULTS };
let panelEl = null;
let systemFonts = null; // cache do invoke("list_system_fonts")

export function loadTweaks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      // Aceitamos apenas as chaves novas; descartamos lixo do schema antigo.
      for (const key of Object.keys(DEFAULTS)) {
        if (key in saved) state[key] = saved[key];
      }
    }
  } catch (_) {}
  applyTweaks();
}

export function applyTweaks() {
  const html = document.documentElement;

  // UI font: sobrescreve --font-sans (token canonico do extractor-lab.css).
  if (state.fontUI) {
    html.style.setProperty(
      "--font-sans",
      `"${state.fontUI}", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
    );
  } else {
    html.style.removeProperty("--font-sans");
  }

  // Mono font: sobrescreve --font-mono.
  if (state.fontMono) {
    html.style.setProperty(
      "--font-mono",
      `"${state.fontMono}", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace`,
    );
  } else {
    html.style.removeProperty("--font-mono");
  }

  // Escala uniforme: muda a base do html, todos os rem/em escalam junto.
  html.style.fontSize = `${BASE_FONT_PX * state.fontScale}px`;

  // Zoom: o webview Tauri (WebKitGTK) suporta a propriedade nao-padrao 'zoom'.
  html.style.zoom = String(state.zoom);

  save();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

function setVal(key, val) {
  state[key] = val;
  applyTweaks();
  renderPanel();
}

export function mountTweaks() {
  if (panelEl) return; // idempotente

  panelEl = document.createElement("aside");
  panelEl.className = "tweaks";
  panelEl.setAttribute("aria-label", "Tweaks");
  document.body.appendChild(panelEl);

  window.addEventListener("toggle-tweaks", () => {
    panelEl.classList.toggle("is-visible");
    if (panelEl.classList.contains("is-visible")) renderPanel();
  });
}

async function loadFonts() {
  if (systemFonts) return systemFonts;
  try {
    const list = await invoke("list_system_fonts");
    systemFonts = Array.isArray(list) ? list : [];
  } catch (err) {
    console.error("[tweaks] list_system_fonts falhou:", err);
    systemFonts = [];
  }
  return systemFonts;
}

function fontSelect(label, key, fonts) {
  const opts = fonts
    .map(
      (f) =>
        `<option value="${esc(f)}" ${state[key] === f ? "selected" : ""}>${esc(f)}</option>`,
    )
    .join("");
  return `
    <div class="tweaks__row">
      <span class="tweaks__label">${label}</span>
      <select class="tweaks__select" data-font-key="${key}">
        <option value="">Default</option>
        ${opts}
      </select>
    </div>
  `;
}

function scaleSlider(label, key, min, max, step) {
  const pct = Math.round(state[key] * 100);
  return `
    <div class="tweaks__row">
      <span class="tweaks__label">${label} ${pct}%</span>
      <input type="range" class="settings-range" data-scale-key="${key}"
        min="${min}" max="${max}" step="${step}" value="${state[key]}">
    </div>
  `;
}

async function renderPanel() {
  if (!panelEl) return;

  const fonts = await loadFonts();

  panelEl.innerHTML = `
    <div class="tweaks__header">
      <span class="tweaks__title">Tweaks</span>
      <button class="tweaks__close" id="tweaks-close" aria-label="Fechar">&times;</button>
    </div>
    <div class="tweaks__body">
      ${fontSelect("UI Font", "fontUI", fonts)}
      ${fontSelect("Mono Font", "fontMono", fonts)}
      ${scaleSlider("Font Scale", "fontScale", "0.85", "1.25", "0.05")}
      ${scaleSlider("Zoom", "zoom", "0.85", "1.25", "0.05")}
    </div>
  `;

  panelEl.querySelector("#tweaks-close")?.addEventListener("click", () => {
    panelEl.classList.remove("is-visible");
  });

  panelEl.querySelectorAll(".tweaks__select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      setVal(e.target.dataset.fontKey, e.target.value);
    });
  });

  panelEl.querySelectorAll("[data-scale-key]").forEach((slider) => {
    slider.addEventListener("input", (e) => {
      setVal(e.target.dataset.scaleKey, parseFloat(e.target.value));
    });
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
