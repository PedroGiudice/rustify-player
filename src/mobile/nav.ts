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

export const TABS = ["/home", "/search", "/library", "/queue"] as const;
const DEFAULT_ROUTE = "/home";
const NP_ROUTE = "/np";

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const m = raw.match(/^(\/[a-z-]+)(?:\/(.*))?$/);
  if (!m) return { path: DEFAULT_ROUTE, param: null };
  return { path: m[1], param: m[2] ? decodeURIComponent(m[2]) : null };
}

const sameRoute = (a: Route, b: Route) => a.path === b.path && a.param === b.param;

const [route, setRoute] = createSignal<Route>(parseHash());

/* A última rota que não é o Now Playing: é ela que continua
   renderizada por baixo do overlay.

   Comparador por VALOR (mobile-v1): sync() cria um Route novo a cada
   hashchange, e fechar o NP (#/np → #/library) mudava a identidade da
   rota base sem mudar a rota. screen() recriava a tela inteira — faceta,
   busca, lista carregada e rolagem se perdiam no gesto mais frequente do
   app (abrir e fechar o NP). */
const [baseRoute, setBaseRoute] = createSignal<Route>(
  parseHash().path === NP_ROUTE ? { path: DEFAULT_ROUTE, param: null } : parseHash(),
  { equals: sameRoute },
);

/* ── Rolagem por entrada do histórico (mobile-3) ─────────────────
   A tela de base rola dentro de .view, não no documento: a restauração
   nativa do navegador não se aplica. Cada entrada de hash ganha um id em
   history.state (o state sobrevive ao voltar), e a rolagem fica guardada
   por id. Voltar a uma entrada devolve a posição dela; uma entrada NOVA
   (navegar, trocar de aba) não tem posição e abre no topo — a semântica
   do voltar de qualquer navegador. */

const ENTRY_KEY = "rustifyNavEntry";
const MAX_REMEMBERED = 100;
let entrySeq = 0;
let baseEntry = "";
const scrollByEntry = new Map<string, number>();

function currentEntryId(): string {
  const st: unknown = history.state;
  const bag = st && typeof st === "object" ? (st as Record<string, unknown>) : {};
  const known = bag[ENTRY_KEY];
  if (typeof known === "string") return known;
  const fresh = `${Date.now().toString(36)}.${++entrySeq}`;
  try {
    history.replaceState({ ...bag, [ENTRY_KEY]: fresh }, "");
  } catch {
    /* sem history utilizável: a rolagem só não é lembrada */
  }
  return fresh;
}

/** Guarda a rolagem da tela de base corrente (chamado no scroll da .view). */
export function rememberScroll(y: number) {
  if (!baseEntry) return;
  scrollByEntry.delete(baseEntry);
  scrollByEntry.set(baseEntry, y);
  if (scrollByEntry.size > MAX_REMEMBERED) {
    const oldest = scrollByEntry.keys().next().value;
    if (oldest !== undefined) scrollByEntry.delete(oldest);
  }
}

/** Rolagem guardada da entrada que está na base; null = entrada nova (topo). */
export function savedScroll(): number | null {
  return scrollByEntry.get(baseEntry) ?? null;
}

/** Scroller mínimo — a .view real ou um dublê nos testes. */
export interface Scroller {
  scrollTop: number;
}

/**
 * Leva o scroller até `target`. A tela recém-montada pode ainda não ter
 * altura (LazyList cresce por sentinela, Folder carrega por IPC): o
 * scrollTop fica preso no máximo atual. Por isso reaplica a cada quadro,
 * até chegar ou esgotar `maxFrames`. Devolve o cancelamento — o toque do
 * usuário ou a próxima navegação vencem a restauração.
 */
export function restoreScroll(
  el: Scroller,
  target: number,
  raf: (cb: () => void) => unknown = requestAnimationFrame,
  maxFrames = 60,
): () => void {
  let cancelled = false;
  let frames = 0;
  const step = () => {
    if (cancelled) return;
    el.scrollTop = target;
    if (Math.abs(el.scrollTop - target) <= 1 || ++frames >= maxFrames) return;
    raf(step);
  };
  el.scrollTop = target;
  raf(step);
  return () => {
    cancelled = true;
  };
}

function sync() {
  const r = parseHash();
  setRoute(r);
  if (r.path !== NP_ROUTE) {
    baseEntry = currentEntryId();
    setBaseRoute(r);
  }
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

/**
 * Navega A PARTIR do Now Playing. Usa replace em vez de push: o /np é uma
 * entrada empilhada e navegar por cima dela faria o botão voltar devolver o
 * usuário ao Now Playing, não à tela de origem.
 */
export function navigateFromNp(path: string, param?: string) {
  const target = param != null ? `${path}/${encodeURIComponent(param)}` : path;
  window.location.replace(`#${target}`);
  sync();
}

export function back() {
  window.history.back();
}

/**
 * Aba que acende para uma rota — sub-rotas contam para a aba de origem.
 * Settings e Stations abrem pelo header da Home, então acendem Home; a
 * Queue é aba própria desde o CMR-213 (Settings saiu do tabbar).
 */
export function tabForPath(p: string): string {
  if (p === "/folder" || p === "/album" || p === "/artist") return "/library";
  if (p === "/stations" || p === "/settings") return "/home";
  return (TABS as readonly string[]).includes(p) ? p : DEFAULT_ROUTE;
}

/** Aba ativa no tabbar. */
export function activeTab(): string {
  return tabForPath(baseRoute().path);
}

/** Garante uma rota válida no boot (hash vazio → /home). */
export function bootRoute() {
  if (!window.location.hash || window.location.hash === "#") {
    window.location.replace(`#${DEFAULT_ROUTE}`);
  }
  sync();
}
