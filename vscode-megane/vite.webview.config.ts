import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import { prodDefine, srcAlias, vscodeModules, wasmWorker } from "../vite.shared";

export default defineConfig({
  // Parse files in the same Web Worker the webapp uses: off the main thread,
  // and with lazy trajectory streaming (frame 0 first, the rest decoded on
  // demand). The worker is its own file beside webview.js; `base: "./"` makes
  // its URL resolve against `import.meta.url` (the webview resource URI), and
  // webview/main.tsx starts it through a blob: bootstrap because the webview's
  // origin differs from the resource origin.
  base: "./",
  plugins: [react(), wasm()],
  worker: wasmWorker(),
  resolve: {
    alias: [srcAlias()],
    // Resolve dependencies from both vscode-megane/node_modules and parent node_modules
    modules: vscodeModules(),
  },
  define: prodDefine,
  build: {
    outDir: "media",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "webview/main.tsx"),
      output: {
        entryFileNames: "webview.js",
        // Keep WASM as a separate file (loaded by the webview)
        assetFileNames: "[name][extname]",
        inlineDynamicImports: true,
      },
    },
    minify: true,
    sourcemap: false,
  },
});
