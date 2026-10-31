/* Menu de contexto: recusa com escopo (B9) e aviso de falha do curtir (B5). */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({
  libToggleLike: vi.fn(), libIsLiked: vi.fn().mockResolvedValue(false), setVolume: vi.fn(),
  playerEnqueueNext: vi.fn(),
  libRadioRefuse: vi.fn(), libRadioReturn: vi.fn(), libRadioRestore: vi.fn(),
}));
vi.mock("./PlayerBar", () => ({ playTrack: vi.fn() }));

import { TrackContextMenu } from "./TrackContextMenu";
import { closeTrackMenu, openTrackMenu } from "../store/contextMenu";
import { setQueue } from "../store/player";
import { startRadioSession, resetRadioSession } from "../store/radioSession";
import { toast, dismissToast } from "../store/toast";
import { libRadioRefuse, libToggleLike } from "../tauri";
import type { Track } from "../tauri";

const T: Track = {
  id: "18400000000000000001", title: "Faixa", artist_name: "A", album_title: "B",
  album_cover_path: null, album_year: null, duration_ms: 1, path: "/m/1", lrc_path: null,
};
const empty = { never_at: null, off_stations: [], release_skips: 0, released_at: null };

afterEach(() => {
  closeTrackMenu(); cleanup(); document.body.innerHTML = "";
  setQueue([], 0); resetRadioSession(); dismissToast(); vi.clearAllMocks();
});

function open() {
  render(() => (
    <>
      <button id="row" onContextMenu={(e) => openTrackMenu(e, T)}>linha</button>
      <TrackContextMenu />
    </>
  ));
  fireEvent.contextMenu(document.getElementById("row")!, { clientX: 10, clientY: 10, detail: 1 });
}
const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.track-ctx-menu [role="menuitem"]')].find((b) => b.textContent === label);

describe("recusa com escopo no menu (B9)", () => {
  it("fora de station: só 'Nunca no rádio'", () => {
    setQueue([T], 0, "curated", { kind: "album" });
    open();
    expect(item("Nunca no rádio")).toBeTruthy();
    expect(item("Não tocar nesta station")).toBeUndefined();
  });

  it("faixa da station tocando: 'Não tocar nesta station' recusa com o id dela", async () => {
    startRadioSession("chuva");
    setQueue([T], 0, "curated", { kind: "station", name: "Chuva" });
    vi.mocked(libRadioRefuse).mockResolvedValue({ track_id: T.id, before: empty, after: { ...empty, off_stations: ["chuva"] } });
    open();
    fireEvent.click(item("Não tocar nesta station")!);
    expect(libRadioRefuse).toHaveBeenCalledWith(T.id, "station", "chuva");
    await vi.waitFor(() => expect(toast()?.message).toBe("“Faixa” não toca mais na station Chuva"));
    expect(toast()?.action?.label).toBe("Desfazer");
  });

  it("'Nunca no rádio' recusa no autoplay e nas stations", async () => {
    vi.mocked(libRadioRefuse).mockResolvedValue({ track_id: T.id, before: empty, after: { ...empty, never_at: 1 } });
    open();
    fireEvent.click(item("Nunca no rádio")!);
    expect(libRadioRefuse).toHaveBeenCalledWith(T.id, "never", undefined);
    await vi.waitFor(() => expect(toast()?.message).toBe("“Faixa” não toca mais no rádio"));
  });
});

describe("curtir que falha avisa (B5)", () => {
  it("mostra 'Não consegui curtir' com Tentar de novo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(libToggleLike).mockRejectedValue("qdrant fora");
    open();
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(item("Like")!);
    await vi.waitFor(() => expect(toast()?.message).toBe("Não consegui curtir “Faixa”."));
    expect(toast()?.action?.label).toBe("Tentar de novo");
  });
});
