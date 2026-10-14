// src/store/contextMenu.ts — estado global do menu de contexto de faixa.
// Singleton: um menu por vez no app inteiro, renderizado por <TrackContextMenu/>
// montado no App. Os TrackRow chamam openTrackMenu no onContextMenu da linha.
import { createSignal } from "solid-js";
import type { Track } from "../tauri";

export interface TrackMenuState {
  track: Track;
  /** Lista circundante — habilita o item Shuffle. null/ausente = sem Shuffle. */
  list: Track[] | null;
  /** "tocar esta faixa no contexto da view" — reusa o onClick da linha. */
  onPlay: (() => void) | null;
  /** Seleção múltipla que contém a faixa clicada; o menu age sobre ela inteira. */
  selection: Track[] | null;
  x: number;
  y: number;
}

const [trackMenu, setTrackMenu] = createSignal<TrackMenuState | null>(null);
export { trackMenu };

export function openTrackMenu(
  e: MouseEvent,
  track: Track,
  opts?: { list?: Track[]; onPlay?: () => void; selection?: Track[] },
) {
  e.preventDefault();
  e.stopPropagation();
  setTrackMenu({
    track,
    list: opts?.list ?? null,
    onPlay: opts?.onPlay ?? null,
    selection: opts?.selection ?? null,
    x: e.clientX,
    y: e.clientY,
  });
}

export function closeTrackMenu() {
  setTrackMenu(null);
}
