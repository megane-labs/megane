import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    // jupyterlab-megane/ has its own node_modules (React 18) once `npm run
    // build:lab` has run, while the root (and CI, which never installs it) is on
    // React 19. Resolve React from the root for every file so labextension
    // components rendered through @testing-library/react see one React copy.
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `@megane/*` is the webpack alias used by jupyterlab-megane to import from
      // the shared `src/` tree. Mirror it in vitest so jupyterlab-megane source
      // files can be imported directly in tests without mocking every module.
      "@megane": path.resolve(__dirname, "src"),
      "@jupyterlab/ui-components": path.resolve(
        __dirname,
        "tests/ts/__stubs__/jupyterlab-ui-components.ts",
      ),
      // The `@jupyterlab/*` packages live in jupyterlab-megane/package.json,
      // not the root, so vitest's import-analysis can't resolve bare specifiers
      // referenced by `jupyterlab-megane/src/`. Tests mock these via vi.mock();
      // the stubs only need to satisfy resolution, not provide behavior.
      "@jupyterlab/application": path.resolve(
        __dirname,
        "tests/ts/__stubs__/jupyterlab-application.ts",
      ),
      "@jupyterlab/apputils": path.resolve(__dirname, "tests/ts/__stubs__/jupyterlab-apputils.ts"),
      "@jupyterlab/coreutils": path.resolve(
        __dirname,
        "tests/ts/__stubs__/jupyterlab-coreutils.ts",
      ),
      "@jupyterlab/docregistry": path.resolve(
        __dirname,
        "tests/ts/__stubs__/jupyterlab-docregistry.ts",
      ),
      "@jupyterlab/filebrowser": path.resolve(
        __dirname,
        "tests/ts/__stubs__/jupyterlab-filebrowser.ts",
      ),
      "@jupyterlab/launcher": path.resolve(__dirname, "tests/ts/__stubs__/jupyterlab-launcher.ts"),
      "@jupyterlab/services": path.resolve(__dirname, "tests/ts/__stubs__/jupyterlab-services.ts"),
      "@jupyterlab/statusbar": path.resolve(
        __dirname,
        "tests/ts/__stubs__/jupyterlab-statusbar.ts",
      ),
      // `@lumino/widgets` is a peer dep of jupyterlab-megane but is not in the
      // root node_modules. The stub satisfies import resolution at test time.
      "@lumino/widgets": path.resolve(__dirname, "tests/ts/__stubs__/lumino-widgets.ts"),
      // `vscode` is injected by the VS Code extension host at runtime and is
      // not present in any node_modules. Tests mock it via vi.mock(); the stub
      // only needs to satisfy resolution.
      vscode: path.resolve(__dirname, "tests/ts/__stubs__/vscode.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/ts/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/ts/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json", "html", "lcov"],
      reportsDirectory: "coverage/ts",
      include: [
        "src/**/*.{ts,tsx}",
        "vscode-megane/src/**/*.ts",
        "jupyterlab-megane/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "src/vite-env.d.ts",
        "src/**/*.d.ts",
        "vscode-megane/src/**/*.d.ts",
        "jupyterlab-megane/src/**/*.d.ts",
      ],
    },
  },
});
