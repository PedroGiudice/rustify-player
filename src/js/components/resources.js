// Resources panel — btop-inspired overlay with real system data via Tauri IPC.

const { invoke } = window.__TAURI__.core;

let panelEl = null;
let tickInterval = null;
let cpuHistory = Array(40).fill(0);
let isOpen = false;

function fmtBytes(b) {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

function fmtPct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function sparkSvg(values, w = 120, h = 24) {
  const max = Math.max(...values, 0.01);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - (v / max) * h * 0.9 - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="res-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1"/>
    <polyline points="0,${h} ${pts} ${w},${h}" fill="currentColor" opacity="0.10" stroke="none"/>
  </svg>`;
}

function renderPanel(data) {
  if (!panelEl || !isOpen) return;

  const cores = data.cpu_cores || [];
  cpuHistory.push(data.cpu_overall);
  if (cpuHistory.length > 40) cpuHistory.shift();

  const ramPct = data.ram_percent || 0;
  const ramUsedPct = ramPct * 100;
  const ramFreeBytes = (data.ram_total || 0) - (data.ram_used || 0);

  const coresHTML = cores.map((c, i) => {
    const pct = (c * 100).toFixed(1);
    return `<div class="res-core">
      <span class="res-core__id">c${i}</span>
      <span class="res-core__bar" style="--w:${pct}%"></span>
      <span class="res-core__pct">${pct}%</span>
    </div>`;
  }).join("");

  panelEl.innerHTML = `
    <div class="resources__header">
      <span class="resources__bracket">\u250C\u2500[</span>
      <span class="resources__title">system \u00B7 rustify-player</span>
      <span class="resources__bracket">]\u2500\u2510</span>
      <button class="resources__close" id="res-close">\u00D7</button>
    </div>
    <div class="resources__body">
      <div class="res-section">
        <div class="res-section__title">
          <span>\u251C\u2500 cpu \u00B7 ${cores.length} cores</span>
          <span class="res-section__spark">${sparkSvg(cpuHistory)}</span>
          <span class="res-section__value">${fmtPct(data.cpu_overall)}</span>
        </div>
        <div class="res-cores">${coresHTML}</div>
      </div>

      <div class="res-section">
        <div class="res-section__title">
          <span>\u251C\u2500 mem \u00B7 ${fmtBytes(data.ram_total)}</span>
          <span></span>
          <span class="res-section__value">${fmtBytes(data.ram_used)} / ${fmtPct(ramPct)}</span>
        </div>
        <div class="res-mem-bar">
          <div class="res-mem-bar__used" style="width:${ramUsedPct}%"></div>
        </div>
        <div class="res-legend">
          <span><span class="dot dot--used"></span>used ${fmtBytes(data.ram_used)}</span>
          <span class="res-legend__sep">\u00B7</span>
          <span><span class="dot dot--free"></span>free ${fmtBytes(ramFreeBytes)}</span>
          <span class="res-legend__sep">\u00B7</span>
          <span>proc rss <b>${fmtBytes(data.process_rss)}</b></span>
        </div>
      </div>
    </div>
    <div class="resources__footer">
      <span>proc cpu <b>${fmtPct(data.process_cpu)}</b></span>
      <span class="sep">\u00B7</span>
      <span>cores <b>${cores.length}</b></span>
    </div>
  `;

  panelEl.querySelector("#res-close")?.addEventListener("click", () => toggle(false));
}

async function tick() {
  if (!isOpen) return;
  try {
    const data = await invoke("get_system_resources");
    renderPanel(data);
  } catch (err) {
    console.error("[resources] fetch failed:", err);
  }
}

function toggle(force) {
  isOpen = force !== undefined ? force : !isOpen;
  if (!panelEl) return;

  if (isOpen) {
    panelEl.removeAttribute("hidden");
    tick();
    tickInterval = setInterval(tick, 1000);
  } else {
    panelEl.setAttribute("hidden", "");
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

export function mountResources() {
  panelEl = document.createElement("div");
  panelEl.className = "resources";
  panelEl.setAttribute("hidden", "");
  document.body.appendChild(panelEl);

  // Keyboard shortcut: Ctrl+R
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "r") {
      e.preventDefault();
      toggle();
    }
  });
}

export function toggleResources() {
  toggle();
}
