import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Release hosts load the same bundle from file:// (Electron) or Tauri's
  // asset protocol. Relative URLs keep CSS/JS available in both packages.
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/goal-runs/**"] }
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2022", sourcemap: true }
});
