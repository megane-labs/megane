import { defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";
import { rdkitNoDefaultWasm } from "./vite.rdkit";
import fs from "fs";
import path from "path";

const RDKIT_WASM = path.resolve(__dirname, "node_modules/megane-rdkit/dist/megane-rdkit.wasm");
const OUT_DIR = path.resolve(__dirname, "python/megane/static");

/** Ship RDKit's `.wasm` beside the bundle, unhashed, for the kernel to send on request. */
function copyRdkitWasm(): Plugin {
  return {
    name: "megane-copy-rdkit-wasm",
    apply: "build",
    closeBundle() {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.copyFileSync(RDKIT_WASM, path.join(OUT_DIR, "megane-rdkit.wasm"));
    },
  };
}

/**
 * anywidget bundle of megane Builder (`megane.Builder()` in a notebook): one
 * self-contained ES module, like the viewer's `widget.js`, written next to it
 * as `builder_widget.js` so the viewer widget does not grow.
 *
 * Two parts of the web app's Builder are left out to keep it that size:
 * Ketcher (~20 MB; the sketch dialog falls back to pasting a MOL file) and
 * RDKit's `.wasm` (3.5 MB; the widget asks the kernel for
 * `static/megane-rdkit.wasm` the first time Clean up or a sketch needs it).
 * The RDKit worker itself is inlined.
 */
export default defineConfig({
  plugins: [wasm(), rdkitNoDefaultWasm(), copyRdkitWasm()],
  resolve: {
    alias: [
      // Single-file bundle: parse on the main thread (see vite.widget.config.ts).
      {
        find: /\.\/parseClient$/,
        replacement: path.resolve(__dirname, "src/parsers/parseClientSync.ts"),
      },
      {
        find: /^\.\/KetcherEditor$/,
        replacement: path.resolve(__dirname, "src/builder/library/KetcherUnavailable.tsx"),
      },
      {
        find: /^\.\/embed\.worker\?worker$/,
        replacement: `${path.resolve(__dirname, "src/builder/library/embed.worker.ts")}?worker&inline`,
      },
      {
        find: /^megane-rdkit\/dist\/megane-rdkit\.wasm\?url$/,
        replacement: path.resolve(__dirname, "src/builder/library/rdkitWasmUnbundled.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  worker: {
    format: "es",
    plugins: () => [rdkitNoDefaultWasm()],
  },
  build: {
    outDir: "python/megane/static",
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "src/builderWidget.ts"),
      formats: ["es"],
      fileName: () => "builder_widget.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    minify: true,
    sourcemap: false,
  },
});
