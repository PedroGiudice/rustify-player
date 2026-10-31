import { describe, it, expect } from "vitest";
import { listenedAlbums } from "./homeShelves";

const al = (title: string, artist: string) => ({ title, artist_name: artist, cover_path: null, year: null, track_count: 1 });
const tr = (album: string | null, artist: string) => ({ album_title: album, artist_name: artist });

const ALL = [al("Arrival", "ABBA"), al("Greatest Hits", "ABBA"), al("Greatest Hits", "Queen"), al("Jazz", "Queen"), al("Zulu", "Zeta")];

describe("listenedAlbums (B12)", () => {
  it("álbuns do que tocou por último vêm primeiro, depois os das mais tocadas, sem repetir", () => {
    const recent = [tr("Jazz", "Queen"), tr("Greatest Hits", "Queen"), tr("Jazz", "Queen")];
    const top = [tr("Greatest Hits", "Queen"), tr("Zulu", "Zeta")];
    const out = listenedAlbums(ALL, recent, top, 3);
    expect(out.map((a) => `${a.title}|${a.artist_name}`)).toEqual(["Jazz|Queen", "Greatest Hits|Queen", "Zulu|Zeta"]);
  });

  it("homônimos de outro artista não entram; faixa sem álbum é ignorada", () => {
    const out = listenedAlbums(ALL, [tr("Greatest Hits", "Queen"), tr(null, "X")], [], 2);
    expect(out.map((a) => `${a.title}|${a.artist_name}`)).toEqual(["Greatest Hits|Queen", "Arrival|ABBA"]);
  });

  it("sem escuta, completa com o acervo em ordem alfabética até o teto", () => {
    expect(listenedAlbums(ALL, [], [], 12)).toHaveLength(5);
    expect(listenedAlbums(ALL, [], [], 2).map((a) => a.title)).toEqual(["Arrival", "Greatest Hits"]);
  });
});
