/* ============================================================
   Albums.test.tsx — Testa que o botao card__play monta a fila
   com as tracks do album e toca a primeira.

   Nota: o CoverArt e renderizado REAL (nao mockado). O botao
   .card__play e passado como children do CoverArt; o fix em
   b57d5ec fez o CoverArt renderizar {props.children}. Mockar o
   CoverArt mascararia uma regressao futura desse fix.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

// vi.mock factories sao hoisted pro topo do arquivo. Variaveis usadas
// dentro delas precisam vir de vi.hoisted, senao quebra com
// "error when mocking a module".
const { mockTracks, mockAlbums, mockSetQueue, mockPlayTrack } = vi.hoisted(() => ({
  mockTracks: [
    { id: "1", title: "Track A", artist_name: "Artist", album_title: "Album X", album_cover_path: null, album_year: 2024, duration_ms: 180000, path: "/a.flac", lrc_path: null },
    { id: "2", title: "Track B", artist_name: "Artist", album_title: "Album X", album_cover_path: null, album_year: 2024, duration_ms: 200000, path: "/b.flac", lrc_path: null },
  ],
  mockAlbums: [
    { title: "Album X", artist_name: "Artist", cover_path: null, year: 2024, track_count: 2 },
  ],
  mockSetQueue: vi.fn(),
  mockPlayTrack: vi.fn(),
}));

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libGetAlbums: vi.fn().mockResolvedValue(mockAlbums),
  libGetTracksByAlbum: vi.fn().mockResolvedValue(mockTracks),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/player", () => ({
  setQueue: (...args: any[]) => mockSetQueue(...args),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../components/PlayerBar", () => ({
  playTrack: (...args: any[]) => mockPlayTrack(...args),
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
  route: () => ({ path: "/albums" }),
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play" },
}));

beforeEach(() => {
  mockSetQueue.mockClear();
  mockPlayTrack.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Albums from "./Albums";
import * as tauri from "../tauri";

describe("Albums — botao card__play", () => {
  it("clicar no card__play chama setQueue com todas as tracks e toca a primeira", async () => {
    const { container } = render(() => <Albums />);

    // Aguardar o resource resolver — o CoverArt real renderiza o
    // .card__play como children. vi.waitFor so re-tenta se o callback
    // LANCAR; por isso usamos expect dentro dele (retornar false nao basta).
    await vi.waitFor(() => {
      expect(container.querySelector(".card__play")).toBeTruthy();
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);

    await vi.waitFor(() => mockSetQueue.mock.calls.length > 0);

    expect(tauri.libGetTracksByAlbum).toHaveBeenCalledWith("Album X");
    expect(mockSetQueue).toHaveBeenCalledWith(mockTracks, 0, "curated");
    expect(mockPlayTrack).toHaveBeenCalledWith(mockTracks[0]);
  });

  it("e.stopPropagation() impede que o click borbulhe (delegacao Solid) ate um ancestral", async () => {
    // Solid usa event delegation: handlers onClick sao escutados no
    // document root, nao anexados nativamente. Um listener nativo no
    // div.card NAO mediria o stopPropagation correto. Medimos com um
    // ancestral cujo onClick e tambem delegado pelo Solid: com o fix
    // (stopPropagation no botao), o ancestral recebe 0 cliques; sem o
    // fix, o evento delegado borbulha ate ele (1 clique).
    const ancestorSpy = vi.fn();
    const { container } = render(() => (
      <div onClick={ancestorSpy}>
        <Albums />
      </div>
    ));

    await vi.waitFor(() => {
      expect(container.querySelector(".card__play")).toBeTruthy();
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    expect(ancestorSpy).not.toHaveBeenCalled();
  });
});
