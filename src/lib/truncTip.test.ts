import { describe, it, expect } from "vitest";
import { truncTipWithin } from "./truncTip";

// O jsdom não faz layout: as medidas de largura vêm à mão.
function el(text: string, scroll: number, client: number) {
  const e = document.createElement("span");
  e.setAttribute("data-trunc", "");
  e.textContent = text;
  Object.defineProperty(e, "scrollWidth", { value: scroll, configurable: true });
  Object.defineProperty(e, "clientWidth", { value: client, configurable: true });
  return e;
}

describe("truncTipWithin — o texto cortado ganha o title com o texto inteiro", () => {
  it("cortado: title = texto", () => {
    const row = document.createElement("div");
    const t = el("Let It Be (Remastered 2011) [Deluxe Edition]", 400, 180);
    row.appendChild(t);
    truncTipWithin(row);
    expect(t.title).toBe("Let It Be (Remastered 2011) [Deluxe Edition]");
  });

  it("cabe: sem title (não repete o que já se lê)", () => {
    const row = document.createElement("div");
    const t = el("Curta", 40, 180);
    row.appendChild(t);
    truncTipWithin(row);
    expect(t.hasAttribute("title")).toBe(false);
  });

  it("deixou de caber ou passou a caber: o title acompanha", () => {
    const row = document.createElement("div");
    const t = el("Nome", 400, 180);
    row.appendChild(t);
    truncTipWithin(row);
    expect(t.title).toBe("Nome");
    Object.defineProperty(t, "scrollWidth", { value: 100, configurable: true });
    truncTipWithin(row);
    expect(t.hasAttribute("title")).toBe(false);
  });

  it("o próprio contêiner também conta se for marcado", () => {
    const t = el("Card longo", 300, 100);
    truncTipWithin(t);
    expect(t.title).toBe("Card longo");
  });

  it("title posto à mão (sem a marca) não é tocado", () => {
    const row = document.createElement("div");
    const b = document.createElement("button");
    b.title = "Fixar";
    row.appendChild(b);
    truncTipWithin(row);
    expect(b.title).toBe("Fixar");
  });
});
