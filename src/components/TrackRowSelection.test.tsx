/* ============================================================
   TrackRowSelection.test.tsx — gestos de seleção múltipla nas linhas.
   Clique simples e Enter/Espaço seguem tocando; Ctrl/Shift+clique
   mexem só na seleção.
   ============================================================ */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { TrackRowTable } from "./TrackRowTable";
import { TrackRowList } from "./TrackRowList";
import { SelectionBar } from "./SelectionBar";
import { resetSelection, selectionCount, selectedTracks } from "../store/selection";
import { player, setPlayer } from "../store/player";
import type { Track } from "../tauri";

const mk = (id: string): Track => ({
  id, title: `T${id}`, artist_name: "A", album_title: "B", album_cover_path: null, album_year: null,
  duration_ms: 1000, path: `/m/${id}.flac`, lrc_path: null,
});
const LIST = ["18446744073709551613", "18446744073709551614", "18446744073709551615", "9"].map(mk);

afterEach(() => {
  cleanup();
  resetSelection();
  setPlayer({ queue: [], queueIndex: 0 });
});

function table(onPlay: (t: Track) => void, withList = true) {
  return render(() => (
    <div class="tracks">
      {LIST.map((t, i) => (
        <TrackRowTable track={t} index={i + 1} onClick={() => onPlay(t)} contextList={withList ? LIST : undefined} />
      ))}
    </div>
  ));
}
const rows = (c: HTMLElement) => [...c.querySelectorAll(".tracks__row")] as HTMLElement[];

describe("seleção nas linhas (tabela)", () => {
  it("clique simples toca e não seleciona", () => {
    const played: string[] = [];
    const { container } = table((t) => played.push(t.id));
    fireEvent.click(rows(container)[1]);
    expect(played).toEqual([LIST[1].id]);
    expect(selectionCount()).toBe(0);
  });

  it("Ctrl+clique alterna sem tocar; Shift+clique faz intervalo", () => {
    const played: string[] = [];
    const { container } = table((t) => played.push(t.id));
    const r = rows(container);
    fireEvent.click(r[0], { ctrlKey: true });
    expect(selectionCount()).toBe(1);
    fireEvent.click(r[2], { shiftKey: true });
    expect(selectedTracks().map((t) => t.id)).toEqual(LIST.slice(0, 3).map((t) => t.id));
    fireEvent.click(r[1], { ctrlKey: true });
    expect(selectionCount()).toBe(2);
    expect(played).toEqual([]);
    expect(r[0].classList.contains("tracks__row--selected")).toBe(true);
    expect(r[1].classList.contains("tracks__row--selected")).toBe(false);
    expect(r[3].classList.contains("tracks__row--sel-mode")).toBe(true);
  });

  it("a caixa do índice alterna sem tocar", () => {
    const played: string[] = [];
    const { container } = table((t) => played.push(t.id));
    fireEvent.click(container.querySelectorAll(".sel-check")[3]);
    expect(selectedTracks().map((t) => t.id)).toEqual(["9"]);
    expect(played).toEqual([]);
  });

  it("sem contextList não há seleção: Ctrl+clique toca como antes", () => {
    const played: string[] = [];
    const { container } = table((t) => played.push(t.id), false);
    expect(container.querySelector(".sel-check")).toBeNull();
    fireEvent.click(rows(container)[0], { ctrlKey: true });
    expect(played).toEqual([LIST[0].id]);
    expect(selectionCount()).toBe(0);
  });

  it("Enter e Espaço continuam tocando", () => {
    let plays = 0;
    const { container } = table(() => { plays++; });
    fireEvent.keyDown(rows(container)[0], { key: "Enter" });
    fireEvent.keyDown(rows(container)[0], { key: " " });
    expect(plays).toBe(2);
  });
});

describe("seleção nas linhas (lista com capa)", () => {
  it("Ctrl+clique seleciona; compact ignora", () => {
    const played: string[] = [];
    const { container } = render(() => (
      <>
        {LIST.map((t) => <TrackRowList track={t} onClick={() => played.push(t.id)} contextList={LIST} />)}
        <TrackRowList track={LIST[0]} onClick={() => played.push("q")} contextList={LIST} size="compact" />
      </>
    ));
    const r = [...container.querySelectorAll('[role="row"]')] as HTMLElement[];
    fireEvent.click(r[1], { ctrlKey: true });
    expect(r[1].classList.contains("is-selected")).toBe(true);
    fireEvent.click(r[4], { ctrlKey: true });
    expect(played).toEqual(["q"]);
    expect(selectionCount()).toBe(1);
    fireEvent.click(r[2]);
    expect(played).toEqual(["q", LIST[2].id]);
  });
});

describe("SelectionBar", () => {
  it("contagem, Ctrl+A, fila e Esc", () => {
    setPlayer({ queue: [mk("x")], queueIndex: 0 });
    const { container } = render(() => (
      <>
        <div class="tracks">
          {LIST.map((t, i) => <TrackRowTable track={t} index={i + 1} onClick={() => {}} contextList={LIST} />)}
        </div>
        <SelectionBar />
      </>
    ));
    expect(container.querySelector(".sel-bar")).toBeNull();
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(4);
    const bar = container.querySelector(".sel-bar") as HTMLElement;
    expect(bar.querySelector(".sel-bar__count")!.textContent).toBe("4 selecionadas");
    expect(bar.textContent).toContain("Mover 4 faixas para playlist…");
    const next = [...bar.querySelectorAll("button")].find((b) => b.textContent?.includes("a seguir"))!;
    fireEvent.click(next);
    expect(player.queue.map((t) => t.id)).toEqual(["x", ...LIST.map((t) => t.id)]);
    expect(selectionCount()).toBe(0);
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(4);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(selectionCount()).toBe(0);
  });

  it("Ctrl+A em campo de texto não rouba o atalho", () => {
    const { container } = render(() => (
      <>
        <input />
        <div class="tracks">
          <TrackRowTable track={LIST[0]} index={1} onClick={() => {}} contextList={LIST} />
        </div>
        <SelectionBar />
      </>
    ));
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(0);
  });
});
