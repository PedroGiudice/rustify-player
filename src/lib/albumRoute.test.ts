import { describe, it, expect } from "vitest";
import { albumHref, parseAlbumParam } from "./albumRoute";

describe("rota do álbum leva o artista (homônimos não se misturam)", () => {
  it("com artista", () => {
    expect(albumHref("Greatest Hits", "Queen")).toBe("/album/Greatest%20Hits?artista=Queen");
  });
  it("sem artista", () => {
    expect(albumHref("Greatest Hits", null)).toBe("/album/Greatest%20Hits");
  });
  it("título com ? e & não confunde o parâmetro", () => {
    const href = albumHref("Why? & How", "A&B");
    const param = href.slice("/album/".length);
    expect(parseAlbumParam(param)).toEqual({ title: "Why? & How", artist: "A&B" });
  });
  it("rota antiga, só o título", () => {
    expect(parseAlbumParam(encodeURIComponent("Love Deluxe"))).toEqual({ title: "Love Deluxe", artist: null });
  });
  it("sem parâmetro", () => {
    expect(parseAlbumParam(null)).toEqual({ title: null, artist: null });
  });
});
