import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import { prodDefine, srcAlias, syncParseAlias, vscodeModules } from "../vite.shared";

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    alias: [
      // Single-file webview bundle: use the synchronous main-thread parse path
      // rather than embedding a Web Worker (the webview already loads WASM via a
      // blob URL). Keeps the bundle self-contained under the strict CSP.
      syncParseAlias(),
      srcAlias(),
    ],
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
