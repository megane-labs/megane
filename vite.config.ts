import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";

export default defineConfig({
  plugins: [react(), wasm()],
  // The parse worker (src/parsers/parse.worker.ts) imports the WASM module, so
  // its sub-build needs vite-plugin-wasm too.
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
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/ws": {
        target: "ws://localhost:8765",
        ws: true,
      },
      "/api": {
        target: "http://localhost:8765",
      },
    },
  },
  build: {
    outDir: "python/megane/static/app",
    rollupOptions: {
      // Two entries: the app itself, plus the two-viewer harness that backs
      // the `multi-instance` Playwright project (issue #672). Naming `input`
      // at all means the implicit index.html default no longer applies, so
      // both must be listed.
      input: {
        main: path.resolve(__dirname, "index.html"),
        multiInstance: path.resolve(__dirname, "multi-instance.html"),
      },
      output: {
        // Split the large, stable third-party libraries into their own chunks so
        // the app shell no longer ships as a single ~1.8 MB bundle. These deps
        // change far less often than app code, so separating them lets the
        // browser cache them across app releases and parallelize the fetch.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/node_modules/three/")) return "vendor-three";
          if (id.includes("/node_modules/@xyflow/")) return "vendor-reactflow";
          if (id.includes("/node_modules/@dagrejs/")) return "vendor-dagre";
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
});
