import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import { ketcherAlias, ketcherDefine, ketcherRaphaelRequire } from "../vite.ketcher";
import { rdkitNoDefaultWasm } from "../vite.rdkit";
import {
  aliasEntries,
  forbidWorkerFiles,
  inlineEmbedWorkerAlias,
  inlineWasmWorker,
  prodDefine,
  selfContainedKetcherAlias,
  srcAlias,
  syncParseAlias,
  vscodeModules,
} from "../vite.shared";

/**
 * Webview bundle of megane Builder (`media/builder/`), opened in an editor tab
 * from the megane activity-bar view.
 *
 * Unlike the viewer's single-file `webview.js`, this build keeps its chunks:
 * Ketcher (the sketcher, ~8 MB of JS plus its WASM engine) is loaded only when
 * a sketch is opened. `base: "./"` makes every chunk and `.wasm` URL resolve
 * against the importing module (`import.meta.url`), i.e. the webview
 * resource URI, and the page's CSP admits scripts from the extension's
 * resource origin for the dynamically imported chunks.
 *
 * Workers are the exception: a worker in a webview reaches the resource
 * origin only until the webview's service worker restarts (about 30 s idle,
 * see src/utils/workerAssets.ts), so none is started from a file there.
 * RDKit's worker is inlined with its imports folded in, and the page fetches
 * its `.wasm` (`embed.ts`); Ketcher comes in its self-contained build, whose
 * Indigo worker carries its own `.wasm`. `forbidWorkerFiles` fails the build
 * if a worker file comes back.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), wasm(), ketcherRaphaelRequire(), forbidWorkerFiles()],
  worker: inlineWasmWorker(() => [rdkitNoDefaultWasm()]),
  resolve: {
    alias: [
      // Parse on the main thread: the Builder only opens single structures.
      syncParseAlias(),
      inlineEmbedWorkerAlias(),
      selfContainedKetcherAlias(),
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
