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
  "/playlist":    lazy(() => import("./views/Playlist")),
  "/stations":    lazy(() => import("./views/Stations")),
  "/crate":       lazy(() => import("./views/Crate")),
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
  // Re-navegar para o hash atual não dispara hashchange. Re-emite a rota
  // como objeto novo para quem observa NAVEGAÇÕES (ex.: ⌘K "Procurar na
  // rede" com a mesma busca refaz a busca no Crate). Quem só lê campos da
  // rota (path/param) recalcula para o mesmo valor e não reage.
  if (window.location.hash === `#${path}`) {
    _setRoute(parseHash());
    return;
  }
  window.location.hash = path;
}

export function currentPath(): string {
  return route().path;
}

// ── Componente RouterView ──────────────────────────────────────
// Usado no App.tsx como <RouterView />

import { Suspense, Dynamic } from "solid-js/web";
import { ErrorBoundary, createEffect, on } from "solid-js";
import { EmptyState } from "./components/EmptyState";

/** Tela que lançou uma exceção no render: o bloco de erro no lugar dela,
    com a barra do player, a lateral e o resto do shell de pé (A7). Trocar
    de rota sai do erro sozinho. */
function ViewCrash(props: { error: unknown; reset: () => void }) {
  const at = route().path;
  createEffect(on(() => route().path, (p) => { if (p !== at) props.reset(); }, { defer: true }));
  console.error("[router] a tela falhou:", props.error);
  return (
    <div class="view-crash">
      <EmptyState
        tone="erro"
        title="Esta tela falhou."
        text="O resto do app segue funcionando e a música não parou."
        actions={[
          { label: "Tentar de novo", onClick: props.reset, primary: true },
          { label: "Ir para a Home", onClick: () => navigate("/home") },
        ]}
      />
    </div>
  );
}

export function RouterView() {
  const view = () => VIEWS[route().path] ?? VIEWS[DEFAULT_ROUTE];
  return (
    <ErrorBoundary fallback={(err, reset) => <ViewCrash error={err} reset={reset} />}>
      <Suspense fallback={<div class="empty-state"><p class="empty-state__hint">Loading…</p></div>}>
        <Dynamic component={view()} param={route().param} />
      </Suspense>
    </ErrorBoundary>
  );
}
