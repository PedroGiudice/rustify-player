/* ============================================================
   Sidebar.test.tsx — Regressao do VU meter do mini now-playing.
   O <Index> deve atualizar height in-place nos MESMOS spans a
   cada tick de 220ms (o <For> antigo keiava por valor e recriava
   os 3 nodes por tick).
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { Sidebar } from "./Sidebar";
import { setPlayer } from "../store/player";
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

beforeEach(() => {
  vi.useFakeTimers();
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
