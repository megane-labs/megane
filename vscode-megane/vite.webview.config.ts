import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import {
  forbidWorkerFiles,
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
  // wasm-bindgen glue folded in, because a worker cannot rely on loading
  // anything from the extension's resource origin: the webview's service
  // worker answers a Web Worker's requests through a port it loses when it is
  // stopped for being idle, after which they hang for ~30 s and fail (see
  // src/utils/workerAssets.ts). parseClient hands the worker a WASM module
  // compiled on the page for the same reason. forbidWorkerFiles keeps it so.
  base: "./",
  plugins: [react(), wasm(), forbidWorkerFiles()],
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
