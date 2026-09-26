// Entrada própria do bench offscreen: NÃO faz parte do build do app.
//   npx vite build --config scripts/gl-bench/vite.config.ts --outDir /tmp/<dir>
// base "./" para a página funcionar servida de qualquer diretório.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
});
