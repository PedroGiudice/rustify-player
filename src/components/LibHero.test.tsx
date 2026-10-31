/* ============================================================
   LibHero.test.tsx — o cabeçalho único de Álbum, Artista e Playlist (B2).
   ============================================================ */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { LibHero } from "./LibHero";
import { plural, totalDur } from "../lib/count";

afterEach(cleanup);

describe("LibHero (B2)", () => {
  it("mesma gramática: capa, rótulo do tipo, título h1, números e ações à direita", () => {
    const { container, getByRole } = render(() => (
      <LibHero
        kicker="Álbum · 1981"
        title="Greatest Hits"
        cover={<img src="/c.webp" alt="" />}
        stats={<span>17 faixas</span>}
        actions={<button type="button">Tocar</button>}
      />
    ));
    const head = container.querySelector("header.view__head.lib-hero")!;
    expect(head).toBeTruthy();
    expect(head.querySelector(".lib-hero__cover img")).toBeTruthy();
    expect(head.querySelector(".lib-hero__kicker")!.textContent).toBe("Álbum · 1981");
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Greatest Hits");
    expect(head.querySelector(".lib-hero__stats")!.textContent).toBe("17 faixas");
    // As ações vêm depois do bloco da capa e do título (à direita, no fim da linha).
    expect(head.lastElementChild!.classList.contains("lib-hero__actions")).toBe(true);
  });

  it("artista tem a capa redonda", () => {
    const { container } = render(() => (
      <LibHero kicker="Artista" title="Queen" round cover={<span />} stats={null} actions={null} />
    ));
    expect(container.querySelector(".lib-hero__cover")!.getAttribute("data-round")).toBe("true");
  });
});

describe("count", () => {
  it("plural com milhar em pt-BR", () => {
    expect(plural(1, "faixa", "faixas")).toBe("1 faixa");
    expect(plural(0, "faixa", "faixas")).toBe("0 faixas");
    expect(plural(1234, "faixa", "faixas")).toBe("1.234 faixas");
  });

  it("duração somada", () => {
    expect(totalDur(48 * 60_000)).toBe("48 min");
    expect(totalDur((3 * 60 + 5) * 60_000)).toBe("3 h 05 min");
    expect(totalDur(0)).toBe("0 min");
  });
});
