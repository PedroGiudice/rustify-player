/* ============================================================
   PlayerBar.test.tsx — Regressao dos cleanups do onMount.
   Listeners DOM e o save interval devem ser registrados (e seus
   onCleanup armados) SINCRONAMENTE: onCleanup chamado apos um
   await dentro de onMount(async) roda fora do owner e vira no-op,
   vazando listeners/interval no unmount.
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PlayerBar, playQueueUpcoming } from "./PlayerBar";
import { player, setPlayer, setQueue } from "../store/player";
import { currentSession, resetRadioSession } from "../store/radioSession";
import type { Track } from "../tauri";

const FAKE_TRACK = {
  id: "1", title: "Faixa", artist_name: "Artista", album_title: "Disco",
  album_cover_path: null, album_year: null, duration_ms: 1000, path: "/x", lrc_path: null,
} as Track;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setQueue([], 0); // limpa fila + proveniência entre testes
  setPlayer({ positionSecs: 0, durationSecs: 0 });
  resetRadioSession();
});

describe("PlayerBar lifecycle", () => {
  it("registra listeners/interval no mount", () => {
    const addWin = vi.spyOn(window, "addEventListener");
    const addDoc = vi.spyOn(document, "addEventListener");
    render(() => <PlayerBar />);
    const winEvents = addWin.mock.calls.map((c) => c[0]);
    expect(winEvents).toContain("search-play-track");
    expect(winEvents).toContain("beforeunload");
    expect(addDoc.mock.calls.map((c) => c[0])).toContain("visibilitychange");
  });

  it("unmount remove listeners e cancela o save interval", () => {
    const removeWin = vi.spyOn(window, "removeEventListener");
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(() => <PlayerBar />);
    unmount();
    const winEvents = removeWin.mock.calls.map((c) => c[0]);
    expect(winEvents).toContain("search-play-track");
    expect(winEvents).toContain("beforeunload");
    expect(removeDoc.mock.calls.map((c) => c[0])).toContain("visibilitychange");
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe("chip de origem da fila (pb-src)", () => {
  it("fila de station mostra 'station' com o nome no tooltip", () => {
    setQueue([FAKE_TRACK], 0, "curated", { kind: "station", name: "Neon" });
    const { container } = render(() => <PlayerBar />);
    const chip = container.querySelector(".pb-src")!;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("station");
    expect(chip.getAttribute("title")).toBe("Neon");
    expect(chip.getAttribute("data-kind")).toBe("station");
  });

  it("fila avulsa mostra 'solta'", () => {
    setQueue([FAKE_TRACK], 0);
    const { container } = render(() => <PlayerBar />);
    const chip = container.querySelector(".pb-src")!;
    expect(chip.textContent).toBe("solta");
    expect(chip.getAttribute("data-kind")).toBe("solta");
  });

  it("playlist e álbum têm labels próprios", () => {
    setQueue([FAKE_TRACK], 0, "curated", { kind: "playlist", name: "Rap" });
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector(".pb-src")!.textContent).toBe("playlist");
    cleanup();
    setQueue([FAKE_TRACK], 0, "curated", { kind: "album", name: "Disco" });
    const { container: c2 } = render(() => <PlayerBar />);
    expect(c2.querySelector(".pb-src")!.textContent).toBe("álbum");
  });

  it("sem faixa tocando não há chip", () => {
    setQueue([], 0);
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector(".pb-src")).toBeNull();
  });
});

// ── Fase 3 do session-awareness: skip manual reage a sessão de station ──
describe("skip manual reage a sessao de station (Fase 3)", () => {
  const T1 = {
    id: "1", title: "A", artist_name: null, album_title: null,
    album_cover_path: null, album_year: null, duration_ms: 180000, path: "/a", lrc_path: null,
  } as Track;
  const T2 = {
    id: "2", title: "B", artist_name: null, album_title: null,
    album_cover_path: null, album_year: null, duration_ms: 180000, path: "/b", lrc_path: null,
  } as Track;
  const T3 = {
    id: "3", title: "C", artist_name: null, album_title: null,
    album_cover_path: null, album_year: null, duration_ms: 180000, path: "/c", lrc_path: null,
  } as Track;

  it("botao next: skip cedo (5s de 180s) numa fila station registra rejeicao e trunca a cauda", async () => {
    setQueue([T1, T2, T3], 0, "curated", { kind: "station", name: "Neon" });
    setPlayer({ positionSecs: 5, durationSecs: 180 });
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-next")!);
    await Promise.resolve();
    expect(currentSession().skippedIds).toContain("1");
    expect(player.queueIndex).toBe(1);
    expect(player.currentTrack?.id).toBe("2");
    // T3 vinha depois do novo indice (T2) — cortado pelo truncamento.
    expect(player.queue.length).toBe(2);
  });

  it("botao next: skip tardio (170s de 180s) NAO registra rejeicao", async () => {
    setQueue([T1, T2, T3], 0, "curated", { kind: "station", name: "Neon" });
    setPlayer({ positionSecs: 170, durationSecs: 180 });
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-next")!);
    await Promise.resolve();
    expect(currentSession().skippedIds).toEqual([]);
    // Truncamento ainda ocorre (independente de early/late) — só o registro
    // de rejeição depende do threshold.
    expect(player.queue.length).toBe(2);
  });

  it("fila fora de station: next avanca normal, sem truncar nem registrar sessao", async () => {
    setQueue([T1, T2, T3], 0, "curated", { kind: "playlist", name: "Rap" });
    setPlayer({ positionSecs: 5, durationSecs: 180 });
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-next")!);
    await Promise.resolve();
    expect(currentSession().skippedIds).toEqual([]);
    expect(player.queueIndex).toBe(1);
    expect(player.queue.length).toBe(3); // sem truncamento fora de station
  });

  it("playQueueUpcoming pula direto pra posicao clicada (multi-skip) e reage como skip", async () => {
    setQueue([T1, T2, T3], 0, "curated", { kind: "station", name: "Neon" });
    setPlayer({ positionSecs: 5, durationSecs: 180 });
    render(() => <PlayerBar />);
    // Track vinda da própria store (mesma referência que TrackRowList
    // recebe via upcoming() = player.queue.slice(...) no uso real).
    await playQueueUpcoming(player.queue[2]);
    expect(player.queueIndex).toBe(2);
    expect(player.currentTrack?.id).toBe("3");
    expect(currentSession().skippedIds).toContain("1");
    expect(player.queue.length).toBe(3); // nada depois de T3 pra truncar
  });

  it("playQueueUpcoming em fila que nao e station troca a track sem mexer na sessao", async () => {
    setQueue([T1, T2, T3], 0, "curated", { kind: "playlist", name: "Rap" });
    setPlayer({ positionSecs: 5, durationSecs: 180 });
    render(() => <PlayerBar />);
    await playQueueUpcoming(player.queue[1]);
    expect(player.queueIndex).toBe(1);
    expect(player.currentTrack?.id).toBe("2");
    expect(currentSession().skippedIds).toEqual([]);
  });

  it("playQueueUpcoming com track fora da fila (referencia nao encontrada) so toca, sem mexer no indice", async () => {
    setQueue([T1, T2, T3], 0, "curated", { kind: "station", name: "Neon" });
    setPlayer({ positionSecs: 5, durationSecs: 180 });
    render(() => <PlayerBar />);
    const foreign: Track = { ...T2 }; // clone: mesmo id, referencia diferente
    await playQueueUpcoming(foreign);
    expect(player.queueIndex).toBe(0); // nao avancou — fallback seguro
    expect(currentSession().skippedIds).toEqual([]);
  });
});
