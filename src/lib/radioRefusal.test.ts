import { describe, it, expect, vi, beforeEach } from "vitest";
import { refuseFromRadio, returnToRadio, radioRevision } from "./radioRefusal";
import { toast, runToastAction, dismissToast } from "../store/toast";
import { libRadioRefuse, libRadioReturn, libRadioRestore } from "../tauri";
import type { RadioChange, RadioState, Track } from "../tauri";

vi.mock("../tauri", () => ({
  libRadioRefuse: vi.fn(),
  libRadioReturn: vi.fn(),
  libRadioRestore: vi.fn(),
}));

const empty: RadioState = { never_at: null, off_stations: [], release_skips: 0, released_at: null };
const change = (after: Partial<RadioState>): RadioChange => ({
  track_id: "9", before: empty, after: { ...empty, ...after },
});
const track = { id: "9", title: "Alright" } as Track;

beforeEach(() => {
  vi.mocked(libRadioRefuse).mockReset();
  vi.mocked(libRadioReturn).mockReset();
  vi.mocked(libRadioRestore).mockReset();
  dismissToast();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recusa com escopo (B9)", () => {
  it("nunca no rádio: avisa e o Desfazer grava o estado de antes", async () => {
    vi.mocked(libRadioRefuse).mockResolvedValue(change({ never_at: 100 }));
    vi.mocked(libRadioRestore).mockResolvedValue(change({}));
    const rev = radioRevision();
    await refuseFromRadio(track, "never");
    expect(libRadioRefuse).toHaveBeenCalledWith("9", "never", undefined);
    expect(toast()?.message).toBe("“Alright” não toca mais no rádio");
    expect(radioRevision()).toBe(rev + 1);
    runToastAction();
    await vi.waitFor(() => expect(libRadioRestore).toHaveBeenCalledWith("9", empty));
    await vi.waitFor(() => expect(radioRevision()).toBe(rev + 2));
  });

  it("fora desta station: diz qual", async () => {
    vi.mocked(libRadioRefuse).mockResolvedValue(change({ off_stations: ["chuva"] }));
    await refuseFromRadio(track, "station", { id: "chuva", name: "Chuva" });
    expect(libRadioRefuse).toHaveBeenCalledWith("9", "station", "chuva");
    expect(toast()?.message).toBe("“Alright” não toca mais na station Chuva");
  });

  it("falha avisa com Tentar de novo", async () => {
    vi.mocked(libRadioRefuse).mockRejectedValue("qdrant fora");
    await refuseFromRadio(track, "never");
    expect(toast()?.message).toBe("Não consegui tirar “Alright” do rádio.");
    expect(toast()?.action?.label).toBe("Tentar de novo");
  });
});

describe("devolver ao rádio (B9)", () => {
  it("devolve tudo e o Desfazer restaura", async () => {
    vi.mocked(libRadioReturn).mockResolvedValue({ track_id: "9", before: { ...empty, never_at: 5 }, after: empty });
    vi.mocked(libRadioRestore).mockResolvedValue(change({ never_at: 5 }));
    await returnToRadio(track);
    expect(libRadioReturn).toHaveBeenCalledWith("9");
    expect(toast()?.message).toBe("“Alright” voltou ao rádio");
    runToastAction();
    await vi.waitFor(() => expect(libRadioRestore).toHaveBeenCalledWith("9", { ...empty, never_at: 5 }));
  });

  it("motor ainda montando: diz para tentar de novo em instantes", async () => {
    vi.mocked(libRadioReturn).mockRejectedValue("familiaridade ainda montando");
    await returnToRadio(track);
    expect(toast()?.message).toBe("Não consegui devolver “Alright” ao rádio: o motor ainda está carregando.");
    expect(toast()?.action?.label).toBe("Tentar de novo");
  });
});
