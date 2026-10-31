/* ============================================================
   loadErrors.test.tsx — falha de carga é ESTADO DE ERRO, com
   "tentar de novo" (mobile-12, mobile-13, mobile-14).

   - Home: o timeout de IPC no boot frio aparecia como "Acervo
     vazio" e mandava ressincronizar o celular;
   - Álbum/Artista: antes do acervo carregar (ou com a carga em
     falha) diziam "não encontrado";
   - Pasta: resource em erro relançava a exceção na leitura e
     derrubava a renderização da tela.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import type { Track } from "../types";

const st = vi.hoisted(() => ({
  ready: true,
  error: null as string | null,
  reloadLibrary: vi.fn(),
  listFolderTracks: vi.fn(),
  rescan: vi.fn(),
}));

vi.mock("../nav", () => ({ navigate: vi.fn(), back: vi.fn() }));

vi.mock("../ipc", () => ({
  assetSrc: () => null,
  libListFolderTracks: st.listFolderTracks,
}));

vi.mock("../store", () => ({
  albums: () => [],
  artists: () => [],
  folders: () => [],
  tracks: () => [],
  favorites: () => [],
  recents: () => [],
  stations: () => [],
  libReady: () => st.ready,
  libError: () => st.error,
  reloadLibrary: st.reloadLibrary,
  pb: { trackId: null },
  playTrackFrom: vi.fn(),
  playAlbum: vi.fn(),
  playFolder: vi.fn(),
  playFolderFrom: vi.fn(),
  shuffleAll: vi.fn(),
  shuffleFolder: vi.fn(),
  shuffleList: vi.fn(),
  rescan: st.rescan,
  rescanning: () => false,
}));

import { Home } from "./Home";
import { Album } from "./Album";
import { Artist } from "./Artist";
import { Folder } from "./Folder";

afterEach(() => {
  cleanup();
  st.ready = true;
  st.error = null;
  vi.clearAllMocks();
});

describe("Home (mobile-12)", () => {
  it("carga em falha mostra o erro e tentar de novo — nunca 'Acervo vazio'", () => {
    st.error = "loadLibrary: timeout 6000ms";
    const r = render(() => <Home />);
    expect(r.queryByText("Acervo vazio")).toBeNull();
    // O motivo técnico sai do texto (o dono não interpreta) e fica no title.
    expect(r.queryByText(/timeout 6000ms/)).toBeNull();
    expect(r.getByText("Toque em Tentar de novo.").getAttribute("title")).toContain("timeout 6000ms");
    fireEvent.click(r.getByRole("button", { name: "Tentar de novo" }));
    expect(st.reloadLibrary).toHaveBeenCalledTimes(1);
  });

  it("carga ok e acervo de fato vazio continua 'Acervo vazio'", () => {
    const r = render(() => <Home />);
    expect(r.getByText("Acervo vazio")).toBeTruthy();
  });

  // A64: o vazio mandava "use Re-scan em Settings" sem o botão.
  it("acervo vazio oferece Reescanear ali mesmo", () => {
    const r = render(() => <Home />);
    fireEvent.click(r.getByRole("button", { name: "Reescanear" }));
    expect(st.rescan).toHaveBeenCalledTimes(1);
  });
});

describe("Álbum e Artista (mobile-14)", () => {
  it("acervo ainda carregando: não diz 'não encontrado'", () => {
    st.ready = false;
    const a = render(() => <Album param="x" />);
    expect(a.queryByText("Álbum não encontrado")).toBeNull();
    expect(a.getByText("Carregando biblioteca…")).toBeTruthy();
    cleanup();
    const b = render(() => <Artist param="y" />);
    expect(b.queryByText("Artista não encontrado")).toBeNull();
  });

  it("acervo em falha: erro com tentar de novo, não 'não encontrado'", () => {
    st.error = "bridge fria";
    const a = render(() => <Album param="x" />);
    expect(a.queryByText("Álbum não encontrado")).toBeNull();
    fireEvent.click(a.getByRole("button", { name: "Tentar de novo" }));
    expect(st.reloadLibrary).toHaveBeenCalledTimes(1);
  });

  it("acervo carregado e álbum ausente: 'não encontrado' é verdade", () => {
    const a = render(() => <Album param="x" />);
    expect(a.getByText("Álbum não encontrado")).toBeTruthy();
  });
});

describe("Pasta (mobile-13)", () => {
  const t = {
    id: "9",
    title: "Faixa da pasta",
    artist_name: "Fulano",
    album_title: null,
    album_cover_path: null,
    album_year: null,
    duration_ms: 1000,
    path: "/m/9.opus",
    lrc_path: null,
    track_number: null,
    genre_name: null,
    dominant_color: null,
    liked_at: null,
    like_updated_at: null,
  } as Track;

  it("IPC da pasta falha: estado de erro, e tentar de novo recarrega", async () => {
    st.listFolderTracks.mockRejectedValueOnce(new Error("pasta renomeada"));
    st.listFolderTracks.mockResolvedValueOnce([t]);
    const r = render(() => <Folder param="Rap" />);
    expect(await r.findByText(/pasta renomeada/)).toBeTruthy();
    expect(r.queryByText("Pasta vazia")).toBeNull();
    fireEvent.click(r.getByRole("button", { name: "Tentar de novo" }));
    expect(await r.findByText("Faixa da pasta")).toBeTruthy();
    expect(st.listFolderTracks).toHaveBeenCalledTimes(2);
  });
});
