// Sidebar — logo mark, nav items with tooltips + labels, footer with settings + tweaks toggle.
// Reacts to route-changed events and data-sidebar attribute for expand/collapse.

const NAV_ITEMS = [
  { route: "/home",      icon: "home",        label: "Home" },
  { route: "/library",   icon: "library",     label: "Library" },
  { route: "/artists",   icon: "person",      label: "Artists" },
  { route: "/albums",    icon: "album",       label: "Albums" },
  { route: "/tracks",    icon: "audiotrack",  label: "Tracks" },
  { route: "/playlists", icon: "queue-music", label: "Playlists" },
  { route: "/queue",     icon: "queue-music", label: "Queue" },
  { route: "/history",   icon: "history",     label: "History" },
];

const FOOTER_ITEMS = [
  { route: "/now-playing", icon: "music-note", label: "Now Playing" },
  { route: "/settings",    icon: "settings",   label: "Settings" },
];

function navItemHTML({ route, icon, label }) {
  return `
    <a class="sidebar-item" href="#${route}" data-route="${route}" title="${label}">
      <svg class="icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>
      <span class="sidebar-item__label">${label}</span>
      <span class="sidebar-item__tooltip">${label}</span>
    </a>
  `;
}

export function mountSidebar(root) {
  root.innerHTML = `
    <div class="sidebar__logo">
      <svg class="icon--lg" aria-hidden="true"><use href="#icon-logo-mark"></use></svg>
      <span class="sidebar__logo-word">Rustify</span>
    </div>
    <nav class="sidebar__nav" aria-label="Primary">
      ${NAV_ITEMS.map(navItemHTML).join("")}
    </nav>
    <div class="sidebar__footer">
      ${FOOTER_ITEMS.map(navItemHTML).join("")}
      <button class="sidebar-item" id="tweaks-toggle" title="Tweaks">
        <svg class="icon" aria-hidden="true"><use href="#icon-sliders"></use></svg>
        <span class="sidebar-item__label">Tweaks</span>
        <span class="sidebar-item__tooltip">Tweaks</span>
      </button>
      <div class="sidebar__vu" id="sidebar-vu">
        <span style="height:4px"></span>
        <span style="height:7px"></span>
        <span style="height:10px"></span>
        <span style="height:6px"></span>
        <span style="height:8px"></span>
      </div>
    </div>
  `;

  const syncActive = (path) => {
    root.querySelectorAll(".sidebar-item[data-route]").forEach((el) => {
      el.classList.toggle("active", el.dataset.route === path);
    });
  };

  window.addEventListener("route-changed", (e) => {
    syncActive(e.detail.path);
  });

  // Tweaks toggle
  const tweaksBtn = root.querySelector("#tweaks-toggle");
  tweaksBtn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("toggle-tweaks"));
  });

  // Animate VU bars when playing
  const vuBars = root.querySelectorAll("#sidebar-vu span");
  let vuInterval = null;
  const { listen } = window.__TAURI__?.event || {};
  if (listen) {
    listen("player-state", (e) => {
      const p = e.payload;
      if (p.Playing || p.Position) {
        if (!vuInterval) {
          vuInterval = setInterval(() => {
            vuBars.forEach((bar) => {
              bar.style.height = `${3 + Math.random() * 9}px`;
            });
          }, 180);
        }
      } else if (p.Paused || p.Stopped) {
        clearInterval(vuInterval);
        vuInterval = null;
        vuBars.forEach((bar, i) => {
          bar.style.height = `${[4, 7, 10, 6, 8][i]}px`;
        });
      }
    });
  }
}
