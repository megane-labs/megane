import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import path from "path";
import { prodDefine, srcAlias, syncParseAlias } from "./vite.shared";

export default defineConfig({
  plugins: [wasm()],
  resolve: {
    alias: [
      // Single-file anywidget bundle: use the synchronous main-thread parse path
      // instead of bundling a Web Worker. The widget mostly renders
      // Python-pushed data, so the local file-parse worker is not worth the
      // single-file/inline-worker complexity here.
      syncParseAlias(),
      srcAlias(),
    ],
  },
  define: prodDefine,
  build: {
    outDir: "python/megane/static",
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "src/widget.ts"),
      formats: ["es"],
      fileName: () => "widget.js",
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
