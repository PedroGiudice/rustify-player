// src/store/selection.ts — seleção múltipla de faixas (Ctrl/Shift+clique).
// Escopada à "lista em foco": a contextList da última linha montada,
// focada ou clicada. A lista tem dono com ciclo de vida: cada linha a
// reivindica (claimList) e, quando a última linha da lista em foco
// desmonta (troca de aba da Library, de rota, de view), a seleção zera.
// Regras puras em lib/selection.ts.
import { batch, createMemo, createRoot, createSignal, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import type { Track } from "../tauri";
import {
  EMPTY_SEL, pickSelected, pruneTo, selectAll, selectRange, toggleId, withoutIds, type SelState,
} from "../lib/selection";

const [state, setStateRaw] = createSignal<SelState>(EMPTY_SEL);
const [focusTracks, setFocusTracks] = createSignal<Track[]>([]);

// Marcas por id (store com chave por faixa): um clique só reavalia as linhas
// cujo estado mudou, não as ~1757 da aba Tracks. Ids ficam como string.
const [marks, setMarks] = createStore<Record<string, true | undefined>>({});

function setState(next: SelState | ((s: SelState) => SelState)) {
  const prev = state();
  const to = typeof next === "function" ? next(prev) : next;
  if (to === prev) return;
  batch(() => {
    for (const id of prev.ids) if (!to.ids.has(id)) setMarks(id, undefined);
    for (const id of to.ids) if (!prev.ids.has(id)) setMarks(id, true);
    setStateRaw(to);
  });
}

export const selectionCount = () => state().ids.size;
export const isSelected = (id: string) => marks[id] === true;
/** Modo de seleção (há alguma faixa marcada): memo único, só notifica na virada. */
export const selectionActive = createRoot(() => createMemo(() => state().ids.size > 0));
export const selectedTracks = (): Track[] => pickSelected(state(), focusTracks());
export const hasFocusList = () => focusTracks().length > 0;

const idsOf = (l: Track[]) => l.map((t) => t.id);

// Linhas montadas por lista (identidade do array). Lista sem linhas deixa
// de ser válida: a seleção que ela sustentava não é mais visível.
const owners = new WeakMap<Track[], number>();

/** A linha reivindica a lista (declara foco e conta uma referência). Devolve
    a função que solta a referência; quando a última cai e a lista ainda é a
    em foco, a seleção zera. O teste roda num microtask: o <For> desmonta as
    linhas antigas antes de montar as da lista recarregada, e nessa troca a
    lista nova já assumiu o foco (a seleção é só podada, não zerada). */
export function claimList(list: Track[]): () => void {
  owners.set(list, (owners.get(list) ?? 0) + 1);
  // untrack: chamado dentro de um effect da linha; ler o estado aqui não pode
  // fazer o effect reexecutar (soltaria e reivindicaria a lista a cada clique).
  untrack(() => focusList(list));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (owners.get(list) ?? 1) - 1;
    owners.set(list, n);
    if (n > 0) return;
    queueMicrotask(() => {
      if (focusTracks() === list && (owners.get(list) ?? 0) === 0) resetSelection();
    });
  };
}

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

/** Tira só estes ids da seleção (movidos para outra playlist). */
export function deselectIds(ids: Iterable<string>) {
  setState((s) => withoutIds(s, ids));
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
