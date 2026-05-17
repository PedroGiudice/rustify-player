// Painel Tweaks — flutuante, ajustes de fontes, escala, density, sidebar, type, glow.
// Persiste em localStorage sob a chave "kv-tweaks".
// Compativel com schema antigo: aceita os campos fontUI, fontMono, zoom, fontScale.

const { invoke } = window.__TAURI__.core;

const STORAGE_KEY = "kv-tweaks";

const DEFAULTS = {
  fontUI: "",       // vazio => fallback do --font-sans
  fontMono: "",     // vazio => fallback do --font-mono
  scale: 1.0,       // 0.85 — 1.25 (html.style.zoom — afeta TUDO, inclusive px hardcoded)
  density: "normal",// "normal" | "compact" — aplica data-density no <html>
  sidebar: "labels", // "labels" | "icons" — labels = expandida (default), icons = colapsada
  type: "body",     // "body" | "mono" — aplica data-type no <html>
  glow: 0.0,        // 0.0 — 1.0 (--glow token no <html>)
};

let state = { ...DEFAULTS };
let panelEl = null;
let systemFonts = null;

// ── Carregamento e migracao de schema ────────────────────────────
export function loadTweaks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      for (const key of Object.keys(DEFAULTS)) {
        if (key in saved) state[key] = saved[key];
      }
      // Migracao: schema antigo usa "zoom" e "fontScale" como controles separados.
      // Usa "zoom" como valor de "scale" se "scale" nao estiver salvo.
      if (!("scale" in saved) && "zoom" in saved) {
        state.scale = saved.zoom;
      }
      // Migracao: sidebar "collapsed" => "icons", "expanded" => "labels"
      if (saved.sidebar === "collapsed") state.sidebar = "icons";
      if (saved.sidebar === "expanded") state.sidebar = "labels";
    }
  } catch (_) {}
  applyTweaks();
}

// ── Aplicacao dos valores no DOM ─────────────────────────────────
export function applyTweaks() {
  const html = document.documentElement;

  // UI font: sobrescreve --font-sans.
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

  // Escala geral via zoom.
  // Diagnotico: html.style.fontSize nao funciona porque o CSS define
  // font-size: 14px em px nos componentes, ignorando a base do html.
  // A propriedade zoom (nao-padrao, suportada pelo WebKitGTK do Tauri)
  // afeta tudo — inclusive textos com font-size em px.
  html.style.zoom = String(state.scale);

  // Remove o font-size manual que nao funcionava.
  html.style.removeProperty("font-size");

  // Density: compact reduz padding e gap em toda a UI.
  if (state.density === "compact") {
    html.dataset.density = "compact";
  } else {
    delete html.dataset.density;
  }

  // Sidebar: icons colapsa para 56px (CSS: html[data-sidebar="icons"]).
  // Default "labels" = sem atributo = sidebar expandida normal.
  if (state.sidebar === "icons") {
    html.dataset.sidebar = "icons";
  } else {
    delete html.dataset.sidebar;
  }

  // Type: mono aplica font-mono como font-sans para toda a UI.
  if (state.type === "mono") {
    html.dataset.type = "mono";
  } else {
    delete html.dataset.type;
  }

  // Glow: seta o token CSS --glow (usado por sombras e halos de destaque).
  html.style.setProperty("--glow", String(state.glow));

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

// ── Montagem do painel ───────────────────────────────────────────
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

// ── Carregamento de fontes do sistema ────────────────────────────
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

// ── Geradores de HTML dos controles ─────────────────────────────

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
      <span class="tweaks__label">${label} <span class="tweaks__val">${pct}%</span></span>
      <input type="range" class="settings-range" data-scale-key="${key}"
        min="${min}" max="${max}" step="${step}" value="${state[key]}">
    </div>
  `;
}

function rangeSlider(label, key, min, max, step, format) {
  const val = state[key];
  const display = format ? format(val) : val;
  return `
    <div class="tweaks__row">
      <span class="tweaks__label">${label} <span class="tweaks__val">${display}</span></span>
      <input type="range" class="settings-range" data-range-key="${key}"
        min="${min}" max="${max}" step="${step}" value="${val}">
    </div>
  `;
}

function segmented(label, key, options) {
  const btns = options
    .map(
      ([val, text]) =>
        `<button class="segmented__btn ${state[key] === val ? "is-active" : ""}" data-key="${key}" data-val="${val}">${text}</button>`,
    )
    .join("");
  return `
    <div class="tweaks__row">
      <span class="tweaks__label">${label}</span>
      <div class="segmented">${btns}</div>
    </div>
  `;
}

function divider(title) {
  return `<div class="tweaks__divider"><span>${title}</span></div>`;
}

// ── Render do painel ─────────────────────────────────────────────
async function renderPanel() {
  if (!panelEl) return;

  const fonts = await loadFonts();

  panelEl.innerHTML = `
    <div class="tweaks__header">
      <span class="tweaks__title">Tweaks</span>
      <button class="tweaks__close" id="tweaks-close" aria-label="Fechar">&times;</button>
    </div>
    <div class="tweaks__body">
      ${divider("Layout")}
      ${segmented("Density", "density", [
        ["normal", "Normal"],
        ["compact", "Compact"],
      ])}
      ${segmented("Sidebar", "sidebar", [
        ["icons", "Icons"],
        ["labels", "Labels"],
      ])}
      ${divider("Tipografia")}
      ${segmented("Type", "type", [
        ["body", "Sans"],
        ["mono", "Mono"],
      ])}
      ${fontSelect("UI Font", "fontUI", fonts)}
      ${fontSelect("Mono Font", "fontMono", fonts)}
      ${divider("Escala e Efeitos")}
      ${scaleSlider("Scale", "scale", "0.85", "1.25", "0.05")}
      ${rangeSlider("Glow", "glow", "0", "1", "0.05", (v) => v.toFixed(2))}
      <button class="tweaks__reset" id="tweaks-reset">Redefinir tudo</button>
    </div>
  `;

  // Botao fechar
  panelEl.querySelector("#tweaks-close")?.addEventListener("click", () => {
    panelEl.classList.remove("is-visible");
  });

  // Botao reset
  panelEl.querySelector("#tweaks-reset")?.addEventListener("click", () => {
    state = { ...DEFAULTS };
    applyTweaks();
    renderPanel();
  });

  // Segmented buttons
  panelEl.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setVal(btn.dataset.key, btn.dataset.val);
    });
  });

  // Font selects
  panelEl.querySelectorAll(".tweaks__select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      setVal(e.target.dataset.fontKey, e.target.value);
    });
  });

  // Scale sliders
  panelEl.querySelectorAll("[data-scale-key]").forEach((slider) => {
    slider.addEventListener("input", (e) => {
      setVal(e.target.dataset.scaleKey, parseFloat(e.target.value));
    });
  });

  // Range sliders (glow etc)
  panelEl.querySelectorAll("[data-range-key]").forEach((slider) => {
    slider.addEventListener("input", (e) => {
      setVal(e.target.dataset.rangeKey, parseFloat(e.target.value));
    });
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
