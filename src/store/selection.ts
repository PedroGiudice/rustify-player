// src/store/selection.ts — seleção múltipla de faixas (Ctrl/Shift+clique).
// Escopada à "lista em foco": a contextList da última linha montada,
// focada ou clicada. Troca de rota zera tudo (SelectionBar). Regras puras
// em lib/selection.ts.
import { createSignal } from "solid-js";
import type { Track } from "../tauri";
import {
  EMPTY_SEL, pickSelected, pruneTo, selectAll, selectRange, toggleId, type SelState,
} from "../lib/selection";

const [state, setState] = createSignal<SelState>(EMPTY_SEL);
const [focusTracks, setFocusTracks] = createSignal<Track[]>([]);

export const selectionCount = () => state().ids.size;
export const isSelected = (id: string) => state().ids.has(id);
export const selectedTracks = (): Track[] => pickSelected(state(), focusTracks());
export const hasFocusList = () => focusTracks().length > 0;

const idsOf = (l: Track[]) => l.map((t) => t.id);

/** Declara a lista em foco. Trocar de lista descarta o que não está nela. */
export function focusList(list: Track[]) {
  if (list === focusTracks()) return;
  setFocusTracks(list);
  setState((s) => pruneTo(s, idsOf(list)));
}

export function toggleTrack(list: Track[], id: string) {
  focusList(list);
  setState((s) => toggleId(s, id));
}

export function rangeToTrack(list: Track[], id: string) {
  focusList(list);
  setState((s) => selectRange(s, idsOf(list), id));
}

export function selectAllInFocus() {
  const l = focusTracks();
  if (l.length > 0) setState(selectAll(idsOf(l)));
}

export function clearSelection() {
  if (state().ids.size > 0) setState(EMPTY_SEL);
}

/** Troca de rota: zera seleção e lista em foco. */
export function resetSelection() {
  setState(EMPTY_SEL);
  setFocusTracks([]);
}

/** Faixas que o menu de contexto de `track` deve atingir: a seleção inteira
    quando a linha clicada faz parte dela; undefined = só a faixa. */
export function menuSelection(list: Track[], track: Track): Track[] | undefined {
  focusList(list);
  if (!state().ids.has(track.id)) return undefined;
  return selectedTracks();
}

/** Clique na linha. Shift/Ctrl(Cmd)+clique mexem na seleção; o clique
    simples é exatamente o de antes (props.onClick da linha). */
export function rowClick(e: MouseEvent, list: Track[] | undefined, id: string, play: () => void) {
  if (list) {
    if (e.shiftKey) return rangeToTrack(list, id);
    if (e.ctrlKey || e.metaKey) return toggleTrack(list, id);
  }
  play();
}

/** Shift+clique no mousedown seleciona texto da página; barra isso. */
export function rowMouseDown(e: MouseEvent, list: Track[] | undefined) {
  if (list && e.shiftKey) e.preventDefault();
}
