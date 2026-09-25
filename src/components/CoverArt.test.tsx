/* ============================================================
   CoverArt.test.tsx — Contrato do componente de capa.
   ============================================================ */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { CoverArt } from "./CoverArt";

afterEach(() => {
  cleanup();
});

describe("CoverArt", () => {
  it("capa real carrega sob demanda (a grade de álbuns mostra o acervo inteiro)", () => {
    const { container } = render(() => <CoverArt seed="x" src="/covers/a.webp" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/covers/a.webp");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });
});
