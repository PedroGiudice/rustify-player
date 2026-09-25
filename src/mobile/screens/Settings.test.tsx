/* ============================================================
   Settings.test.tsx — os controles do fundo 2D acompanham o que
   está desenhando (mobile-v5): com o WebGL em falha o 2D assumiu,
   e escondê-los deixava o fundo vivo sem controle.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

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
import { resetGlStatus, setGlStatus } from "../../gl/meta";

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
