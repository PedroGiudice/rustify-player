/* "Fora do rádio" (B9): o motivo em números, Devolver com Desfazer, e a
   lista relida quando uma recusa nova é gravada. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({
  coverUrl: () => null,
  libRadioExcluded: vi.fn(),
  libRadioRefuse: vi.fn(),
  libRadioReturn: vi.fn(),
  libRadioRestore: vi.fn(),
}));

import { RadioExcluded } from "./RadioExcluded";
import { libRadioExcluded, libRadioReturn, libRadioRefuse } from "../tauri";
import type { RadioExcludedTrack, RadioExclusion } from "../tauri";
import { refuseFromRadio } from "../lib/radioRefusal";
import { toast, dismissToast } from "../store/toast";

const ex = (r: Partial<RadioExclusion>): RadioExclusion => ({
  never_ends: false, motor_attempts: 0, early_skips: 0, early_skips_total: 0, ended: 0,
  never_at: null, off_stations: [], released_at: null, ...r,
});
const row = (id: string, title: string, radio: Partial<RadioExclusion>): RadioExcludedTrack => ({
  id, title, artist_name: "A", album_title: null, album_cover_path: null, album_year: null,
  duration_ms: 1, path: `/m/${id}`, lrc_path: null, radio: ex(radio),
});
const empty = { never_at: null, off_stations: [], release_skips: 0, released_at: null };
const names = (id: string) => (id === "chuva" ? "Chuva" : undefined);

afterEach(() => { cleanup(); dismissToast(); vi.clearAllMocks(); });

describe("Fora do rádio (B9)", () => {
  it("lista cada faixa com o motivo em números", async () => {
    vi.mocked(libRadioExcluded).mockResolvedValue({
      familiarity_ready: true,
      tracks: [
        row("1", "Pulada", { never_ends: true, motor_attempts: 4, early_skips: 3 }),
        row("2", "Chovida", { off_stations: ["chuva"] }),
      ],
    });
    render(() => <RadioExcluded stationName={names} />);
    expect(await screen.findByText("Pulada cedo 3 vezes nas 4 em que o rádio a tocou, nunca até o fim")).toBeTruthy();
    expect(screen.getByText("Fora da station Chuva")).toBeTruthy();
    expect(screen.getByText(/· 2/)).toBeTruthy();
  });

  it("Devolver ao rádio avisa com Desfazer e relê a lista", async () => {
    vi.mocked(libRadioExcluded).mockResolvedValue({
      familiarity_ready: true, tracks: [row("1", "Pulada", { never_ends: true, motor_attempts: 3, early_skips: 3 })],
    });
    vi.mocked(libRadioReturn).mockResolvedValue({ track_id: "1", before: { ...empty, release_skips: 0 }, after: { ...empty, release_skips: 3 } });
    render(() => <RadioExcluded stationName={names} />);
    fireEvent.click(await screen.findByRole("button", { name: "Devolver “Pulada” ao rádio" }));
    expect(libRadioReturn).toHaveBeenCalledWith("1");
    await vi.waitFor(() => expect(toast()?.message).toBe("“Pulada” voltou ao rádio"));
    expect(toast()?.action?.label).toBe("Desfazer");
    await vi.waitFor(() => expect(libRadioExcluded).toHaveBeenCalledTimes(2));
  });

  it("recusa feita fora da lista (menu) aparece sem recarregar a tela", async () => {
    vi.mocked(libRadioExcluded).mockResolvedValue({ familiarity_ready: true, tracks: [] });
    render(() => <RadioExcluded stationName={names} />);
    expect(await screen.findByText(/Nada fora do rádio/)).toBeTruthy();
    vi.mocked(libRadioRefuse).mockResolvedValue({ track_id: "7", before: empty, after: { ...empty, never_at: 1 } });
    vi.mocked(libRadioExcluded).mockResolvedValue({
      familiarity_ready: true, tracks: [row("7", "Nova", { never_at: Date.now() / 1000 })],
    });
    await refuseFromRadio({ id: "7", title: "Nova" }, "never");
    expect(await screen.findByText("Você tirou do rádio hoje")).toBeTruthy();
  });

  it("motor montando: avisa que só as recusas do dono aparecem", async () => {
    vi.mocked(libRadioExcluded).mockResolvedValue({ familiarity_ready: false, tracks: [] });
    render(() => <RadioExcluded stationName={names} />);
    expect(await screen.findByText(/O motor ainda está carregando/)).toBeTruthy();
  });

  it("falha na leitura não parece lista vazia", async () => {
    vi.mocked(libRadioExcluded).mockRejectedValue("qdrant fora");
    render(() => <RadioExcluded stationName={names} />);
    expect(await screen.findByText("Não consegui ler o que está fora do rádio.")).toBeTruthy();
    expect(screen.queryByText(/Nada fora do rádio/)).toBeNull();
  });
});
