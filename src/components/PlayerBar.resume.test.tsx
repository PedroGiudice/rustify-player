/* ============================================================
   PlayerBar.resume.test.tsx — "Resume on launch" tem efeito (cfg-1).

   O toggle do Settings gravava uma chave que ninguém lia: o
   PlayerBar chamava restoreSession() incondicionalmente, e a
   sessão voltava mesmo com o Resume desligado. Contrato: com a
   preferência desligada, o boot não lê o snapshot persistido.
   ============================================================ */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

const persistLoadState = vi.hoisted(() => vi.fn());

vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return { ...actual, persistLoadState };
});

import { PlayerBar } from "./PlayerBar";
import { setResumeOnLaunch } from "../store/player";

beforeEach(() => {
  localStorage.clear();
  persistLoadState.mockReset();
  persistLoadState.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  setResumeOnLaunch(true);
});

// setupAsync encadeia alguns awaits (listeners de IPC) antes de chegar
// ao restoreSession; drenar a fila de microtasks algumas vezes basta.
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("PlayerBar: Resume on launch", () => {
  it("ligado (default) restaura a sessão persistida no mount", async () => {
    render(() => <PlayerBar />);
    await vi.waitFor(() => expect(persistLoadState).toHaveBeenCalledTimes(1));
  });

  it("desligado não lê o snapshot persistido", async () => {
    setResumeOnLaunch(false);
    render(() => <PlayerBar />);
    await settle();
    expect(persistLoadState).not.toHaveBeenCalled();
  });
});
