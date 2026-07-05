/* ============================================================
   TrackRowList.test.tsx — Contrato de classes da row.
   Um unico classList rege as duas familias (.row / .qrow) e os
   modifiers de current — antes havia mistura de `class` dinamico
   com classList no mesmo elemento (footgun do Solid).
   ============================================================ */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { TrackRowList } from "./TrackRowList";
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

afterEach(() => {
  cleanup();
  setPlayer({ currentTrack: null });
});

const row = (container: HTMLElement) =>
  container.querySelector('[role="row"]') as HTMLElement;

describe("TrackRowList classes", () => {
  it("default: .row + .is-current quando a track e a corrente", () => {
    setPlayer({ currentTrack: TRACK });
    const { container } = render(() => <TrackRowList track={TRACK} onClick={() => {}} />);
    const el = row(container);
    expect(el.classList.contains("row")).toBe(true);
    expect(el.classList.contains("is-current")).toBe(true);
    expect(el.classList.contains("qrow")).toBe(false);
    expect(el.classList.contains("qrow--current")).toBe(false);
  });

  it("compact: .qrow + .qrow--current quando corrente; sem classes da familia B", () => {
    setPlayer({ currentTrack: TRACK });
    const { container } = render(() => (
      <TrackRowList track={TRACK} onClick={() => {}} size="compact" />
    ));
    const el = row(container);
    expect(el.classList.contains("qrow")).toBe(true);
    expect(el.classList.contains("qrow--current")).toBe(true);
    expect(el.classList.contains("row")).toBe(false);
    expect(el.classList.contains("is-current")).toBe(false);
  });

  it("modifiers de current togglam in-place quando o player muda", () => {
    setPlayer({ currentTrack: null });
    const { container } = render(() => (
      <TrackRowList track={TRACK} onClick={() => {}} size="compact" />
    ));
    const el = row(container);
    expect(el.classList.contains("qrow--current")).toBe(false);
    setPlayer({ currentTrack: TRACK });
    expect(el.classList.contains("qrow")).toBe(true);
    expect(el.classList.contains("qrow--current")).toBe(true);
    setPlayer({ currentTrack: null });
    expect(el.classList.contains("qrow")).toBe(true);
    expect(el.classList.contains("qrow--current")).toBe(false);
  });
});
