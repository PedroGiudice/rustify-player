import { describe, expect, it } from "vitest";
import { bootCheckDue, fmtBytes, phaseAfterCheckFailure, reduceProgress, type UpdState } from "./updater";

const base: UpdState = {
  phase: "available",
  check: {
    installed: "0.2.75",
    latest: "0.2.76",
    available: true,
    apkUrl: "https://x/a.apk",
    sha256: null,
    size: 100,
    canInstall: true,
  },
  bytes: 0,
  total: 0,
  error: null,
};

describe("reduceProgress", () => {
  it("downloading atualiza bytes/total e limpa erro", () => {
    const s = reduceProgress({ ...base, error: "x" }, { phase: "downloading", bytes: 40, total: 100 });
    expect(s.phase).toBe("downloading");
    expect(s.bytes).toBe(40);
    expect(s.total).toBe(100);
    expect(s.error).toBeNull();
  });

  it("failed guarda a mensagem e mantém o check para re-tentar", () => {
    const s = reduceProgress(base, { phase: "failed", message: "sha256 divergente" });
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("sha256 divergente");
    expect(s.check).toEqual(base.check);
  });

  it("verifying/installing/confirm_pending/confirming/done trocam só a fase", () => {
    for (const phase of ["verifying", "installing", "confirm_pending", "confirming", "done"] as const) {
      expect(reduceProgress(base, { phase }).phase).toBe(phase);
    }
  });

  it("total desconhecido (-1) vira 0 — nunca '-0,0 MB' na tela", () => {
    const s = reduceProgress(base, { phase: "downloading", bytes: 10, total: -1 });
    expect(s.total).toBe(0);
  });
});

describe("phaseAfterCheckFailure", () => {
  it("sem check anterior volta a idle", () => {
    expect(phaseAfterCheckFailure(null)).toBe("idle");
  });
  it("check anterior 'atualizado' NÃO vira 'disponível' por falha de rede", () => {
    expect(phaseAfterCheckFailure({ ...base.check!, available: false })).toBe("uptodate");
  });
  it("check anterior 'disponível' continua oferecendo o download", () => {
    expect(phaseAfterCheckFailure(base.check)).toBe("available");
  });
});

describe("bootCheckDue", () => {
  const H = 3_600_000;
  it("sem registro anterior, deve checar", () => {
    expect(bootCheckDue(null, 10 * H)).toBe(true);
  });
  it("dentro de 6h não checa; depois de 6h checa", () => {
    expect(bootCheckDue(String(4 * H), 9 * H)).toBe(false);
    expect(bootCheckDue(String(4 * H), 10 * H + 1)).toBe(true);
  });
  it("valor corrompido conta como nunca checou", () => {
    expect(bootCheckDue("abc", 10 * H)).toBe(true);
  });
});

describe("fmtBytes", () => {
  it("formata MB com uma casa", () => {
    expect(fmtBytes(27_702_872)).toBe("26,4 MB");
    expect(fmtBytes(0)).toBe("0 MB");
  });
});
