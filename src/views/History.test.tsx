/* ============================================================
   History.test.tsx — Histórico agrupado por dia (B13).
   ============================================================ */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import type { Track } from "../tauri";

const { h } = vi.hoisted(() => ({ h: { history: [] as Track[] } }));

vi.mock("../tauri", () => ({ libListHistory: vi.fn(async () => h.history) }));
vi.mock("../store/player", () => ({ setQueue: vi.fn(), player: { currentTrack: null } }));
vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("../router", () => ({ navigate: vi.fn() }));
vi.mock("../components/TrackRowList", () => ({
  TrackRowList: (p: { track: Track; whenText?: string }) => <div class="row-mock" data-when={p.whenText}>{p.track.title}</div>,
}));

import History from "./History";

const NOW = new Date(2026, 9, 31, 15, 0);
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm).getTime() / 1000;
const t = (id: string, last_played: number, play_count = 1): Track => ({
  id, title: `T${id}`, artist_name: "A", album_title: null, album_cover_path: null, album_year: null,
  duration_ms: 1, path: `/${id}`, lrc_path: null, last_played, play_count,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Histórico por dia (B13)", () => {
  it("um cabeçalho por dia com a contagem; a linha diz a hora e quantas vezes tocou", async () => {
    h.history = [t("1", at(31, 14, 32), 7), t("2", at(31, 9, 5)), t("3", at(30, 22, 10))];
    const { container, findByText } = render(() => <History />);
    await findByText("T1");
    const days = Array.from(container.querySelectorAll(".hist-day"));
    expect(days.map((d) => d.querySelector(".hist-day__title")!.textContent)).toEqual(["Hoje · 2 faixas", "Ontem · 1 faixa"]);
    expect(Array.from(days[0].querySelectorAll(".row-mock")).map((r) => r.getAttribute("data-when"))).toEqual(["14:32 · 7 vezes", "09:05"]);
  });
});
