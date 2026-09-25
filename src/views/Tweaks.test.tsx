/* ============================================================
   Tweaks.test.tsx — o painel se comporta como overlay (cfg-9).

   Antes: só o × de 22px fechava; o Esc global do App só saía do
   cinema mode. Contrato: Esc fecha o painel aberto e o evento não
   segue pro handler global (fecha o overlay de cima primeiro).
   ============================================================ */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { Tweaks } from "./Tweaks";
import { tweaksOpen, setTweaksOpen } from "../store/tweaks";

afterEach(() => {
  cleanup();
  setTweaksOpen(false);
});

describe("Tweaks: Esc", () => {
  it("fecha o painel aberto", () => {
    render(() => <Tweaks />);
    setTweaksOpen(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(tweaksOpen()).toBe(false);
  });

  it("com o painel aberto, o Esc não chega ao handler global (cinema mode)", () => {
    let globalSaw = 0;
    const onGlobal = (e: KeyboardEvent) => { if (e.key === "Escape") globalSaw++; };
    window.addEventListener("keydown", onGlobal);
    try {
      render(() => <Tweaks />);
      setTweaksOpen(true);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(globalSaw).toBe(0);
      // Fechado, o Esc volta a ser do app.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(globalSaw).toBe(1);
    } finally {
      window.removeEventListener("keydown", onGlobal);
    }
  });

  it("o painel tem id para o aria-controls do gatilho", () => {
    render(() => <Tweaks />);
    expect(document.getElementById("tweaks-panel")).toBeTruthy();
  });
});
