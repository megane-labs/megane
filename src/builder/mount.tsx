/**
 * Put megane Builder on a page: the one entry every host uses.
 *
 * `builder.html` mounts it on its root element; the VS Code webview, the
 * JupyterLab main-area tab and the Jupyter widget mount it on the element
 * their host gives them, with a `BuilderHost` that says how Save delivers a
 * file there (see `host.ts`).
 *
 * The Builder's document lives in a module-level store (`useBuilderStore`), so
 * a page holds one Builder document: two Builders mounted on the same page
 * would edit the same structure. Each host therefore keeps one mounted per
 * copy of the bundle (VS Code gives every panel a page of its own; JupyterLab
 * reveals its one Builder tab; anywidget loads the bundle once per `Builder`
 * object, and the newest output of an object takes its document).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThemeSync } from "../components/ThemeSync";
import { BuilderApp } from "./BuilderApp";
import { WEB_HOST, type BuilderHost } from "./host";
import { openStructureFile } from "./open";

export interface MountedBuilder {
  /** Open `file` as the document; resolves to whether it parsed. */
  open(file: File): Promise<boolean>;
  /** Unmount the app (the document stays in the store). */
  dispose(): void;
}

/** Render the Builder into `el`, which it fills. */
export function mountBuilder(el: HTMLElement, host: BuilderHost = WEB_HOST): MountedBuilder {
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <ErrorBoundary context="builder">
        <ThemeSync />
        <BuilderApp host={host} />
      </ErrorBoundary>
    </StrictMode>,
  );
  let disposed = false;
  return {
    open: (file) => openStructureFile(file),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      root.unmount();
    },
  };
}
