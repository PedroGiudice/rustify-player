/* ============================================================
   bridge.test.ts — Estado da ponte MCP como o front o vê (cadeado
   da ponte, 29/10/2026). Cobre: boot hidrata via bridgeGetStatus() +
   onBridgeStatus(); o evento atualiza bridgeStatus(); o chip da
   sidebar só existe com a ponte LIGADA e alguém conectado; o texto
   da linha de estado do Tweaks.
   ============================================================ */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BridgeStatus } from "../tauri";

let emit: ((s: BridgeStatus) => void) | undefined;
vi.mock("../tauri", () => ({
  bridgeGetStatus: vi.fn(async () => ({ enabled: false, clients: 0 })),
  onBridgeStatus: vi.fn(async (cb: (s: BridgeStatus) => void) => {
    emit = cb;
    return () => {};
  }),
}));

import * as ipc from "../tauri";
import { bridgeStatus, chipVisible, chipTitle, bridgeLine, wireBridgeStatus, __resetForTests } from "./bridge";

beforeEach(() => {
  __resetForTests();
  emit = undefined;
  vi.mocked(ipc.bridgeGetStatus).mockResolvedValue({ enabled: false, clients: 0 });
});

describe("wireBridgeStatus", () => {
  it("hidrata com o estado do backend e passa a seguir o evento", async () => {
    vi.mocked(ipc.bridgeGetStatus).mockResolvedValue({ enabled: true, clients: 1 });
    await wireBridgeStatus();
    expect(bridgeStatus()).toEqual({ enabled: true, clients: 1 });
    emit!({ enabled: true, clients: 0 });
    expect(bridgeStatus()).toEqual({ enabled: true, clients: 0 });
  });

  it("evento que chega antes da resposta do boot vence a resposta", async () => {
    let resolve!: (s: BridgeStatus) => void;
    vi.mocked(ipc.bridgeGetStatus).mockReturnValue(new Promise<BridgeStatus>((r) => { resolve = r; }));
    const wiring = wireBridgeStatus();
    await Promise.resolve();
    emit!({ enabled: true, clients: 1 });
    resolve({ enabled: false, clients: 0 });
    await wiring;
    expect(bridgeStatus()).toEqual({ enabled: true, clients: 1 });
  });

  it("sem backend fica no estado fechado (desligada, 0 clientes)", async () => {
    vi.mocked(ipc.bridgeGetStatus).mockRejectedValue(new Error("engine not started"));
    await wireBridgeStatus();
    expect(bridgeStatus()).toEqual({ enabled: false, clients: 0 });
  });
});

describe("chipVisible", () => {
  it("só com a ponte ligada E alguém conectado", () => {
    expect(chipVisible({ enabled: true, clients: 1 })).toBe(true);
    expect(chipVisible({ enabled: true, clients: 3 })).toBe(true);
    expect(chipVisible({ enabled: true, clients: 0 })).toBe(false);
    expect(chipVisible({ enabled: false, clients: 2 })).toBe(false);
    expect(chipVisible({ enabled: false, clients: 0 })).toBe(false);
  });
});

describe("bridgeLine", () => {
  it("diz o que o interruptor permite e quem está conectado", () => {
    expect(bridgeLine({ enabled: false, clients: 0 })).toBe("Desligada: nada de fora controla o app.");
    expect(bridgeLine({ enabled: false, clients: 1 })).toBe("Desligada: nada de fora controla o app. 1 cliente conectado está sendo recusado.");
    expect(bridgeLine({ enabled: true, clients: 0 })).toBe("Ligada: nenhum cliente conectado agora.");
    expect(bridgeLine({ enabled: true, clients: 1 })).toBe("Ligada: 1 cliente conectado pode ler e mexer na tela.");
    expect(bridgeLine({ enabled: true, clients: 2 })).toBe("Ligada: 2 clientes conectados podem ler e mexer na tela.");
  });
});

describe("chipTitle", () => {
  it("diz quem pode agir e onde desligar", () => {
    expect(chipTitle({ enabled: true, clients: 1 })).toBe(
      "Ponte conectada: 1 cliente de fora pode ler e mexer na tela. Desligue em Tweaks > Controle remoto.",
    );
    expect(chipTitle({ enabled: true, clients: 2 })).toBe(
      "Ponte conectada: 2 clientes de fora podem ler e mexer na tela. Desligue em Tweaks > Controle remoto.",
    );
  });
});
