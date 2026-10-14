/* Menu de contexto com seleção múltipla: age sobre as N faixas quando a
   linha clicada está selecionada; sobre linha não selecionada, só nela. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({
  libToggleLike: vi.fn(), libIsLiked: vi.fn().mockResolvedValue(false), setVolume: vi.fn(),
  playerEnqueueNext: vi.fn(),
}));
vi.mock("./PlayerBar", () => ({ playTrack: vi.fn() }));

import { TrackContextMenu } from "./TrackContextMenu";
import { TrackRowTable } from "./TrackRowTable";
import { closeTrackMenu } from "../store/contextMenu";
import { moveRequest, closeMoveDialog } from "../store/moveDialog";
import { resetSelection } from "../store/selection";
import type { Track } from "../tauri";

const mk = (id: string): Track => ({
  id, title: id, artist_name: null, album_title: null, album_cover_path: null, album_year: null,
  duration_ms: 1, path: `/m/${id}`, lrc_path: null,
});
const LIST = ["1", "2", "3"].map(mk);

afterEach(() => { cleanup(); closeTrackMenu(); closeMoveDialog(); resetSelection(); });

function setup() {
  return render(() => (
    <>
      <div class="tracks">
        {LIST.map((t, i) => <TrackRowTable track={t} index={i + 1} onClick={() => {}} contextList={LIST} />)}
      </div>
      <TrackContextMenu />
    </>
  ));
}

describe("menu de contexto com seleção", () => {
  it("linha selecionada: menu da seleção inteira e Mover recebe as N faixas", () => {
    setup();
    const rows = [...document.querySelectorAll(".tracks__row")] as HTMLElement[];
    fireEvent.click(rows[0], { ctrlKey: true });
    fireEvent.click(rows[2], { ctrlKey: true });
    fireEvent.contextMenu(rows[2]);
    const items = [...document.querySelectorAll(".track-ctx-menu__item")].map((b) => b.textContent);
    expect(items).toContain("Mover 2 faixas para playlist…");
    expect(items).not.toContain("Play");
    const move = [...document.querySelectorAll(".track-ctx-menu__item")].find((b) => b.textContent?.startsWith("Mover"))!;
    fireEvent.click(move);
    expect(moveRequest()!.tracks.map((t) => t.id)).toEqual(["1", "3"]);
  });

  it("linha não selecionada: menu normal, só a faixa", () => {
    setup();
    const rows = [...document.querySelectorAll(".tracks__row")] as HTMLElement[];
    fireEvent.click(rows[0], { ctrlKey: true });
    fireEvent.click(rows[2], { ctrlKey: true });
    fireEvent.contextMenu(rows[1]);
    const items = [...document.querySelectorAll(".track-ctx-menu__item")].map((b) => b.textContent);
    expect(items).toContain("Play");
    expect(items).toContain("Mover para playlist…");
  });
});
