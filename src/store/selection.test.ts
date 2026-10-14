/* store/selection.ts — granularidade da reatividade: um clique reavalia só
   as linhas cujo estado mudou, e o modo de seleção notifica só na virada. */
import { describe, it, expect, afterEach } from "vitest";
import { createEffect, createRoot } from "solid-js";
import { isSelected, resetSelection, selectionActive, toggleTrack } from "./selection";
import type { Track } from "../tauri";

const mk = (id: string) => ({ id, title: id, path: id } as Track);
const LIST = ["18446744073709551615", "b", "c"].map(mk);

afterEach(resetSelection);

describe("reatividade da seleção", () => {
  it("marcar uma faixa não reavalia as outras; o modo só vira uma vez", () => {
    const runs = { a: 0, b: 0, mode: 0 };
    const dispose = createRoot((d) => {
      createEffect(() => { isSelected(LIST[0].id); runs.a++; });
      createEffect(() => { isSelected("b"); runs.b++; });
      createEffect(() => { selectionActive(); runs.mode++; });
      return d;
    });
    expect(runs).toEqual({ a: 1, b: 1, mode: 1 });
    toggleTrack(LIST, LIST[0].id);
    expect(isSelected(LIST[0].id)).toBe(true);
    expect(runs).toEqual({ a: 2, b: 1, mode: 2 });
    toggleTrack(LIST, "c");
    expect(runs).toEqual({ a: 2, b: 1, mode: 2 });
    resetSelection();
    expect(isSelected(LIST[0].id)).toBe(false);
    expect(runs).toEqual({ a: 3, b: 1, mode: 3 });
    dispose();
  });
});
