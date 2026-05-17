/* ============================================================
   store/pins.ts — Pin/unpin de playlists (folders).

   Persiste a lista de nomes pinados em localStorage. Sinal reativo
   pra que cards e Pinned section atualizem instantaneamente.
   Substitui o placeholder "primeiros 3 folders" do Playlists.tsx.
   ============================================================ */

import { createSignal } from "solid-js";

const STORAGE_KEY = "kv-pinned-playlists";

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

function save(list: string[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
}

const [pins, setPins] = createSignal<string[]>(load());
export { pins };

export function isPinned(name: string): boolean {
  return pins().includes(name);
}

export function pinPlaylist(name: string) {
  if (isPinned(name)) return;
  const next = [...pins(), name];
  setPins(next);
  save(next);
}

export function unpinPlaylist(name: string) {
  const next = pins().filter((n) => n !== name);
  setPins(next);
  save(next);
}

export function togglePin(name: string) {
  isPinned(name) ? unpinPlaylist(name) : pinPlaylist(name);
}
