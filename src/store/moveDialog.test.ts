/* ============================================================
   store/moveDialog.test.ts — reação ao lib-tracks-moved (CMR-298):
   a fila passa aos ids/caminhos novos e, se a PRÓXIMA faixa foi
   movida, o preload gapless é refeito com o caminho novo (o engine
   consome o next pré-enfileirado sozinho no EOS).
   ============================================================ */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("../tauri", () => ({
  playerEnqueueNext: (path: string) => invoke("player_enqueue_next", { path }),
}));

import { applyMovedReport, libraryRevision } from "./moveDialog";
import { player, setPlayer } from "./player";
import type { MoveReport, Track } from "../tauri";

function track(id: string): Track {
  return {
    id, title: id, artist_name: "A", album_title: "B", album_cover_path: null, album_year: null,
    duration_ms: 1, path: `/m/Rap/A/B/${id}.flac`, lrc_path: null, genre_name: "Rap",
  };
}

function moved(ids: string[]): MoveReport {
  return {
    dest_playlist: "Nova", moved: ids.length, already_there: 0, failed: 0, pending: 0,
    items: ids.map((id) => ({
      track_id: id, new_track_id: `${id}n`, new_path: `/m/Nova/A/B/${id}.flac`, new_lrc_path: null,
      title: id, status: "moved" as const, detail: null,
    })),
  };
}

beforeEach(() => {
  invoke.mockClear();
  const q = [track("1"), track("2"), track("3")];
  setPlayer({ queue: q, queueIndex: 0, currentTrack: q[0], repeatMode: "off" });
});

describe("applyMovedReport", () => {
  it("faixa tocando e a próxima movidas: fila remapeada e preload com o caminho novo", () => {
    const rev = libraryRevision();
    applyMovedReport(moved(["1", "2"]));
    expect(player.currentTrack?.id).toBe("1n");
    expect(player.queue.map((t) => t.id)).toEqual(["1n", "2n", "3"]);
    expect(invoke).toHaveBeenCalledWith("player_enqueue_next", { path: "/m/Nova/A/B/2.flac" });
    expect(libraryRevision()).toBe(rev + 1);
  });

  it("próxima intacta: não mexe no preload", () => {
    applyMovedReport(moved(["3"]));
    expect(invoke).not.toHaveBeenCalled();
    expect(player.queue[2].path).toBe("/m/Nova/A/B/3.flac");
  });

  it("repeat one com a atual movida: preload aponta para o caminho novo dela", () => {
    setPlayer("repeatMode", "one");
    applyMovedReport(moved(["1"]));
    expect(invoke).toHaveBeenCalledWith("player_enqueue_next", { path: "/m/Nova/A/B/1.flac" });
  });
});
