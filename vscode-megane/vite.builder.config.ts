import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import { ketcherAlias, ketcherDefine, ketcherRaphaelRequire } from "../vite.ketcher";
import { rdkitNoDefaultWasm } from "../vite.rdkit";
import {
  aliasEntries,
  prodDefine,
  srcAlias,
  syncParseAlias,
  vscodeModules,
  wasmWorker,
} from "../vite.shared";

/**
 * Webview bundle of megane Builder (`media/builder/`), opened in an editor tab
 * from the megane activity-bar view.
 *
 * Unlike the viewer's single-file `webview.js`, this build keeps its chunks:
 * Ketcher (the sketcher, ~8 MB of JS plus its WASM engine) is loaded only when
 * a sketch is opened. `base: "./"` makes every chunk, worker and `.wasm` URL
 * resolve against the importing module (`import.meta.url`), i.e. the webview
 * resource URI, and the page's CSP admits scripts from the extension's
 * resource origin for the dynamically imported chunks.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), wasm(), ketcherRaphaelRequire()],
  worker: wasmWorker(() => [rdkitNoDefaultWasm()]),
  resolve: {
    alias: [
      // Parse on the main thread, as the viewer's webview does.
      syncParseAlias(),
      srcAlias(),
      ...aliasEntries(ketcherAlias),
    ],
    modules: vscodeModules(),
  },
  define: { ...ketcherDefine, ...prodDefine },
  build: {
    outDir: "media/builder",
    emptyOutDir: true,
    chunkSizeWarningLimit: 10_000,
    rollupOptions: {
      input: path.resolve(__dirname, "webview/builder.tsx"),
      output: {
        entryFileNames: "builder.js",
        chunkFileNames: "[name]-[hash].js",
        // Stylesheets keep plain names (the page links `builder.css`).
        assetFileNames: (info) =>
          info.names?.some((n) => n.endsWith(".css"))
            ? "[name][extname]"
            : "[name]-[hash][extname]",
      },
    },
    minify: true,
    sourcemap: false,
  },
});
