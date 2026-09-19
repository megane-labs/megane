/**
 * Vite config for building the full MeganeViewer app for docs embedding.
 * Outputs to docs/public/app/ with the correct base path.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";

export default defineConfig({
  plugins: [react(), wasm()],
  // The parse worker imports the WASM module; its sub-build needs the wasm plugin.
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  assetsInclude: ["**/*.xtc"],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  base: "/megane/app/",
  build: {
    outDir: "docs/public/app",
    emptyOutDir: true,
    // Same entries as vite.config.ts minus the E2E harness: the viewer at
    // /app/ and megane Builder at /app/builder.html.
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        builder: path.resolve(__dirname, "builder.html"),
      },
    },
  },
});
