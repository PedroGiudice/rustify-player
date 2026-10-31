/* Escuta viva e qualidade no cabeçalho (B11). */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({ libListenStats: vi.fn() }));

import { ListenFacts } from "./ListenFacts";
import { libListenStats } from "../tauri";
import type { ListenStats } from "../tauri";

const base: ListenStats = {
  familiarity_ready: true, tracks: 14, listened_tracks: 9, full_listens: 12, plays: 20,
  last_played_at: Math.floor(Date.now() / 1000) - 3 * 86_400, last_ended_at: null,
  quality: { sem_corte: 12, provavel_lossy: 0, lossy: 1, hires_de_cd: 0, unmeasured: 1, lowest_cutoff_hz: 16_075 },
  per_track: [],
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ListenFacts (B11)", () => {
  it("álbum: pede artista E álbum, mostra escuta e qualidade com o ponto do selo", async () => {
    vi.mocked(libListenStats).mockResolvedValue(base);
    const { container } = render(() => <ListenFacts query={{ artist: "Kendrick Lamar", album: "DAMN." }} />);
    await vi.waitFor(() => expect(container.querySelector(".lib-hero__facts")).toBeTruthy());
    expect(libListenStats).toHaveBeenCalledWith({ artist: "Kendrick Lamar", album: "DAMN." });
    const text = container.querySelector(".lib-hero__facts")!.textContent;
    expect(text).toContain("ouvido até o fim 12 vezes · última há 3 dias");
    const tones = [...container.querySelectorAll(".lib-hero__q")].map((e) => [e.getAttribute("data-tone"), e.textContent]);
    expect(tones).toEqual([["ok", "12 sem corte"], ["lossy", "1 lossy"], ["none", "1 sem medição"]]);
  });

  it("sem chave não consulta; falha não mostra nada", async () => {
    vi.mocked(libListenStats).mockRejectedValue("qdrant fora");
    const { container } = render(() => <ListenFacts query={null} />);
    expect(libListenStats).not.toHaveBeenCalled();
    cleanup();
    const r = render(() => <ListenFacts query={{ artist: "X" }} />);
    await vi.waitFor(() => expect(libListenStats).toHaveBeenCalledWith({ artist: "X", album: null }));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.container.querySelector(".lib-hero__facts")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("motor montando: só a qualidade", async () => {
    vi.mocked(libListenStats).mockResolvedValue({ ...base, familiarity_ready: false });
    const { container } = render(() => <ListenFacts query={{ artist: "X" }} />);
    await vi.waitFor(() => expect(container.querySelector(".lib-hero__facts")).toBeTruthy());
    expect(container.textContent).not.toContain("ouvido");
    expect(container.textContent).toContain("12 sem corte");
  });
});
