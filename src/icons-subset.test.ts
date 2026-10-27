/* icons-subset.test.ts — o subconjunto Lucide do boot (A25) cobre o
   que o app usa e não está velho em relação ao código. */
import { describe, it, expect } from "vitest";
import subset from "./icons-subset.json";
import { ICONS } from "./components/Icon";

describe("icons-subset.json", () => {
  it("tem todo ícone Lucide do mapa ICONS", () => {
    const sub = subset as { icons: Record<string, unknown>; aliases?: Record<string, unknown> };
    const have = new Set([...Object.keys(sub.icons), ...Object.keys(sub.aliases ?? {})]);
    const lucide = Object.values(ICONS)
      .filter((n) => n.startsWith("lucide:"))
      .map((n) => n.slice("lucide:".length));
    expect(lucide.filter((n) => !have.has(n))).toEqual([]);
  });

  it("está em dia com os nomes do código (gen-icons --check)", async () => {
    // O projeto não tem @types/node: import por string (padrão do layout-modes.test).
    const NODE_CP = "node:child_process";
    const { execFileSync } = await import(/* @vite-ignore */ NODE_CP);
    expect(() =>
      execFileSync("node", ["scripts/gen-icons.mjs", "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });
});
