/* Menu de contexto pelo teclado (A35, varredura de 31/10): aberto pela tecla
   Menu, Shift+F10 ou Enter no "More", ancora no gatilho, o foco vai ao
   primeiro item, as setas andam e Esc/Tab devolvem o foco ao gatilho. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({
  libToggleLike: vi.fn(), libIsLiked: vi.fn().mockResolvedValue(true), setVolume: vi.fn(),
  playerEnqueueNext: vi.fn(),
}));
vi.mock("./PlayerBar", () => ({ playTrack: vi.fn() }));

import { TrackContextMenu } from "./TrackContextMenu";
import { closeTrackMenu, fromKeyboard, openTrackMenu, trackMenu } from "../store/contextMenu";
import type { Track } from "../tauri";

const T: Track = {
  id: "1", title: "Faixa", artist_name: "A", album_title: "B", album_cover_path: null, album_year: null,
  duration_ms: 1, path: "/m/1", lrc_path: null,
};
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

afterEach(() => { closeTrackMenu(); cleanup(); document.body.innerHTML = ""; });

function setup() {
  const r = render(() => (
    <>
      <button id="more" onClick={(e) => openTrackMenu(e, T)}>More</button>
      <TrackContextMenu />
    </>
  ));
  const more = document.getElementById("more")!;
  more.getBoundingClientRect = () => ({ left: 300, top: 200, bottom: 228, right: 330, width: 30, height: 28, x: 300, y: 200, toJSON() {} });
  return { ...r, more };
}
const items = () => [...document.querySelectorAll<HTMLElement>('.track-ctx-menu [role="menuitem"]')];
const key = (k: string, init: KeyboardEventInit = {}) =>
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
  );

describe("menu de contexto pelo teclado (A35)", () => {
  it("Enter no 'More' (clique com detail 0) ancora no gatilho, não no canto", async () => {
    const { more } = setup();
    more.focus();
    fireEvent.click(more, { detail: 0, clientX: 0, clientY: 0 });
    expect(trackMenu()?.anchor).toEqual({ left: 300, top: 200, bottom: 228 });
    expect(trackMenu()?.x).toBe(300);
    expect(trackMenu()?.y).toBe(232);
  });

  it("foco no primeiro item; ↓ ↑ andam com volta; Home e End vão às pontas", async () => {
    const { more } = setup();
    more.focus();
    fireEvent.click(more, { detail: 0 });
    await frame();
    const list = items();
    expect(document.activeElement).toBe(list[0]);
    key("ArrowDown");
    expect(document.activeElement).toBe(list[1]);
    key("ArrowUp");
    key("ArrowUp");
    expect(document.activeElement).toBe(list[list.length - 1]);
    key("Home");
    expect(document.activeElement).toBe(list[0]);
    key("End");
    expect(document.activeElement).toBe(list[list.length - 1]);
  });

  it("Esc fecha e devolve o foco ao gatilho", async () => {
    const { more } = setup();
    more.focus();
    fireEvent.click(more, { detail: 0 });
    await frame();
    key("Escape");
    expect(trackMenu()).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("Tab fecha e devolve o foco ao gatilho", async () => {
    const { more } = setup();
    more.focus();
    fireEvent.click(more, { detail: 0 });
    await frame();
    key("Tab");
    expect(trackMenu()).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("pelo ponteiro abre onde o clique foi e o foco fica no menu", async () => {
    const { more } = setup();
    fireEvent.click(more, { detail: 1, clientX: 40, clientY: 50 });
    expect(trackMenu()?.anchor).toBeNull();
    expect(trackMenu()?.x).toBe(40);
    await frame();
    expect(document.activeElement).toBe(document.querySelector(".track-ctx-menu"));
  });

  it("menu rotulado; ícones de 14 px; coração curtido marcado para o tom de curtida", async () => {
    const { more } = setup();
    fireEvent.click(more, { detail: 1, clientX: 40, clientY: 50 });
    await frame();
    await Promise.resolve();
    const menu = document.querySelector(".track-ctx-menu")!;
    expect(menu.getAttribute("aria-label")).toBe("Ações de Faixa");
    expect(document.querySelector('.track-ctx-menu__icon[data-liked="true"]')).not.toBeNull();
  });

  it("fromKeyboard: contextmenu de mouse com coordenadas não é teclado", () => {
    const ev = new MouseEvent("contextmenu", { detail: 0, clientX: 10, clientY: 10 });
    expect(fromKeyboard(ev)).toBe(false);
    expect(fromKeyboard(new MouseEvent("contextmenu", { detail: 0 }))).toBe(true);
    expect(fromKeyboard(new MouseEvent("click", { detail: 1 }))).toBe(false);
  });
});
