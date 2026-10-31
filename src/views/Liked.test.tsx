/* ============================================================
   Liked.test.tsx — aba Curtidas da Library (B8).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import type { Track } from "../tauri";
import type { Loaded } from "../lib/loaded";

const { h } = vi.hoisted(() => ({
  h: { setQueue: vi.fn(), playTrack: vi.fn() },
}));

vi.mock("../store/player", () => ({
  setQueue: (...a: any[]) => h.setQueue(...a),
  player: { currentTrack: null },
}));
vi.mock("../components/PlayerBar", () => ({ playTrack: (...a: any[]) => h.playTrack(...a) }));
vi.mock("../components/TrackRowList", () => ({
  TrackRowList: (p: { track: Track; whenText?: string; onClick: () => void }) => (
    <div class="row-mock" data-when={p.whenText} onClick={p.onClick}>{p.track.title}</div>
  ),
}));
vi.mock("../lib/format", () => ({ relTime: (ts: number) => `ts${ts}` }));

import Liked from "./Liked";

const t = (id: string, liked_at: number): Track => ({
  id, title: `T${id}`, artist_name: "A", album_title: null, album_cover_path: null, album_year: null,
  duration_ms: 1000, path: `/${id}.flac`, lrc_path: null, liked_at,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Curtidas (B8)", () => {
  it("lista as curtidas na ordem que chegam (a mais recente primeiro) com a hora da curtida", () => {
    const list: Loaded<Track[]> = { ok: true, data: [t("1", 300), t("2", 200)] };
    const { container } = render(() => <Liked list={() => list} onRetry={() => {}} />);
    const rows = Array.from(container.querySelectorAll(".row-mock"));
    expect(rows.map((r) => r.textContent)).toEqual(["T1", "T2"]);
    expect(rows[0].getAttribute("data-when")).toBe("ts300");
    expect(container.textContent).toContain("2 curtidas");
  });

  it("Tocar curtidas embaralha todas numa fila aberta (o rádio segue depois)", () => {
    const data = [t("1", 3), t("2", 2), t("3", 1)];
    const { getByRole } = render(() => <Liked list={() => ({ ok: true, data })} onRetry={() => {}} />);
    fireEvent.click(getByRole("button", { name: "Tocar curtidas" }));
    const [queue, idx, scope, source] = h.setQueue.mock.calls[0];
    expect(queue.map((x: Track) => x.id).sort()).toEqual(["1", "2", "3"]);
    expect([idx, scope, source]).toEqual([0, "open", null]);
    expect(h.playTrack).toHaveBeenCalledWith(queue[0]);
  });

  it("clicar numa linha toca a partir dela", () => {
    const data = [t("1", 3), t("2", 2)];
    const { getByText } = render(() => <Liked list={() => ({ ok: true, data })} onRetry={() => {}} />);
    fireEvent.click(getByText("T2"));
    expect(h.setQueue).toHaveBeenCalledWith(data, 1, "open");
    expect(h.playTrack).toHaveBeenCalledWith(data[1]);
  });

  it("sem curtida diz como curtir; falha mostra erro com Tentar de novo", () => {
    const { getByText, unmount } = render(() => <Liked list={() => ({ ok: true, data: [] })} onRetry={() => {}} />);
    expect(getByText("Nenhuma faixa curtida ainda.")).toBeTruthy();
    unmount();
    const retry = vi.fn();
    const r = render(() => <Liked list={() => ({ ok: false, error: "fora" })} onRetry={retry} />);
    fireEvent.click(r.getByRole("button", { name: "Tentar de novo" }));
    expect(retry).toHaveBeenCalled();
  });
});
