import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import {
  inlineParseWorkerAlias,
  inlineWasmWorker,
  prodDefine,
  srcAlias,
  vscodeModules,
} from "../vite.shared";

export default defineConfig({
  // Parse files in the same Web Worker the webapp uses: off the main thread,
  // and with lazy trajectory streaming (frame 0 first, the rest decoded on
  // demand). The worker is inlined into webview.js as a blob: script, with the
  // wasm-bindgen glue folded in, because a worker cannot load anything from the
  // extension's resource origin: those requests are answered only through the
  // webview's service worker, which a Web Worker's requests bypass, and they
  // hang for ~30 s before failing. parseClient hands the worker a WASM module
  // compiled on the page for the same reason.
  base: "./",
  plugins: [react(), wasm()],
  worker: inlineWasmWorker(),
  resolve: {
    alias: [inlineParseWorkerAlias(), srcAlias()],
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
