// src/store/contextMenu.ts — estado global do menu de contexto de faixa.
// Singleton: um menu por vez no app inteiro, renderizado por <TrackContextMenu/>
// montado no App. Os TrackRow chamam openTrackMenu no onContextMenu da linha.
import { createSignal } from "solid-js";
import type { Track } from "../tauri";

/** Retângulo do gatilho (linha ou botão "More") quando o menu abre pelo teclado. */
export interface MenuAnchor { left: number; top: number; bottom: number }

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
  /** Aberto pelo teclado (Menu, Shift+F10, Enter no "More"): ancora no gatilho
      e o foco vai ao primeiro item. null = aberto pelo ponteiro. */
  anchor: MenuAnchor | null;
  /** Quem recebe o foco de volta ao fechar (o gatilho). */
  returnTo: HTMLElement | null;
}

const [trackMenu, setTrackMenu] = createSignal<TrackMenuState | null>(null);
export { trackMenu };

/** O evento veio do teclado? Clique sintetizado por Enter/Espaço tem
    `detail` 0; o contextmenu da tecla Menu/Shift+F10 vem com pointerType
    vazio (Chromium) ou sem coordenadas (0,0). Na dúvida, ponteiro: o menu
    abre onde o evento diz, como antes. */
export function fromKeyboard(e: MouseEvent): boolean {
  if (e.detail !== 0) return false;
  if (e.type === "click") return true;
  const pt = (e as PointerEvent).pointerType;
  if (typeof pt === "string") return pt === "";
  return e.clientX === 0 && e.clientY === 0;
}

export function openTrackMenu(
  e: MouseEvent,
  track: Track,
  opts?: { list?: Track[]; onPlay?: () => void; selection?: Track[] },
) {
  e.preventDefault();
  e.stopPropagation();
  const trigger = (e.currentTarget instanceof HTMLElement ? e.currentTarget : null)
    ?? (e.target instanceof HTMLElement ? e.target : null);
  let anchor: MenuAnchor | null = null;
  if (fromKeyboard(e) && trigger) {
    const r = trigger.getBoundingClientRect();
    anchor = { left: r.left, top: r.top, bottom: r.bottom };
  }
  setTrackMenu({
    track,
    list: opts?.list ?? null,
    onPlay: opts?.onPlay ?? null,
    selection: opts?.selection ?? null,
    x: anchor ? anchor.left : e.clientX,
    y: anchor ? anchor.bottom + 4 : e.clientY,
    anchor,
    returnTo: trigger,
  });
}

export function closeTrackMenu() {
  setTrackMenu(null);
}
