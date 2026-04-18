// Sidebar — static markup once, then reactive to route changes via event.

const NAV_ITEMS = [
  { route: "/home",      icon: "home",          label: "Home" },
  { route: "/library",   icon: "library",       label: "Library" },
  { route: "/artists",   icon: "person",        label: "Artists" },
  { route: "/albums",    icon: "album",         label: "Albums" },
  { route: "/history",   icon: "history",       label: "History" },
  { route: "/tracks",    icon: "audiotrack",    label: "Tracks" },
  { route: "/playlists", icon: "queue-music",   label: "Playlists" },
];

const FOOTER_ITEMS = [
  { route: "/settings", icon: "settings", label: "Settings" },
];

function itemHTML({ route, icon, label }) {
  return `
    <a class="sidebar-item" href="#${route}" data-route="${route}" title="${label}">
      <svg class="icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>
      <span class="sidebar-item__tooltip">${label}</span>
    </a>
  `;
}

export function mountSidebar(root) {
  root.innerHTML = `
    <div class="sidebar__logo" title="Rustify">V</div>
    <nav class="sidebar__nav" aria-label="Primary">
      ${NAV_ITEMS.map(itemHTML).join("")}
    </nav>
    <div class="sidebar__footer">
      ${FOOTER_ITEMS.map(itemHTML).join("")}
    </div>
  `;

  const syncActive = (path) => {
    root.querySelectorAll(".sidebar-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.route === path);
    });
  };

  window.addEventListener("route-changed", (e) => {
    syncActive(e.detail.path);
  });
}
