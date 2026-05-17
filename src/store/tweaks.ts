/* ============================================================
   store/tweaks.ts — Estado dos Tweaks do app (fontes, escala,
   density, sidebar, type, glow). Persiste em localStorage e
   aplica no <html> via applyTweaks(). Migra schema antigo
   (fontScale/zoom) para o novo (scale).
   ============================================================ */

import { createSignal, createEffect } from "solid-js";

const { invoke } = (window as any).__TAURI__.core;

const STORAGE_KEY = "kv-tweaks";

export type Density = "normal" | "compact";
export type Sidebar = "labels" | "icons";
export type TypeMode = "body" | "mono";

export interface TweaksState {
  fontUI: string;
  fontMono: string;
  scale: number;
  density: Density;
  sidebar: Sidebar;
  type: TypeMode;
  glow: number;
}

export const DEFAULTS: TweaksState = {
  fontUI: "",
  fontMono: "",
  scale: 1.0,
  density: "normal",
  sidebar: "labels",
  type: "body",
  glow: 0.15,
};

const [state, setState] = createSignal<TweaksState>({ ...DEFAULTS });
export const tweaks = state;

// Open/close do painel — controlado pelo evento "toggle-tweaks".
const [open, setOpen] = createSignal(false);
export const tweaksOpen = open;
export function setTweaksOpen(v: boolean) { setOpen(v); }
export function toggleTweaks() { setOpen((v) => !v); }

// Fontes do sistema — carrega uma vez, cache em memoria.
let fontsCache: string[] | null = null;
export async function listSystemFonts(): Promise<string[]> {
  if (fontsCache) return fontsCache;
  try {
    const list = await invoke<string[]>("list_system_fonts");
    fontsCache = Array.isArray(list) ? list : [];
  } catch (err) {
    console.error("[tweaks] list_system_fonts falhou:", err);
    fontsCache = [];
  }
  return fontsCache;
}

// ── Aplicacao no DOM ──────────────────────────────────────────
export function applyTweaks(s: TweaksState = state()) {
  const html = document.documentElement;

  if (s.fontUI) {
    html.style.setProperty(
      "--font-sans",
      `"${s.fontUI}", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
    );
  } else {
    html.style.removeProperty("--font-sans");
  }

  if (s.fontMono) {
    html.style.setProperty(
      "--font-mono",
      `"${s.fontMono}", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace`,
    );
  } else {
    html.style.removeProperty("--font-mono");
  }

  // zoom afeta TUDO inclusive font-size em px hardcoded.
  // Suportado pelo WebKitGTK do Tauri.
  html.style.zoom = String(s.scale);
  html.style.removeProperty("font-size");

  if (s.density === "compact") html.dataset.density = "compact";
  else delete html.dataset.density;

  if (s.sidebar === "icons") html.dataset.sidebar = "icons";
  else delete html.dataset.sidebar;

  if (s.type === "mono") html.dataset.type = "mono";
  else delete html.dataset.type;

  html.style.setProperty("--glow", String(s.glow));
}

// ── Update helper ─────────────────────────────────────────────
export function updateTweak<K extends keyof TweaksState>(key: K, val: TweaksState[K]) {
  setState((s) => ({ ...s, [key]: val }));
}

export function resetTweaks() {
  setState({ ...DEFAULTS });
}

// ── Persistencia ──────────────────────────────────────────────
function save(s: TweaksState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export function loadTweaks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { applyTweaks(); return; }
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") { applyTweaks(); return; }

    const next: TweaksState = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as Array<keyof TweaksState>) {
      if (k in saved) (next as any)[k] = saved[k];
    }
    // Migracao: schema antigo usa "zoom" como controle separado.
    if (!("scale" in saved) && "zoom" in saved) next.scale = saved.zoom;
    // Migracao: sidebar "collapsed"/"expanded" -> "icons"/"labels"
    if (saved.sidebar === "collapsed") next.sidebar = "icons";
    if (saved.sidebar === "expanded") next.sidebar = "labels";

    setState(next);
  } catch {}
  applyTweaks();
}

// Auto-apply + persist sempre que state mudar (depois do mount inicial).
// Roda no boot tambem (idempotente).
createEffect(() => {
  const s = state();
  applyTweaks(s);
  save(s);
});
