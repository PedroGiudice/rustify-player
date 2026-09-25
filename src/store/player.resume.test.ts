/* ============================================================
   player.resume.test.ts — preferência "Resume on launch" (cfg-1).

   Vive no localStorage (como o volume): é preferência, não sessão.
   A chave mantém o nome legado (rustify-mock-resume-launch) pra
   preservar a escolha que o usuário já salvou pelo Settings — a
   diferença é que agora o boot a respeita.
   ============================================================ */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tauri", () => ({
  setVolume: vi.fn().mockResolvedValue(undefined),
}));

import { resumeOnLaunch, setResumeOnLaunch, loadResumeOnLaunch } from "./player";

beforeEach(() => {
  localStorage.clear();
});

describe("resumeOnLaunch", () => {
  it("default é ligado (sem nada salvo)", () => {
    expect(loadResumeOnLaunch()).toBe(true);
  });

  it("desligar persiste e o sinal reflete", () => {
    setResumeOnLaunch(false);
    expect(resumeOnLaunch()).toBe(false);
    expect(localStorage.getItem("rustify-mock-resume-launch")).toBe("false");
    expect(loadResumeOnLaunch()).toBe(false);
    setResumeOnLaunch(true);
    expect(resumeOnLaunch()).toBe(true);
    expect(loadResumeOnLaunch()).toBe(true);
  });

  it("escolha salva pela versão anterior do Settings é respeitada", () => {
    localStorage.setItem("rustify-mock-resume-launch", "false");
    expect(loadResumeOnLaunch()).toBe(false);
  });
});
