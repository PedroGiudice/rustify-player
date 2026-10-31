import { describe, it, expect, afterEach } from "vitest";
import { createResource, createSignal, Suspense } from "solid-js";
import { render, cleanup } from "@solidjs/testing-library";
import { listState, peek, settle } from "./loaded";

afterEach(cleanup);

describe("settle — falha vira valor, não lista vazia", () => {
  it("sucesso guarda os dados", async () => {
    expect(await settle(Promise.resolve([1, 2]))).toEqual({ ok: true, data: [1, 2] });
  });

  it("rejeição guarda a mensagem do erro", async () => {
    expect(await settle(Promise.reject(new Error("qdrant fora")))).toEqual({ ok: false, error: "qdrant fora" });
  });

  it("aceita função que lança antes de devolver a promessa", async () => {
    const r = await settle(() => { throw "sem índice"; });
    expect(r).toEqual({ ok: false, error: "sem índice" });
  });
});

describe("listState — carregando, erro, vazio e pronto são estados distintos", () => {
  it("sem resultado ainda = carregando", () => {
    expect(listState(undefined)).toBe("carregando");
  });
  it("falha = erro (nunca vazio)", () => {
    expect(listState({ ok: false, error: "x" })).toBe("erro");
  });
  it("lista vazia = vazio", () => {
    expect(listState({ ok: true, data: [] })).toBe("vazio");
  });
  it("lista com itens = pronto", () => {
    expect(listState({ ok: true, data: [1] })).toBe("pronto");
  });
});

describe("peek — ler o resultado não aciona o Suspense da rota", () => {
  it("primeira carga e recarga mostram a própria tela, não o fallback global", async () => {
    let release!: (v: string[]) => void;
    const [key, setKey] = createSignal(1);
    const { container } = render(() => {
      const [r] = createResource(key, () => new Promise<string[]>((res) => { release = res; }));
      return (
        <Suspense fallback={<p>FALLBACK</p>}>
          <p>{peek(r) === undefined ? "carregando" : peek(r)!.join(",")}</p>
        </Suspense>
      );
    });
    expect(container.textContent).toBe("carregando");
    release(["a"]);
    await Promise.resolve(); await Promise.resolve();
    expect(container.textContent).toBe("a");
    setKey(2);
    expect(container.textContent).toBe("a");
    release(["b"]);
    await Promise.resolve(); await Promise.resolve();
    expect(container.textContent).toBe("b");
  });
});
