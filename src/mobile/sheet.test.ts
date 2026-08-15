// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSheet, closeSheetThen, initSheetHistory, openSheet, sheet } from "./sheet";
import type { Track } from "./types";

const track: Track = {
  id: "1",
  title: "t",
  artist_name: "a",
  album_title: "al",
  album_cover_path: null,
  album_year: null,
  duration_ms: 1000,
  path: "/m/t.opus",
  lrc_path: null,
  track_number: null,
  genre_name: null,
  dominant_color: null,
};

/** jsdom dispara popstate de forma assíncrona; espera o evento chegar. */
function popstate(): Promise<void> {
  return new Promise((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
}

let dispose: (() => void) | undefined;

beforeEach(() => {
  history.replaceState(null, "", "#/library");
  dispose = initSheetHistory();
});

afterEach(() => {
  dispose?.();
  closeSheet();
});

describe("sheet", () => {
  it("abre e fecha", async () => {
    expect(sheet()).toBeNull();
    openSheet({ kind: "track", track });
    expect(sheet()?.kind).toBe("track");
    const p = popstate();
    closeSheet();
    await p;
    expect(sheet()).toBeNull();
  });

  it("o voltar do Android fecha a sheet em vez de sair da tela", async () => {
    openSheet({ kind: "track", track });
    const p = popstate();
    history.back();
    await p;
    expect(sheet()).toBeNull();
  });

  it("fechar consome a sentinela: o voltar seguinte não reabre nem some com a tela", async () => {
    // Bug real que isto trava: se closeSheet apenas limpasse o signal, a
    // entrada de history ficaria órfã e o próximo "voltar" do usuário seria
    // engolido pela sentinela — a tela não voltaria.
    const before = history.length;
    openSheet({ kind: "track", track });
    const p = popstate();
    closeSheet();
    await p;
    expect(sheet()).toBeNull();
    expect(history.length).toBeLessThanOrEqual(before + 1);
  });

  it("closeSheetThen roda a navegação DEPOIS de consumir a sentinela", async () => {
    // Sem isso, navegar de dentro da sheet empilha uma entrada POR CIMA da
    // sentinela e o voltar devolve o usuário à sheet.
    const spy = vi.fn();
    openSheet({ kind: "track", track });
    const p = popstate();
    closeSheetThen(spy);
    expect(spy).not.toHaveBeenCalled(); // ainda não: a sentinela não foi consumida
    await p;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it("abrir com a sheet já aberta troca o conteúdo sem empilhar outra sentinela", async () => {
    openSheet({ kind: "track", track });
    const len = history.length;
    openSheet({ kind: "info", track });
    expect(sheet()?.kind).toBe("info");
    expect(history.length).toBe(len);
    const p = popstate();
    closeSheet();
    await p;
    expect(sheet()).toBeNull();
  });

  it("closeSheet com a sheet fechada é no-op (não mexe no histórico)", () => {
    const len = history.length;
    closeSheet();
    expect(sheet()).toBeNull();
    expect(history.length).toBe(len);
  });

  it("closeSheetThen com a sheet fechada executa a ação na hora", () => {
    const spy = vi.fn();
    closeSheetThen(spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
