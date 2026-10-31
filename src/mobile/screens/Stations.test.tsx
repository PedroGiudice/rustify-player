/* ============================================================
   Stations.test.tsx — carregando, erro e vazio (A64).

   A falha e o boot frio apareciam como "Rode o export no desktop
   (export_manifest.py --deploy)", texto de desenvolvedor que ainda
   apontava o lugar errado (o export roda na VM).
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import type { StationMeta } from "../types";

const st = vi.hoisted(() => ({
  state: "ready" as "loading" | "ready" | "error",
  list: [] as StationMeta[],
  reload: vi.fn(),
}));

vi.mock("../store", () => ({
  playStation: vi.fn(),
  stations: () => st.list,
  stationsState: () => st.state,
  reloadStations: st.reload,
  libReady: () => true,
  libError: () => null,
  reloadLibrary: vi.fn(),
}));

import { Stations } from "./Stations";

afterEach(() => {
  cleanup();
  st.state = "ready";
  st.list = [];
  vi.clearAllMocks();
});

describe("Stations (A64)", () => {
  it("carregando diz que está carregando, não manda rodar nada", () => {
    st.state = "loading";
    const r = render(() => <Stations />);
    expect(r.getByText("Carregando stations…")).toBeTruthy();
    expect(r.container.textContent).not.toMatch(/export_manifest/);
  });

  it("falha mostra o erro com tentar de novo", () => {
    st.state = "error";
    const r = render(() => <Stations />);
    expect(r.getByText("Não deu para carregar as stations")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Tentar de novo" }));
    expect(st.reload).toHaveBeenCalledTimes(1);
  });

  it("vazio de verdade explica de onde as stations vêm", () => {
    const r = render(() => <Stations />);
    expect(r.getByText("Nenhuma station neste aparelho")).toBeTruthy();
    expect(r.getByText("Elas vêm do desktop na próxima sincronização.")).toBeTruthy();
  });

  it("com lista, o subtítulo conta sem jargão", () => {
    st.list = [{ id: "a", name: "Noite", kind: "seed", pool_size: 4 } as StationMeta];
    const r = render(() => <Stations />);
    expect(r.getByText("1 station do desktop")).toBeTruthy();
    expect(r.container.textContent).not.toMatch(/re-rank/);
  });
});
