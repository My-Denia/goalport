import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the detached coordination worker's engine bundle:
 *   dist/coordination-engine.cjs
 * from the SAME requestCoordination entry the window uses (re-exported by
 * src/coordination/workerEntry.ts). No React plugin, no browser-only
 * runtime; node builtins stay external because the worker runs in Node.
 * emptyOutDir stays false so this build never wipes the renderer build that
 * shares dist/.
 */
export default defineConfig({
  clearScreen: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
    // Keep the worker bundle readable: acceptance evidence may inspect it
    // at the exact identity that ran.
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("./src/coordination/workerEntry.ts", import.meta.url)),
      formats: ["cjs"],
      fileName: () => "coordination-engine.cjs",
    },
    rollupOptions: {
      external: [/^node:/],
      output: {
        exports: "named",
      },
    },
  },
});
