/* ============================================================
   MoveToPlaylistDialog.test.tsx — "Mover para playlist…" (CMR-298).
   Faixa solta move direto ao escolher; lote (álbum/artista) pede
   confirmação de uma linha; o resultado diz o que falhou e por quê.
   ============================================================ */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("../tauri", () => ({
  libListPlaylists: () => invoke("lib_list_playlists"),
  libMoveTracks: (trackIds: string[], destPlaylist: string) =>
    invoke("lib_move_tracks", { trackIds, destPlaylist }),
  playerEnqueueNext: (path: string) => invoke("player_enqueue_next", { path }),
}));

import { MoveToPlaylistDialog } from "./MoveToPlaylistDialog";
import { openMoveDialog, closeMoveDialog } from "../store/moveDialog";
import { resetSelection, selectedTracks, toggleTrack } from "../store/selection";
import type { Track } from "../tauri";

function track(id: string): Track {
  return {
    id, title: `Faixa ${id}`, artist_name: "A", album_title: "B", album_cover_path: null,
    album_year: null, duration_ms: 1, path: `/m/Rap/A/B/${id}.flac`, lrc_path: null, genre_name: "Rap",
  };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { trackIds: string[]; destPlaylist: string }) => {
    if (cmd === "lib_list_playlists") return ["Favoritas", "Rap"];
    const items = args!.trackIds.map((id) => ({
      track_id: id, new_track_id: `${id}0`, new_path: `/m/${args!.destPlaylist}/A/B/${id}.flac`, new_lrc_path: null,
      title: null, status: id === "3" ? "failed" : "moved", detail: id === "3" ? "já existe um arquivo com esse nome no destino" : null,
    }));
    const failed = items.filter((i) => i.status === "failed").length;
    return { dest_playlist: args!.destPlaylist, moved: items.length - failed, already_there: 0, failed, pending: 0, items };
  });
});

afterEach(() => {
  resetSelection();
  closeMoveDialog();
  cleanup();
});

const item = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".move-dlg__item")].find((b) => b.textContent?.includes(name))!;

describe("MoveToPlaylistDialog", () => {
  it("faixa solta: escolher o destino já move, e a pasta atual fica desabilitada", async () => {
    render(() => <MoveToPlaylistDialog />);
    openMoveDialog([track("1")]);
    await waitFor(() => expect(item("Favoritas")).toBeTruthy());
    expect(item("Rap").disabled).toBe(true);
    fireEvent.click(item("Favoritas"));
    await waitFor(() => expect(document.body.textContent).toContain("1 movida"));
    expect(invoke).toHaveBeenCalledWith("lib_move_tracks", { trackIds: ["1"], destPlaylist: "Favoritas" });
  });

  it("lote: confirma em uma linha e mostra a falha com o motivo", async () => {
    render(() => <MoveToPlaylistDialog />);
    openMoveDialog([track("1"), track("2"), track("3")], "Esú");
    await waitFor(() => expect(item("Favoritas")).toBeTruthy());
    fireEvent.click(item("Favoritas"));
    expect(document.body.textContent).toContain("Mover 3 faixas de Esú para Favoritas?");
    expect(invoke).not.toHaveBeenCalledWith("lib_move_tracks", expect.anything());
    const mover = [...document.querySelectorAll("button")].find((b) => b.textContent === "Mover")!;
    fireEvent.click(mover);
    await waitFor(() => expect(document.body.textContent).toContain("2 movidas · 1 falhou"));
    expect(document.body.textContent).toContain("já existe um arquivo com esse nome no destino");
  });

  it("nome digitado que não existe vira pasta nova", async () => {
    render(() => <MoveToPlaylistDialog />);
    openMoveDialog([track("1")]);
    await waitFor(() => expect(item("Favoritas")).toBeTruthy());
    const input = document.querySelector<HTMLInputElement>(".palette__input")!;
    fireEvent.input(input, { target: { value: "Treino: pesado" } });
    // Mostra o nome final (sanitizado) antes de mover.
    expect(item("Nova pasta").textContent).toContain("será criada como ~/Music/Treino_ pesado");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("lib_move_tracks", { trackIds: ["1"], destPlaylist: "Treino_ pesado" }),
    );
  });
});

describe("seleção múltipla depois de mover", () => {
  const LIST = ["1", "2", "3", "4"].map(track);
  const ids = () => selectedTracks().map((t) => t.id);
  const mark = (...which: string[]) => which.forEach((id) => toggleTrack(LIST, id));

  it("movidas saem da seleção; a que falhou continua marcada", async () => {
    mark("1", "2", "3");
    render(() => <MoveToPlaylistDialog />);
    openMoveDialog(selectedTracks());
    await waitFor(() => expect(item("Favoritas")).toBeTruthy());
    fireEvent.click(item("Favoritas"));
    fireEvent.click([...document.querySelectorAll("button")].find((b) => b.textContent === "Mover")!);
    await waitFor(() => expect(document.body.textContent).toContain("2 movidas · 1 falhou"));
    expect(ids()).toEqual(["3"]);
  });

  it("mover uma faixa NÃO selecionada (menu de faixa única) preserva as marcadas", async () => {
    mark("1", "2");
    render(() => <MoveToPlaylistDialog />);
    openMoveDialog([LIST[3]]);
    await waitFor(() => expect(item("Favoritas")).toBeTruthy());
    fireEvent.click(item("Favoritas"));
    await waitFor(() => expect(document.body.textContent).toContain("1 movida"));
    expect(ids()).toEqual(["1", "2"]);
  });

  it("pending não mexe na seleção", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { trackIds: string[]; destPlaylist: string }) => {
      if (cmd === "lib_list_playlists") return ["Favoritas", "Rap"];
      return {
        dest_playlist: args!.destPlaylist, moved: 0, already_there: 0, failed: 0, pending: args!.trackIds.length,
        items: args!.trackIds.map((id) => ({
          track_id: id, new_track_id: null, new_path: null, new_lrc_path: null,
          title: null, status: "pending", detail: null,
        })),
      };
    });
    mark("1", "2");
    render(() => <MoveToPlaylistDialog />);
    openMoveDialog(selectedTracks());
    await waitFor(() => expect(item("Favoritas")).toBeTruthy());
    fireEvent.click(item("Favoritas"));
    fireEvent.click([...document.querySelectorAll("button")].find((b) => b.textContent === "Mover")!);
    await waitFor(() => expect(document.body.textContent).toContain("2 ainda em andamento"));
    expect(ids()).toEqual(["1", "2"]);
  });

  it("já no destino sai da seleção", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { trackIds: string[]; destPlaylist: string }) => {
      if (cmd === "lib_list_playlists") return ["Favoritas", "Rap"];
      return {
        dest_playlist: args!.destPlaylist, moved: 0, already_there: 1, failed: 0, pending: 0,
        items: [{ track_id: args!.trackIds[0], new_track_id: null, new_path: null, new_lrc_path: null,
          title: null, status: "already_there", detail: null }],
      };
    });
    mark("1", "2");
    render(() => <MoveToPlaylistDialog />);
    openMoveDialog([LIST[0]]);
    await waitFor(() => expect(item("Favoritas")).toBeTruthy());
    fireEvent.click(item("Favoritas"));
    await waitFor(() => expect(document.body.textContent).toContain("já estava"));
    expect(ids()).toEqual(["2"]);
  });
});
