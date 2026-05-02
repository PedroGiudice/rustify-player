/* ============================================================
   router.ts — Hash router reescrito com Solid signals.
   API idêntica ao router.js atual, mas a rota é um signal
   que qualquer componente pode ler reativamente.
   ============================================================ */

import { createSignal } from "solid-js";
import { lazy, type Component } from "solid-js";

// ── Lazy imports — Vite faz code splitting por rota ────────────

const VIEWS: Record<string, Component<{ param?: string | null }>> = {
  "/home":        lazy(() => import("./views/Home")),
  "/library":     lazy(() => import("./views/Library")),
  "/artists":     lazy(() => import("./views/Artists")),
  "/albums":      lazy(() => import("./views/Albums")),
  "/album":       lazy(() => import("./views/Album")),
  "/artist":      lazy(() => import("./views/Artist")),
  "/history":     lazy(() => import("./views/History")),
  "/tracks":      lazy(() => import("./views/Tracks")),
  "/playlists":   lazy(() => import("./views/Playlists")),
  "/stations":    lazy(() => import("./views/Stations")),
  "/queue":       lazy(() => import("./views/Queue")),
  "/now-playing": lazy(() => import("./views/NowPlaying")),
  "/signal":      lazy(() => import("./views/Signal")),
  "/settings":    lazy(() => import("./views/Settings")),
};

const DEFAULT_ROUTE = "/home";

// ── Parse ──────────────────────────────────────────────────────

export interface Route {
  path: string;
  param: string | null;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const parts = raw.match(/^(\/[a-z-]+)(?:\/(.+))?$/);
  if (parts) return { path: parts[1], param: parts[2] ?? null };
  return { path: raw || DEFAULT_ROUTE, param: null };
}

// ── Signal de rota ─────────────────────────────────────────────

const [route, _setRoute] = createSignal<Route>(parseHash());

window.addEventListener("hashchange", () => _setRoute(parseHash()));

export { route };

// ── Helpers ────────────────────────────────────────────────────

export function navigate(path: string) {
  window.location.hash = path;
}

export function currentPath(): string {
  return route().path;
}

// ── Componente RouterView ──────────────────────────────────────
// Usado no App.tsx como <RouterView />

import { Suspense, Dynamic } from "solid-js/web";

export function RouterView() {
  const view = () => VIEWS[route().path] ?? VIEWS[DEFAULT_ROUTE];
  return (
    <Suspense fallback={<div class="empty-state"><p class="empty-state__hint">Loading…</p></div>}>
      <Dynamic component={view()} param={route().param} />
    </Suspense>
  );
}
