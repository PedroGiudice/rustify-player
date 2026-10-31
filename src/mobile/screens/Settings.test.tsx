/* ============================================================
   Settings.test.tsx — os controles do fundo 2D acompanham o que
   está desenhando (mobile-v5): com o WebGL em falha o 2D assumiu,
   e escondê-los deixava o fundo vivo sem controle.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

vi.mock("../store", () => ({
  albums: () => [],
  artists: () => [],
  continuityOn: () => true,
  folders: () => [],
  rescan: vi.fn(),
  rescanning: () => false,
  setContinuity: vi.fn(),
  tracks: () => [],
}));

vi.mock("../updater", () => ({
  appVersion: () => "0.0.0",
  checkForUpdate: vi.fn(),
  fmtBytes: (n: number) => `${n} B`,
  installUpdate: vi.fn(),
  upd: () => ({ phase: "idle", bytes: 0, total: 0 }),
  updBusy: () => false,
}));

import { Settings } from "./Settings";
import { setBgEngine } from "../bg/engine";
import { glStatus, resetGlStatus, SCENE_KEYS, setGlStatus } from "../../gl/meta";

const ROW = "Background render + shape";

afterEach(() => {
  cleanup();
  setBgEngine("2d");
  resetGlStatus();
});

describe("Settings — controles do fundo 2D", () => {
  it("WebGL em falha: o 2D assumiu e os controles dele aparecem", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: false, renderer: "", error: "sem contexto", fps: 0 });
    const r = render(() => <Settings />);
    expect(r.queryByText(ROW)).not.toBeNull();
  });

  it("WebGL funcionando: sem controles do 2D", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: true, renderer: "x", error: "", fps: 60 });
    const r = render(() => <Settings />);
    expect(r.queryByText(ROW)).toBeNull();
  });

  it("motor 2D: controles presentes", () => {
    const r = render(() => <Settings />);
    expect(r.queryByText(ROW)).not.toBeNull();
  });
});

// A33 (S24): "quatro cenas" (são oito), nome cru da GPU, "0 fps" no
// primeiro segundo e PLL/SpectrumTap na dica da batida.
describe("Settings — textos do fundo (A33)", () => {
  it("a dica do motor conta as cenas pelo registro, por extenso", () => {
    const r = render(() => <Settings />);
    expect(SCENE_KEYS.length).toBe(8);
    expect(r.getByText(/as mesmas oito cenas do desktop/)).toBeTruthy();
  });

  it("WebGL no ar: só os fps medidos, sem o nome da GPU", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: true, renderer: "Mali-G715 Immortalis", error: "", fps: 59 });
    const r = render(() => <Settings />);
    expect(r.getByText("59 fps medidos")).toBeTruthy();
    expect(r.container.textContent).not.toContain("Mali");
  });

  it("no primeiro segundo diz que está medindo, não '0 fps'", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: true, renderer: "x", error: "", fps: 0 });
    const r = render(() => <Settings />);
    expect(r.getByText("medindo…")).toBeTruthy();
  });

  it("WebGL que caiu: diz que o 2D está no ar e oferece tentar de novo", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: false, renderer: "", error: "sem contexto", fps: 0 });
    const r = render(() => <Settings />);
    expect(r.getByText("O fundo WebGL não iniciou; o 2D está no ar.")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Tentar de novo" }));
    expect(glStatus().ok).toBeNull();
  });

  it("a dica da batida não fala de PLL nem de SpectrumTap", () => {
    const r = render(() => <Settings />);
    expect(r.getByText("Quanto o fundo reage ao bumbo.")).toBeTruthy();
    expect(r.container.textContent).not.toMatch(/PLL|SpectrumTap/);
  });
});
