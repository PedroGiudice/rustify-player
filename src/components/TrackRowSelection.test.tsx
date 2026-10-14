/* ============================================================
   TrackRowSelection.test.tsx — gestos de seleção múltipla nas linhas.
   Clique simples e Enter/Espaço seguem tocando; Ctrl/Shift+clique
   mexem só na seleção.
   ============================================================ */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createSignal, Show } from "solid-js";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { TrackRowTable } from "./TrackRowTable";
import { TrackRowList } from "./TrackRowList";
import { SelectionBar } from "./SelectionBar";
import { hasFocusList, resetSelection, selectionCount, selectedTracks } from "../store/selection";
import { player, setPlayer } from "../store/player";
import { pushEscLayer } from "../lib/escLayers";

vi.mock("../tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tauri")>()),
  setVolume: vi.fn(),
  playerEnqueueNext: vi.fn().mockResolvedValue(undefined),
}));
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

const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe("escopo da seleção", () => {
  it("troca de rota zera a seleção e a lista em foco", () => {
    const { container } = render(() => (
      <>
        <div class="tracks">
          {LIST.map((t, i) => <TrackRowTable track={t} index={i + 1} onClick={() => {}} contextList={LIST} />)}
        </div>
        <SelectionBar />
      </>
    ));
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(4);
    window.location.hash = "#/albums";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(selectionCount()).toBe(0);
    expect(container.querySelector(".sel-bar")).toBeNull();
    expect(hasFocusList()).toBe(false);
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(0);
  });

  it("trocar de aba sem trocar de rota (a lista desmonta) zera a seleção", async () => {
    const [tab, setTab] = createSignal<"tracks" | "albums">("tracks");
    const { container } = render(() => (
      <>
        <Show when={tab() === "tracks"} fallback={<div class="albums" />}>
          <div class="tracks">
            {LIST.map((t, i) => <TrackRowTable track={t} index={i + 1} onClick={() => {}} contextList={LIST} />)}
          </div>
        </Show>
        <SelectionBar />
      </>
    ));
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(4);
    setTab("albums");
    await tick();
    expect(selectionCount()).toBe(0);
    expect(container.querySelector(".sel-bar")).toBeNull();
    // "Mover" não tem mais o que mover, e Ctrl+A não revive a lista de trás.
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(0);
  });

  it("lista recarregada (linhas novas, ids iguais): a seleção sobrevive, podada", async () => {
    const [list, setList] = createSignal(LIST);
    render(() => (
      <>
        <div class="tracks">
          {list().map((t, i) => <TrackRowTable track={t} index={i + 1} onClick={() => {}} contextList={list()} />)}
        </div>
        <SelectionBar />
      </>
    ));
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(4);
    setList(LIST.slice(0, 3).map((t) => ({ ...t })));
    await tick();
    expect(selectedTracks().map((t) => t.id)).toEqual(LIST.slice(0, 3).map((t) => t.id));
  });
});

describe("Ctrl+A e Esc com overlay", () => {
  it("Ctrl+A dentro de diálogo, menu, Tweaks ou fila não seleciona a lista de trás", () => {
    const { container } = render(() => (
      <>
        <div class="tracks">
          <TrackRowTable track={LIST[0]} index={1} onClick={() => {}} contextList={LIST} />
        </div>
        <div role="dialog"><button id="d" /></div>
        <div role="menu"><button id="m" /></div>
        <div class="tweaks"><button id="t" /></div>
        <div class="queue-drawer"><button id="q" /></div>
        <SelectionBar />
      </>
    ));
    for (const id of ["d", "m", "t", "q"]) {
      fireEvent.keyDown(container.querySelector(`#${id}`)!, { key: "a", ctrlKey: true });
      expect(selectionCount()).toBe(0);
    }
  });

  it("Ctrl+A com camada de Esc aberta (alvo no corpo) é ignorado", () => {
    render(() => (
      <>
        <div class="tracks">
          <TrackRowTable track={LIST[0]} index={1} onClick={() => {}} contextList={LIST} />
        </div>
        <SelectionBar />
      </>
    ));
    const pop = pushEscLayer(() => {});
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(0);
    pop();
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(LIST.length);
  });

  it("Esc fecha primeiro o overlay aberto depois da seleção; só então limpa a seleção", () => {
    render(() => (
      <>
        <div class="tracks">
          {LIST.map((t, i) => <TrackRowTable track={t} index={i + 1} onClick={() => {}} contextList={LIST} />)}
        </div>
        <SelectionBar />
      </>
    ));
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(selectionCount()).toBe(4);
    let overlayOpen = true;
    const pop = pushEscLayer(() => { overlayOpen = false; pop(); });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(overlayOpen).toBe(false);
    expect(selectionCount()).toBe(4);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(selectionCount()).toBe(0);
  });
});

describe("teclado: Shift+Espaço", () => {
  it("alterna a marca sem tocar; Espaço sozinho toca", () => {
    const played: string[] = [];
    const { container } = table((t) => played.push(t.id));
    const r = rows(container);
    fireEvent.keyDown(r[1], { key: " ", shiftKey: true });
    expect(selectedTracks().map((t) => t.id)).toEqual([LIST[1].id]);
    expect(played).toEqual([]);
    fireEvent.keyDown(r[1], { key: " ", shiftKey: true });
    expect(selectionCount()).toBe(0);
    fireEvent.keyDown(r[2], { key: " " });
    expect(played).toEqual([LIST[2].id]);
    expect(selectionCount()).toBe(0);
  });

  it("sem contextList, Shift+Espaço toca como antes", () => {
    const played: string[] = [];
    const { container } = table((t) => played.push(t.id), false);
    fireEvent.keyDown(rows(container)[0], { key: " ", shiftKey: true });
    expect(played).toEqual([LIST[0].id]);
  });

  it("a caixa tem aria-label com o título da faixa", () => {
    const { container } = table(() => {});
    expect(container.querySelectorAll(".sel-check")[0].getAttribute("aria-label")).toBe(`Selecionar T${LIST[0].id}`);
  });
});
