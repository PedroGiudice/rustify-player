import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test-setup.ts"],
    // Worktrees de subagentes vivem em .claude/worktrees/ dentro do repo;
    // sem o exclude o vitest varre as cópias e roda cada suite duas vezes
    // (a do worktree falha por node_modules/ausente ou stale).
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
