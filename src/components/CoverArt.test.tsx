/* ============================================================
   CoverArt.test.tsx — Contrato do componente de capa.
   ============================================================ */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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

describe("CoverArt — capa que falha ao carregar", () => {
  it("cai no cassete (o fallback da marca), não numa caixa vazia", () => {
    const { container } = render(() => <CoverArt seed="x" src="/covers/apagada.webp" />);
    fireEvent.error(container.querySelector("img")!);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs.length).toBe(1);
    expect(imgs[0].classList.contains("cover__cassette")).toBe(true);
  });

  it("trocar de capa depois de uma falha tenta a nova", () => {
    const [src, setSrc] = createSignal("/covers/apagada.webp");
    const { container } = render(() => <CoverArt seed="x" src={src()} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector(".cover__cassette")).toBeTruthy();

    setSrc("/covers/boa.webp");
    const img = container.querySelector("img")!;
    expect(img.classList.contains("cover__cassette")).toBe(false);
    expect(img.getAttribute("src")).toBe("/covers/boa.webp");
  });
});
