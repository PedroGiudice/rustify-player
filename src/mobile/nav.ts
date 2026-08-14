/* ============================================================
   nav.ts — roteador de hash do app mobile.

   Por que hash e não estado interno: cada navegação vira uma
   entrada no histórico do WebView, então o BOTÃO VOLTAR do
   Android (que o Tauri encaminha como history.back) funciona de
   graça — inclusive para fechar o Now Playing, que é a rota /np
   empilhada por cima da aba corrente.
   ============================================================ */

import { createSignal } from "solid-js";

export interface Route {
  path: string;
  param: string | null;
}

export const TABS = ["/home", "/search", "/library", "/settings"] as const;
const DEFAULT_ROUTE = "/home";
const NP_ROUTE = "/np";

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const m = raw.match(/^(\/[a-z-]+)(?:\/(.*))?$/);
  if (!m) return { path: DEFAULT_ROUTE, param: null };
  return { path: m[1], param: m[2] ? decodeURIComponent(m[2]) : null };
}

const [route, setRoute] = createSignal<Route>(parseHash());

/* A última rota que não é o Now Playing: é ela que continua
   renderizada por baixo do overlay. */
const [baseRoute, setBaseRoute] = createSignal<Route>(
  parseHash().path === NP_ROUTE ? { path: DEFAULT_ROUTE, param: null } : parseHash(),
);

function sync() {
  const r = parseHash();
  setRoute(r);
  if (r.path !== NP_ROUTE) setBaseRoute(r);
}

window.addEventListener("hashchange", sync);

export { route, baseRoute };

export const isNpOpen = () => route().path === NP_ROUTE;

export function navigate(path: string, param?: string) {
  const target = param != null ? `${path}/${encodeURIComponent(param)}` : path;
  if (window.location.hash === `#${target}`) return;
  window.location.hash = target;
}

export function openNowPlaying() {
  navigate(NP_ROUTE);
}

export function back() {
  window.history.back();
}

/** Aba ativa no tabbar — sub-rotas contam para a aba de origem. */
export function activeTab(): string {
  const p = baseRoute().path;
  if (p === "/folder" || p === "/album" || p === "/artist" || p === "/queue") {
    return "/library";
  }
  if (p === "/stations") return "/home";
  return (TABS as readonly string[]).includes(p) ? p : DEFAULT_ROUTE;
}

/** Garante uma rota válida no boot (hash vazio → /home). */
export function bootRoute() {
  if (!window.location.hash || window.location.hash === "#") {
    window.location.replace(`#${DEFAULT_ROUTE}`);
  }
  sync();
}
