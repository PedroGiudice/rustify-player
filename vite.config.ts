import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  // Tauri aponta para dist/ — ajuste frontendDist em tauri.conf.json
  build: {
    outDir: "dist",
    target: "esnext",
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  // Permite que o Tauri injete __TAURI__ no contexto
  envPrefix: ["VITE_", "TAURI_"],
});
