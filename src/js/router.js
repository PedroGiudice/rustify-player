// Hash router — vanilla, supports parameterized routes (e.g. /album/123).
// Views are dynamic imports. Each exposes render(params?).

const routes = {
  "":            () => import("./views/home.js"),
  "/":           () => import("./views/home.js"),
  "/home":       () => import("./views/home.js"),
  "/library":    () => import("./views/library.js"),
  "/artists":    () => import("./views/artists.js"),
  "/albums":     () => import("./views/albums.js"),
  "/album":      () => import("./views/album.js"),
  "/artist":     () => import("./views/artist.js"),
  "/history":    () => import("./views/history.js"),
  "/tracks":     () => import("./views/tracks.js"),
  "/playlists":  () => import("./views/playlists.js"),
  "/queue":      () => import("./views/queue.js"),
  "/now-playing": () => import("./views/now-playing.js"),
  "/signal":     () => import("./views/signal.js"),
  "/settings":   () => import("./views/settings.js"),
};

const DEFAULT_ROUTE = "/home";

function parseHash() {
  const raw = window.location.hash.replace(/^#/, "");
  // Split path and param: "/album/abc123" → { path: "/album", param: "abc123" }
  const parts = raw.match(/^(\/[a-z-]+)(?:\/(.+))?$/);
  if (parts) {
    return { path: parts[1], param: parts[2] || null };
  }
  return { path: raw || DEFAULT_ROUTE, param: null };
}

export function currentRoute() {
  const { path } = parseHash();
  return path in routes ? path : DEFAULT_ROUTE;
}

async function resolve(mount) {
  const { path, param } = parseHash();
  const routePath = path in routes ? path : DEFAULT_ROUTE;
  const loader = routes[routePath];

  try {
    const mod = await loader();
    const node = mod.render(param);
    mount.replaceChildren(node);
    mount.scrollTo({ top: 0 });
    window.dispatchEvent(
      new CustomEvent("route-changed", { detail: { path: routePath, param } })
    );
  } catch (err) {
    console.error("[router] failed to render", path, err);
    mount.replaceChildren(renderRouteError(path, err));
  }
}

function renderRouteError(path, err) {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.innerHTML = `
    <p class="empty-state__title">Route failed to load</p>
    <p class="empty-state__hint">${path || "/"} \u2014 ${err?.message ?? "unknown error"}</p>
  `;
  return div;
}

// Navigate programmatically
export function navigate(path) {
  window.location.hash = path;
}

export function initRouter(mount) {
  window.addEventListener("hashchange", () => resolve(mount));
  if (!window.location.hash) {
    window.location.hash = DEFAULT_ROUTE;
  } else {
    resolve(mount);
  }
}
