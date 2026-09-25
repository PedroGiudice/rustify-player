/* ============================================================
   Sheet.test.tsx — acessibilidade da bottom-sheet (mobile-20):
   o diálogo tem nome (aria-labelledby no título) e o foco entra
   nele ao abrir, em vez de ficar na tela de baixo.
   ============================================================ */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import type { Track } from "../types";

vi.mock("../ipc", () => ({ assetSrc: () => null }));
vi.mock("../store", () => ({ playSimilar: vi.fn() }));

import { Sheet } from "./Sheet";
import { closeSheet, initSheetHistory, openSheet, sheet } from "../sheet";

const track = {
  id: "1",
  title: "Faixa com nome",
  artist_name: "Fulano",
  album_title: null,
  album_cover_path: null,
  album_year: null,
  duration_ms: 1000,
  path: "/m/1.opus",
  lrc_path: null,
  track_number: null,
  genre_name: null,
  dominant_color: null,
  liked_at: null,
  like_updated_at: null,
} as Track;

let dispose: (() => void) | undefined;
beforeEach(() => {
  dispose = initSheetHistory();
});
afterEach(async () => {
  if (sheet()) {
    const popped = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
    closeSheet();
    await popped;
  }
  dispose?.();
  cleanup();
});

describe("Sheet — acessibilidade", () => {
  it("o diálogo é nomeado pelo título da sheet aberta", () => {
    const r = render(() => <Sheet />);
    openSheet({ kind: "info", track });
    const dlg = r.getByRole("dialog", { name: "Informações" });
    expect(dlg).toBeTruthy();
  });

  it("abrir move o foco para dentro da sheet", async () => {
    const r = render(() => <Sheet />);
    openSheet({ kind: "np", track });
    await Promise.resolve();
    const dlg = r.getByRole("dialog");
    expect(dlg.contains(document.activeElement)).toBe(true);
  });
});
