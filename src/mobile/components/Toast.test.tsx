/* ============================================================
   Toast.test.tsx — as confirmações ("Toca em seguida", "Curtida
   removida") são anunciadas: a região role=status existe ANTES da
   mensagem chegar (live region criada junto com o texto não é
   anunciada de forma confiável) — mobile-20.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

const t = vi.hoisted(() => ({ set: null as null | ((v: string | null) => void) }));

vi.mock("../store", async () => {
  const { createSignal } = await import("solid-js");
  const [toast, setToast] = createSignal<string | null>(null);
  t.set = setToast;
  return { toast, libError: () => null, libReady: () => true, reloadLibrary: vi.fn() };
});

import { Toast } from "./ui";

afterEach(cleanup);

describe("Toast", () => {
  it("a região de status existe vazia e recebe a mensagem", () => {
    const r = render(() => <Toast />);
    const live = r.getByRole("status");
    expect(live.textContent).toBe("");
    t.set!("Toca em seguida");
    expect(live.textContent).toBe("Toca em seguida");
    expect(live.querySelector(".toast")).not.toBeNull();
  });
});
