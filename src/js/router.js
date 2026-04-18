// Hash router — vanilla, ~60 LoC.
// Rotas são dynamic imports de ./views/*.js. Cada view expõe `render()`.
// Ao resolver, chama render(), substitui conteúdo de #main, e emite
// CustomEvent 'route-changed' pros outros módulos (ex: sidebar).

const routes = {
  "": () => import("./views/home.js"),
  "/": () => import("./views/home.js"),
  "/home": () => import("./views/home.js"),
  "/library": () => import("./views/library.js"),
  "/artists": () => import("./views/artists.js"),
  "/albums": () => import("./views/albums.js"),
  "/history": () => import("./views/history.js"),
  "/tracks": () => import("./views/tracks.js"),
  "/playlists": () => import("./views/playlists.js"),
  "/settings": () => import("./views/settings.js"),
};

const DEFAULT_ROUTE = "/home";

function parseHash() {
  // Strips leading "#", returns "/library" or "" for root.
  const raw = window.location.hash.replace(/^#/, "");
  return raw;
}

export function currentRoute() {
  const path = parseHash();
  return path in routes ? path : DEFAULT_ROUTE;
}

async function resolve(mount) {
  const path = currentRoute();
  const loader = routes[path] ?? routes[DEFAULT_ROUTE];

  try {
    const mod = await loader();
    const node = mod.render();
    mount.replaceChildren(node);
    window.dispatchEvent(
      new CustomEvent("route-changed", { detail: { path } })
    );
  } catch (err) {
    // Surface the error visibly rather than silently breaking the shell.
    console.error("[router] failed to render", path, err);
    mount.replaceChildren(renderRouteError(path, err));
  }
}

function renderRouteError(path, err) {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.innerHTML = `
    <p class="empty-state__title">Route failed to load</p>
    <p class="empty-state__hint">${path || "/"} — ${err?.message ?? "unknown error"}</p>
  `;
  return div;
}

export function initRouter(mount) {
  // Register listener BEFORE any hash mutation so the event doesn't fire
  // before we're listening.
  window.addEventListener("hashchange", () => resolve(mount));

  if (!window.location.hash) {
    window.location.hash = DEFAULT_ROUTE;
  } else {
    resolve(mount);
  }
}
