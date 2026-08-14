import { describe, expect, it } from "vitest";
import {
  commonRoot,
  deriveAlbums,
  deriveArtists,
  fmtDuration,
  fmtTotal,
  normalize,
  originLabel,
  originSrc,
  searchTracks,
  shuffled,
  toneFor,
  tracksOfAlbum,
  tracksOfArtist,
} from "./derive";
import type { Track } from "./types";

function track(p: Partial<Track> & { id: string }): Track {
  return {
    title: "t",
    artist_name: null,
    album_title: null,
    album_cover_path: null,
    album_year: null,
    duration_ms: 0,
    path: "/storage/emulated/0/Music/x.flac",
    lrc_path: null,
    track_number: null,
    genre_name: null,
    dominant_color: null,
    ...p,
  };
}

const LIB: Track[] = [
  track({ id: "1", title: "Neighbors", artist_name: "J. Cole", album_title: "4 Your Eyez Only", album_year: 2016, track_number: 3, duration_ms: 217_000, path: "/storage/emulated/0/Music/Rap/J. Cole/4YEO/03.flac" }),
  track({ id: "2", title: "Ville Mentality", artist_name: "J. Cole", album_title: "4 Your Eyez Only", album_year: 2016, track_number: 1, duration_ms: 140_000, album_cover_path: "/cover.jpg", path: "/storage/emulated/0/Music/Rap/J. Cole/4YEO/01.flac" }),
  track({ id: "3", title: "Come Down", artist_name: "Anderson .Paak", album_title: "Malibu", album_year: 2016, duration_ms: 200_000, path: "/storage/emulated/0/Music/Soul/Paak/Malibu/05.flac" }),
  track({ id: "4", title: "Sem álbum", artist_name: "Anderson .Paak", duration_ms: 60_000, path: "/storage/emulated/0/Music/Soul/solta.flac" }),
];

describe("formatação", () => {
  it("converte duration_ms em M:SS", () => {
    expect(fmtDuration(217_000)).toBe("3:37");
    expect(fmtDuration(59_999)).toBe("0:59");
    expect(fmtDuration(0)).toBe("0:00");
  });

  it("não explode com duração ausente", () => {
    expect(fmtDuration(null)).toBe("0:00");
    expect(fmtDuration(undefined)).toBe("0:00");
    expect(fmtDuration(-5)).toBe("0:00");
  });

  it("soma durações em horas e minutos", () => {
    expect(fmtTotal([600_000, 600_000])).toBe("20 min");
    expect(fmtTotal([3_600_000, 600_000])).toBe("1 h 10 min");
  });
});

describe("normalize", () => {
  it("tira acento e caixa", () => {
    expect(normalize("Água Viva")).toBe("agua viva");
    expect(normalize("JPEGMAFIA")).toBe("jpegmafia");
  });

  it("aceita nulo", () => {
    expect(normalize(null)).toBe("");
    expect(normalize(undefined)).toBe("");
  });
});

describe("derivação de álbuns e artistas", () => {
  it("agrupa álbuns por artista + título e ignora faixa sem álbum", () => {
    const albums = deriveAlbums(LIB);
    expect(albums).toHaveLength(2);
    const cole = albums.find((a) => a.title === "4 Your Eyez Only")!;
    expect(cole.track_count).toBe(2);
    expect(cole.artist).toBe("J. Cole");
    expect(cole.year).toBe(2016);
    // a capa vem da primeira faixa que tiver uma
    expect(cole.cover).toBe("/cover.jpg");
  });

  it("conta álbuns distintos por artista", () => {
    const artists = deriveArtists(LIB);
    expect(artists.map((a) => a.name)).toEqual(["Anderson .Paak", "J. Cole"]);
    expect(artists.find((a) => a.name === "J. Cole")!.track_count).toBe(2);
    expect(artists.find((a) => a.name === "J. Cole")!.album_count).toBe(1);
    // a faixa sem álbum não inventa um álbum a mais
    expect(artists.find((a) => a.name === "Anderson .Paak")!.album_count).toBe(1);
  });

  it("ordena as faixas do álbum por track_number", () => {
    const key = deriveAlbums(LIB).find((a) => a.title === "4 Your Eyez Only")!.key;
    expect(tracksOfAlbum(LIB, key).map((t) => t.id)).toEqual(["2", "1"]);
  });

  it("filtra faixas por artista sem depender de caixa/acento", () => {
    expect(tracksOfArtist(LIB, "anderson .paak").map((t) => t.id)).toEqual(["3", "4"]);
  });
});

describe("busca client-side", () => {
  it("casa título, artista e álbum", () => {
    expect(searchTracks(LIB, "neighbors").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(LIB, "j. cole").map((t) => t.id)).toEqual(["1", "2"]);
    expect(searchTracks(LIB, "malibu").map((t) => t.id)).toEqual(["3"]);
  });

  it("query vazia não devolve o acervo inteiro", () => {
    expect(searchTracks(LIB, "")).toEqual([]);
    expect(searchTracks(LIB, "   ")).toEqual([]);
  });

  it("respeita o limite", () => {
    expect(searchTracks(LIB, "a", 1)).toHaveLength(1);
  });
});

describe("origins", () => {
  it("rotula cada origin do contrato", () => {
    expect(originLabel("playlist")).toBe("playlist");
    expect(originLabel("album_seq")).toBe("álbum");
    expect(originLabel("shuffle")).toBe("shuffle");
    expect(originLabel("manual")).toBe("solta");
  });

  it("só playlist e álbum ganham cor no badge", () => {
    expect(originSrc("playlist")).toBe("playlist");
    expect(originSrc("album_seq")).toBe("album");
    expect(originSrc("manual")).toBeUndefined();
    expect(originSrc("shuffle")).toBeUndefined();
  });
});

describe("utilitários", () => {
  it("commonRoot acha a raiz do acervo", () => {
    expect(commonRoot(LIB.map((t) => t.path))).toBe("/storage/emulated/0/Music");
    expect(commonRoot([])).toBeNull();
  });

  it("shuffled preserva o conjunto e não muta a entrada", () => {
    const input = ["a", "b", "c", "d"];
    const out = shuffled(input);
    expect(out).toHaveLength(4);
    expect([...out].sort()).toEqual([...input].sort());
    expect(input).toEqual(["a", "b", "c", "d"]);
  });

  it("toneFor é estável para a mesma chave", () => {
    expect(toneFor("Rap")).toBe(toneFor("Rap"));
    expect(toneFor(3)).toBe(toneFor(11));
  });
});
