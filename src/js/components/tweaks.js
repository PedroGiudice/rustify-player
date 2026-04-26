// Tweaks panel — floating bottom-right panel for accent, density, sidebar, NP layout, type, glow, zoom, fonts.
// Persists to localStorage. Applied on boot before any render.

const { invoke } = window.__TAURI__.core;

const STORAGE_KEY = "kv-tweaks";

const DEFAULTS = {
  accent: "copper",
  density: "normal",
  sidebar: "collapsed",
  npLayout: "left",
  type: "body",
  glow: 0.15,
  zoom: 1.0,
  fontUI: "",
  fontDisplay: "",
};

let state = { ...DEFAULTS };
let panelEl = null;
let systemFonts = null; // cached after first load

export function loadTweaks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) Object.assign(state, saved);
  } catch (_) {}
  applyTweaks();
}

export function applyTweaks() {
  const html = document.documentElement;
  if (state.accent !== "copper") {
    html.dataset.accent = state.accent;
  } else {
    delete html.dataset.accent;
  }
  html.dataset.density = state.density === "compact" ? "compact" : "";
  html.dataset.sidebar = state.sidebar === "expanded" ? "expanded" : "";
  html.dataset.npLayout = state.npLayout || "left";
  html.dataset.type = state.type === "mono" ? "mono" : "";
  html.style.setProperty("--glow", String(state.glow));
  html.style.zoom = String(state.zoom);

  // Custom fonts
  if (state.fontUI) {
    html.style.setProperty("--font-body", `"${state.fontUI}", sans-serif`);
  } else {
    html.style.removeProperty("--font-body");
  }
  if (state.fontDisplay) {
    html.style.setProperty("--font-display", `"${state.fontDisplay}", serif`);
  } else {
    html.style.removeProperty("--font-display");
  }

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
  panelEl = document.createElement("aside");
  panelEl.className = "tweaks";
  panelEl.setAttribute("aria-label", "Design tweaks");
  document.body.appendChild(panelEl);

  window.addEventListener("toggle-tweaks", () => {
    panelEl.classList.toggle("is-visible");
    if (panelEl.classList.contains("is-visible")) renderPanel();
  });
}

async function loadFonts() {
  if (systemFonts) return systemFonts;
  try {
    systemFonts = await invoke("list_system_fonts");
  } catch (err) {
    console.error("[tweaks] font list failed:", err);
    systemFonts = [];
  }
  return systemFonts;
}

function fontSelect(label, key, fonts) {
  const opts = fonts
    .map((f) => `<option value="${esc(f)}" ${state[key] === f ? "selected" : ""}>${esc(f)}</option>`)
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

function segmented(label, key, options) {
  const btns = options
    .map(
      ([val, text]) =>
        `<button class="segmented__btn ${state[key] === val ? "is-active" : ""}" data-key="${key}" data-val="${val}">${text}</button>`
    )
    .join("");
  return `
    <div class="tweaks__row">
      <span class="tweaks__label">${label}</span>
      <div class="segmented">${btns}</div>
    </div>
  `;
}

async function renderPanel() {
  if (!panelEl) return;

  const fonts = await loadFonts();

  panelEl.innerHTML = `
    <div class="tweaks__header">
      <span class="tweaks__title">Tweaks</span>
      <button class="tweaks__close" id="tweaks-close">&times;</button>
    </div>
    <div class="tweaks__body">
    ${segmented("Accent", "accent", [
      ["copper", "Copper"],
      ["moss", "Moss"],
      ["rust", "Rust"],
      ["slate", "Slate"],
      ["ink", "Ink"],
      ["gold", "Gold"],
      ["teal", "Teal"],
      ["violet", "Violet"],
      ["coral", "Coral"],
    ])}
    ${segmented("Density", "density", [
      ["normal", "Normal"],
      ["compact", "Compact"],
    ])}
    ${segmented("Sidebar", "sidebar", [
      ["collapsed", "Icons"],
      ["expanded", "Labels"],
    ])}
    ${segmented("Now Playing", "npLayout", [
      ["left", "Left"],
      ["top", "Top"],
      ["split", "Split"],
    ])}
    ${segmented("Type", "type", [
      ["body", "Inter"],
      ["mono", "Mono"],
    ])}
    ${fontSelect("UI Font", "fontUI", fonts)}
    ${fontSelect("Display Font", "fontDisplay", fonts)}
    <div class="tweaks__row">
      <span class="tweaks__label">Glow ${state.glow.toFixed(2)}</span>
      <input type="range" class="settings-range" id="tweaks-glow"
        min="0" max="1" step="0.05" value="${state.glow}">
    </div>
    <div class="tweaks__row">
      <span class="tweaks__label">Zoom ${Math.round(state.zoom * 100)}%</span>
      <input type="range" class="settings-range" id="tweaks-zoom"
        min="0.85" max="1.25" step="0.05" value="${state.zoom}">
    </div>
    </div>
  `;

  // Bind close button
  panelEl.querySelector("#tweaks-close")?.addEventListener("click", () => {
    panelEl.classList.remove("is-visible");
  });

  // Bind segmented buttons
  panelEl.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setVal(btn.dataset.key, btn.dataset.val);
    });
  });

  // Bind font selects
  panelEl.querySelectorAll(".tweaks__select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      setVal(e.target.dataset.fontKey, e.target.value);
    });
  });

  // Bind glow slider
  const glowInput = panelEl.querySelector("#tweaks-glow");
  glowInput.addEventListener("input", (e) => {
    setVal("glow", parseFloat(e.target.value));
  });

  // Bind zoom slider
  const zoomInput = panelEl.querySelector("#tweaks-zoom");
  zoomInput.addEventListener("input", (e) => {
    setVal("zoom", parseFloat(e.target.value));
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
