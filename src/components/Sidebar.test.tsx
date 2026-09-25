/* ============================================================
   Sidebar.test.tsx — Regressao do VU meter do mini now-playing.
   O <Index> deve atualizar height in-place nos MESMOS spans a
   cada tick de 220ms (o <For> antigo keiava por valor e recriava
   os 3 nodes por tick).

   Modo sidebar=icons (auditoria de UI 25/09, shell-22): o rótulo
   some da tela, então cada item precisa de tooltip. O nome
   acessível continua vindo do texto do rótulo (o CSS o esconde só
   visualmente).
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return {
    ...actual,
    slskJobs: vi.fn(async () => []),
    onSlskJobs: vi.fn(async (_cb: (jobs: import("../tauri").DownloadJob[]) => void) => () => {}),
  };
});

import * as tauriApi from "../tauri";
import { Sidebar } from "./Sidebar";
import { setPlayer } from "../store/player";
import { bootCrateStore, __resetForTests } from "../store/crate";
import { updateTweak } from "../store/tweaks";
import type { Track, DownloadJob } from "../tauri";

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

beforeEach(() => {
  vi.useFakeTimers();
  __resetForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setPlayer({ currentTrack: null, isPlaying: false });
});

describe("Sidebar VU meter", () => {
  it("mantem os mesmos spans entre ticks (Index atualiza in-place)", () => {
    setPlayer({ currentTrack: TRACK, isPlaying: true });
    const { container } = render(() => <Sidebar />);

    const before = Array.from(container.querySelectorAll(".np-mini__vu span"));
    expect(before.length).toBe(3);

    // Dois ticks do interval de 220ms — heights mudam, nodes nao.
    vi.advanceTimersByTime(220 * 2);

    const after = Array.from(container.querySelectorAll(".np-mini__vu span"));
    expect(after.length).toBe(3);
    after.forEach((el, i) => expect(el).toBe(before[i]));
    // Height continua sendo aplicada por style inline (px).
    after.forEach((el) => expect((el as HTMLElement).style.height).toMatch(/px$/));
  });

  it("para o interval no cleanup", () => {
    setPlayer({ currentTrack: TRACK, isPlaying: true });
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(() => <Sidebar />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});

function job(id: string, kind: DownloadJob["state"]["kind"]): DownloadJob {
  return {
    job_id: id,
    username: "peer",
    remote_filename: "Artist - Title.flac",
    display: "Artist - Title",
    dest_playlist: "Rap & Hip-Hop",
    state: { kind } as DownloadJob["state"],
    size: 1000,
    quality_label: "FLAC 16/44",
    alternates: [],
    tried_source_ids: [],
    created_at: 0,
  };
}

describe("Sidebar — badge do Crate (jobs ativos)", () => {
  it("some quando activeCount é 0", async () => {
    const { container } = render(() => <Sidebar />);
    const crateItem = Array.from(container.querySelectorAll(".nav-item")).find((el) =>
      el.textContent?.includes("Crate"),
    )!;
    await bootCrateStore();
    expect(crateItem.querySelector(".nav-item__badge")).toBeFalsy();
  });

  it("mostra a contagem de jobs não-terminais e atualiza com o evento slsk-jobs", async () => {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const { container } = render(() => <Sidebar />);
    await bootCrateStore();
    expect(emit).not.toBeNull();

    emit!([job("a", "downloading"), job("b", "queued"), job("c", "ready")]);

    const crateItem = Array.from(container.querySelectorAll(".nav-item")).find((el) =>
      el.textContent?.includes("Crate"),
    )!;
    expect(crateItem.querySelector(".nav-item__badge")?.textContent).toBe("2");
  });
});

describe("Sidebar — modo icons (shell-22)", () => {
  afterEach(() => updateTweak("sidebar", "labels"));

  it("no modo icons todo item de navegação tem tooltip com o rótulo", () => {
    updateTweak("sidebar", "icons");
    const { container } = render(() => <Sidebar />);
    const items = Array.from(container.querySelectorAll<HTMLElement>(".nav-item"));
    expect(items.length).toBeGreaterThan(0);
    for (const el of items) {
      const label = el.querySelector("span:not(.nav-item__kbd):not(.nav-item__badge)")?.textContent;
      expect(label).toBeTruthy();
      // O Tweaks já tinha title próprio ("Tweaks (fonts, zoom)").
      expect(el.getAttribute("title")?.startsWith(label!)).toBe(true);
    }
  });

  it("no modo labels o rótulo está visível e não há tooltip redundante", () => {
    updateTweak("sidebar", "labels");
    const { container } = render(() => <Sidebar />);
    const crate = Array.from(container.querySelectorAll<HTMLElement>(".nav-item"))
      .find((el) => el.textContent?.includes("Crate"))!;
    expect(crate.getAttribute("title")).toBeNull();
  });
});
