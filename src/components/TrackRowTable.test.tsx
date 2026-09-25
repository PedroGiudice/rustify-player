/* ============================================================
   TrackRowTable.test.tsx — a linha da tabela .tracks recebe foco.

   A linha tem tabIndex, mas era display:contents. No WebKitGTK um
   elemento sem caixa não recebe foco: row.focus() deixava o
   activeElement onde estava (sondado no app real da cmr-auto, 25/09),
   o Tab pulava as faixas de Tracks, Album e Playlist e o anel nunca
   aparecia. O jsdom não faz layout e foca qualquer coisa com tabIndex,
   então o contrato testável é o que dá a caixa: a linha é um grid com
   subgrid (mesmas colunas da tabela) e não herda o padding/borda que a
   tabela põe nas células.
   ============================================================ */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { TrackRowTable } from "./TrackRowTable";
import type { Track } from "../tauri";

const TRACK: Track = {
  id: "t1",
  title: "Song",
  artist_name: "Artist",
  album_title: "Album",
  album_cover_path: null,
  album_year: null,
  duration_ms: 180_000,
  path: "/music/song.flac",
  lrc_path: null,
};

beforeAll(async () => {
  const NODE_FS = "node:fs";
  const { readFileSync } = await import(/* @vite-ignore */ NODE_FS);
  const root: string = (globalThis as any).process.cwd();
  const style = document.createElement("style");
  style.textContent = readFileSync(`${root}/src/styles/extractor-lab.css`, "utf8");
  document.head.appendChild(style);
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

function renderRow() {
  const { container } = render(() => (
    <div class="tracks">
      <TrackRowTable track={TRACK} index={1} onClick={() => {}} />
    </div>
  ));
  return container.querySelector(".tracks__row") as HTMLElement;
}

const noPad = (v: string) => ["", "0", "0px"].includes(v.trim());

describe("TrackRowTable — linha focável", () => {
  it("a linha tem caixa própria (grid com subgrid) e recebe o foco", () => {
    const row = renderRow();
    const cs = getComputedStyle(row);
    expect(cs.display).toBe("grid");
    expect(cs.getPropertyValue("grid-template-columns").trim()).toBe("subgrid");
    expect(cs.getPropertyValue("grid-column").replace(/\s+/g, "")).toBe("1/-1");
    row.focus();
    expect(document.activeElement).toBe(row);
  });

  it("a linha não recebe o padding nem a borda das células", () => {
    const row = renderRow();
    const cs = getComputedStyle(row);
    expect(noPad(cs.getPropertyValue("padding-top")), cs.getPropertyValue("padding-top")).toBe(true);
    expect(cs.getPropertyValue("border-bottom-width").trim()).not.toBe("1px");
  });

  it("Enter e Espaço na linha focada tocam a faixa sem rolar a view", () => {
    // Com a linha alcançável pelo Tab, o Espaço sem preventDefault
    // também rolaria o contêiner da view além de tocar.
    let plays = 0;
    const { container } = render(() => (
      <div class="tracks">
        <TrackRowTable track={TRACK} index={1} onClick={() => { plays++; }} />
      </div>
    ));
    const row = container.querySelector(".tracks__row") as HTMLElement;
    expect(fireEvent.keyDown(row, { key: " " })).toBe(false);
    expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false);
    expect(plays).toBe(2);
    expect(fireEvent.keyDown(row, { key: "a" })).toBe(true);
    expect(plays).toBe(2);
  });

  it("segurar Enter ou Espaço toca uma vez só; a repetição não rola nem re-toca", () => {
    // O auto-repeat do teclado dispara ~25-30 keydown/s com e.repeat=true.
    // Cada play extra vira record_play (play_count inflado) e player_play,
    // que grava track_skipped perto de 0 s da própria faixa escolhida.
    let plays = 0;
    const { container } = render(() => (
      <div class="tracks">
        <TrackRowTable track={TRACK} index={1} onClick={() => { plays++; }} />
      </div>
    ));
    const row = container.querySelector(".tracks__row") as HTMLElement;
    for (const key of [" ", "Enter"]) {
      expect(fireEvent.keyDown(row, { key }), key).toBe(false);
      expect(fireEvent.keyDown(row, { key, repeat: true }), `${key} repeat`).toBe(false);
      expect(fireEvent.keyDown(row, { key, repeat: true }), `${key} repeat`).toBe(false);
    }
    expect(plays).toBe(2);
  });

  it("nem no modo compacto", () => {
    document.documentElement.setAttribute("data-density", "compact");
    const row = renderRow();
    const pad = getComputedStyle(row).getPropertyValue("padding-top");
    expect(noPad(pad), pad).toBe(true);
  });
});
