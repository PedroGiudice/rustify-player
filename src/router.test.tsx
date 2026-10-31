/* ============================================================
   router.test.tsx — uma exceção no render de uma tela não derruba o
   shell: o RouterView mostra o erro com saída (A7).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const { boom } = vi.hoisted(() => ({ boom: { on: true } }));

vi.mock("./views/Home", () => ({
  default: () => {
    if (boom.on) throw new Error("render quebrou");
    return <p>HOME OK</p>;
  },
}));
vi.mock("./views/Library", () => ({ default: () => <p>LIBRARY OK</p> }));

import { RouterView, navigate } from "./router";

afterEach(() => {
  cleanup();
  boom.on = true;
  window.location.hash = "";
});

describe("RouterView — tela que lança", () => {
  it("mostra o bloco de erro e Tentar de novo remonta a tela", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.location.hash = "#/home";
    const { findByRole, findByText } = render(() => <RouterView />);
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Esta tela falhou.");
    boom.on = false;
    fireEvent.click(alert.querySelector("button")!);
    expect(await findByText("HOME OK")).toBeTruthy();
  });

  it("trocar de rota sai do erro", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.location.hash = "#/home";
    const { findByRole, findByText } = render(() => <RouterView />);
    await findByRole("alert");
    navigate("/library");
    expect(await findByText("LIBRARY OK")).toBeTruthy();
  });
});
