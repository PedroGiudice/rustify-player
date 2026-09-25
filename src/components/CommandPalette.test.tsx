/* ============================================================
   CommandPalette.test.tsx — ActionItem do Crate (D3).

   "Procurar "<q>" na rede →" sempre presente com query digitada,
   promovido ao topo quando a busca local não acha nada (spec §4.1).
   run() navega pra /crate/<q> e fecha o palette.

   Auditoria de UI 25/09 (shell-8): as setas levam a seleção para a
   área visível da lista, e Enter antes da busca responder espera o
   resultado em vez de executar o item da busca anterior (ou o
   "Procurar na rede" que ocupa o topo enquanto não há resultado).
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return {
    ...actual,
    libSearch: vi.fn(async () => ({ tracks: [], albums: [], artists: [] })),
    libShuffle: vi.fn(async () => []),
  };
});

import * as tauriApi from "../tauri";
import { playTrack } from "./PlayerBar";
import { CommandPalette, CMD_PALETTE_EVENT } from "./CommandPalette";

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
});

function openPalette() {
  window.dispatchEvent(new CustomEvent(CMD_PALETTE_EVENT));
}

describe("CommandPalette — ActionItem do Crate", () => {
  it("sem resultados locais, o item 'Procurar na rede' aparece no topo", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({ tracks: [], albums: [], artists: [] } as any);
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });

    await waitFor(() => {
      expect(tauriApi.libSearch).toHaveBeenCalledWith("sicko mode", 6);
    });

    await waitFor(() => {
      const first = container.querySelector(".palette__item");
      expect(first?.textContent).toContain('Procurar "sicko mode" na rede');
    });
  });

  it("com resultados locais, o item continua presente (não no topo)", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({
      tracks: [{ id: "1", title: "Sicko Mode", artist_name: "Travis Scott", album_title: null, album_cover_path: null, album_year: null, duration_ms: 180000, path: "/a.flac", lrc_path: null }],
      albums: [],
      artists: [],
    } as any);
    const { container, getByText } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });

    await waitFor(() => {
      expect(tauriApi.libSearch).toHaveBeenCalledWith("sicko mode", 6);
    });
    await waitFor(() => {
      expect(getByText("Sicko Mode")).toBeTruthy();
    });
    const first = container.querySelector(".palette__item");
    expect(first?.textContent).not.toContain("Procurar");
    expect(getByText(/Procurar "sicko mode" na rede/)).toBeTruthy();
  });

  it("rodar o item navega pra /crate/<query> e fecha o palette", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({ tracks: [], albums: [], artists: [] } as any);
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });

    await waitFor(() => {
      expect(container.querySelector(".palette__item")?.textContent).toContain("Procurar");
    });
    fireEvent.click(container.querySelector(".palette__item")!);

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/crate/${encodeURIComponent("sicko mode")}`);
    });
    expect(container.querySelector('[data-open="true"]')).toBeFalsy();
  });

  it("sem query digitada, o item não aparece", async () => {
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const items = Array.from(container.querySelectorAll(".palette__item")).map((el) => el.textContent ?? "");
    expect(items.some((t) => t.includes("Procurar"))).toBe(false);
  });
});

describe("CommandPalette — ação Open queue (shell-v4)", () => {
  it("pede para ABRIR a fila (detail.open=true), não alterna", async () => {
    const seen: unknown[] = [];
    const onQ = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("rustify:open-queue", onQ);
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const item = Array.from(container.querySelectorAll(".palette__item"))
      .find((el) => el.textContent?.includes("Open queue")) as HTMLElement;
    fireEvent.click(item);
    window.removeEventListener("rustify:open-queue", onQ);
    expect(seen).toEqual([{ open: true }]);
  });
});

describe("CommandPalette — navegação por teclado (shell-8)", () => {
  it("setas rolam o item ativo para a área visível", () => {
    const scrollSpy = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const { container } = render(() => <CommandPalette />);
      openPalette();
      const input = container.querySelector(".palette__input") as HTMLInputElement;
      fireEvent.keyDown(input, { key: "ArrowDown" });
      const items = container.querySelectorAll(".palette__item");
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.contexts[0]).toBe(items[1]);
      expect(scrollSpy.mock.calls[0][0]).toEqual({ block: "nearest" });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(scrollSpy.mock.contexts[1]).toBe(items[0]);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("Enter logo após digitar espera a busca e toca a primeira faixa, não o Crate", async () => {
    const track = {
      id: "1", title: "Sicko Mode", artist_name: "Travis Scott", album_title: null,
      album_cover_path: null, album_year: null, duration_ms: 180000, path: "/a.flac", lrc_path: null,
    };
    vi.mocked(tauriApi.libSearch).mockResolvedValue({ tracks: [track], albums: [], artists: [] } as any);
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(vi.mocked(playTrack)).toHaveBeenCalledWith(track);
    });
    expect(window.location.hash).not.toContain("/crate/");
  });

  it("Enter com a query mudada espera a busca nova, não executa o resultado anterior", async () => {
    const first = {
      id: "1", title: "Antiga", artist_name: null, album_title: null,
      album_cover_path: null, album_year: null, duration_ms: 1, path: "/1", lrc_path: null,
    };
    const second = { ...first, id: "2", title: "Nova", path: "/2" };
    vi.mocked(tauriApi.libSearch).mockImplementation(async (q: string) =>
      ({ tracks: [q === "ab" ? second : first], albums: [], artists: [] }) as any);
    const { container, getByText } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "a" } });
    await waitFor(() => expect(getByText("Antiga")).toBeTruthy());

    fireEvent.input(input, { target: { value: "ab" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(vi.mocked(playTrack)).toHaveBeenCalled();
    });
    expect(vi.mocked(playTrack)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(playTrack)).toHaveBeenCalledWith(second);
  });
});

// shell-13: fora do Mac o "tocar em seguida" é Ctrl+Enter; a dica dizia ⌘↵.
describe("CommandPalette — dicas de atalho (shell-13)", () => {
  it("fora do Mac, rodapé e dica da faixa dizem Ctrl+↵", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({
      tracks: [{ id: "1", title: "Sicko Mode", artist_name: "Travis Scott", album_title: null, album_cover_path: null, album_year: null, duration_ms: 180000, path: "/a.flac", lrc_path: null }],
      albums: [],
      artists: [],
    } as any);
    const { container, getByText } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko" } });
    await waitFor(() => expect(getByText("Sicko Mode")).toBeTruthy());
    const footer = container.querySelector(".palette__footer")!.textContent ?? "";
    expect(footer).toContain("Ctrl+↵");
    const hints = Array.from(container.querySelectorAll(".palette__item-hint")).map((el) => el.textContent ?? "");
    expect(hints.some((t) => t.includes("Ctrl+↵ next"))).toBe(true);
    expect(container.textContent).not.toContain("⌘");
  });
});

// shell-8 (erro): o catch de libSearch devolvia lista vazia, e a falha da
// busca local aparecia como "nada encontrado" (o "Procurar na rede" no
// topo). Agora uma linha diz que a busca falhou.
describe("CommandPalette — falha da busca local (shell-8)", () => {
  it("libSearch rejeitado mostra 'Busca local falhou'", async () => {
    vi.mocked(tauriApi.libSearch).mockRejectedValue(new Error("indexer caiu"));
    const { container, findByText } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko" } });
    const line = await findByText("Busca local falhou");
    expect(line.getAttribute("role")).toBe("status");
    // A saída pela rede continua lá.
    expect(container.textContent).toContain('Procurar "sicko" na rede');
  });

  it("busca que responde vazia não mostra erro", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({ tracks: [], albums: [], artists: [] } as any);
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko" } });
    await waitFor(() => expect(tauriApi.libSearch).toHaveBeenCalledWith("sicko", 6));
    await waitFor(() => expect(container.querySelector(".palette__item")?.textContent).toContain("Procurar"));
    expect(container.textContent).not.toContain("Busca local falhou");
  });
});
