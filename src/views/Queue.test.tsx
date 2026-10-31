/* Queue.tsx (rota /queue): o mesmo conserto do A9 feito na gaveta.
   Rótulos em PT-BR, cabeçalho que diz "só esta faixa" em vez de "0 tracks",
   nota do que vem depois, e clicar na faixa atual abre o Now Playing em vez
   de recomeçar a música (e registrar mais um play). */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn(), playQueueUpcoming: vi.fn() }));
vi.mock("../router", () => ({ navigate: vi.fn() }));
vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return { ...actual, setVolume: vi.fn(), playerEnqueueNext: vi.fn(async () => {}) };
});

import Queue from "./Queue";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import type { AutoplayReason, Track } from "../tauri";

const T = (id: string, ms = 60_000): Track => ({
  id, title: `Faixa ${id}`, artist_name: "Artista", album_title: "Disco",
  album_cover_path: null, album_year: null, duration_ms: ms, path: `/${id}`, lrc_path: null,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); setQueue([], 0); });

describe("Queue (rota /queue)", () => {
  it("só a faixa atual: cabeçalho diz 'só esta faixa' e a nota diz que o rádio escolhe", () => {
    setQueue([T("a")], 0);
    const { container, getByText } = render(() => <Queue />);
    expect(getByText("Tocando agora")).toBeTruthy();
    expect(container.querySelector(".view__head-hint")!.textContent).toBe("só esta faixa");
    expect(container.textContent).toContain("Depois desta, o rádio escolhe.");
    expect(container.textContent).not.toMatch(/tracks/);
  });

  it("com próximas: 'A seguir · n' e o total em faixas e tempo", () => {
    setQueue([T("a"), T("b"), T("c")], 0);
    const { container, getByText } = render(() => <Queue />);
    expect(getByText("A seguir · 2")).toBeTruthy();
    expect(container.querySelector(".view__head-hint")!.textContent).toBe("2 faixas a seguir · 2:00");
    expect(container.textContent).toContain("Fim da lista. O rádio continua depois dela.");
  });

  it("clicar na faixa atual abre o Now Playing e não recomeça a música", () => {
    setQueue([T("a"), T("b")], 0);
    const { getAllByText } = render(() => <Queue />);
    fireEvent.click(getAllByText("Faixa a")[0]);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith("/now-playing");
    expect(vi.mocked(playTrack)).not.toHaveBeenCalled();
  });

  it("cada faixa do rádio diz por que entrou, inclusive a que toca (B10)", () => {
    const disc: AutoplayReason = { kind: "discovery", ended: 0, liked: false, pool: "taste", seed_id: "x" };
    const shuf: AutoplayReason = { kind: "shuffle", ended: null, liked: null, pool: null, seed_id: "x" };
    setQueue([{ ...T("a"), autoplay_reason: disc }, { ...T("b"), autoplay_reason: shuf }, T("c")], 0);
    const { container } = render(() => <Queue />);
    const whys = [...container.querySelectorAll(".queue-view__why")].map((e) => e.textContent);
    expect(whys).toEqual(["Descoberta: nunca ouvida até o fim", "Sorteio do acervo"]);
  });
});
