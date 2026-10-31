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
const { mockTracks, mockAlbums, mockSetQueue, mockPlayTrack, mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
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
  libGetTracks: vi.fn().mockResolvedValue(mockTracks),
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
  navigate: (...args: any[]) => mockNavigate(...args),
  route: () => ({ path: "/albums" }),
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play", refresh: "refresh", albums: "albums", alert: "alert" },
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

    // Título E artista: dois álbuns homônimos não viram uma fila só (A19).
    expect(tauri.libGetTracks).toHaveBeenCalledWith({ album: "Album X", artist: "Artist", limit: 200 });
    expect(mockSetQueue).toHaveBeenCalledWith(mockTracks, 0, "curated", { kind: "album", name: "Album X" });
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

// ds-2: o botão de tocar do card era só um ícone, sem nome acessível.
describe("Albums — nome acessível do card__play (ds-2)", () => {
  it("o card__play diz qual álbum toca", async () => {
    const { container } = render(() => <Albums />);
    await vi.waitFor(() => expect(container.querySelector(".card__play")).toBeTruthy());
    expect(container.querySelector(".card__play")!.getAttribute("aria-label")).toBe("Tocar Album X");
  });
});

// B1: o card abre o álbum; só o play do hover toca.
describe("Albums — o card abre a página do álbum (B1)", () => {
  it("clicar no nome navega para o álbum com o artista e não toca nada", async () => {
    const { container } = render(() => <Albums />);
    await vi.waitFor(() => expect(container.querySelector(".card__open")).toBeTruthy());
    const open = container.querySelector(".card__open") as HTMLButtonElement;
    expect(open.tagName).toBe("BUTTON");
    expect(open.textContent).toBe("Album X");
    fireEvent.click(open);
    expect(mockNavigate).toHaveBeenCalledWith("/album/Album%20X?artista=Artist");
    expect(mockSetQueue).not.toHaveBeenCalled();
    expect(mockPlayTrack).not.toHaveBeenCalled();
  });

  it("o card em si não é mais um alvo de clique que toca", async () => {
    const { container } = render(() => <Albums />);
    await vi.waitFor(() => expect(container.querySelector(".card")).toBeTruthy());
    fireEvent.click(container.querySelector(".card__meta")!);
    expect(mockSetQueue).not.toHaveBeenCalled();
  });
});

// A7: falha de leitura não se passa por acervo vazio.
describe("Albums — carregando, erro e vazio (A7)", () => {
  it("falha do índice mostra o erro com Tentar de novo, que refaz a leitura", async () => {
    vi.mocked(tauri.libGetAlbums).mockRejectedValueOnce(new Error("qdrant fora"));
    const { findByRole, container } = render(() => <Albums />);
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Não consegui ler o acervo agora.");
    expect(container.querySelector(".card")).toBeNull();
    fireEvent.click(alert.querySelector("button")!);
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(1));
  });

  it("acervo sem álbuns diz isso, sem fingir erro", async () => {
    vi.mocked(tauri.libGetAlbums).mockResolvedValueOnce([]);
    const { findByText, queryByRole } = render(() => <Albums />);
    expect(await findByText("Nenhum álbum no acervo.")).toBeTruthy();
    expect(queryByRole("alert")).toBeNull();
  });

  it("enquanto carrega, diz que está carregando", () => {
    vi.mocked(tauri.libGetAlbums).mockReturnValueOnce(new Promise(() => {}));
    const { getByRole } = render(() => <Albums />);
    expect(getByRole("status").textContent).toContain("Carregando o acervo…");
  });
});
