/**
 * Put megane Builder on a page: the one entry every host uses.
 *
 * `builder.html` mounts it on its root element; the VS Code webview, the
 * JupyterLab main-area tab and the Jupyter widget mount it on the element
 * their host gives them, with a `BuilderHost` that says how Save delivers a
 * file there (see `host.ts`).
 *
 * A Builder mounted with a `BuilderStores` bundle edits that bundle's
 * document, so several can share a page (JupyterLab opens a tab per Builder,
 * each with `createBuilderStores()`). Without one it edits the page-wide
 * document (`useBuilderStore`): `builder.html` and the VS Code webview hold
 * one Builder per page, and anywidget loads the bundle once per `Builder`
 * object, whose newest output takes its document.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThemeSync } from "../components/ThemeSync";
import { BuilderApp } from "./BuilderApp";
import { BuilderProvider, type BuilderStores } from "./BuilderStores";
import { WEB_HOST, type BuilderHost } from "./host";
import { openStructureFile } from "./open";

export interface MountedBuilder {
  /** Open `file` as the document; resolves to whether it parsed. */
  open(file: File): Promise<boolean>;
  /** Unmount the app (the document stays in the store). */
  dispose(): void;
}

/** Render the Builder into `el`, which it fills, editing `stores`' document when given. */
export function mountBuilder(
  el: HTMLElement,
  host: BuilderHost = WEB_HOST,
  stores?: BuilderStores,
): MountedBuilder {
  const root = createRoot(el);
  const app = <BuilderApp host={host} />;
  root.render(
    <StrictMode>
      <ErrorBoundary context="builder">
        <ThemeSync />
        {stores ? <BuilderProvider stores={stores}>{app}</BuilderProvider> : app}
      </ErrorBoundary>
    </StrictMode>,
  );
  let disposed = false;
  return {
    open: (file) => openStructureFile(file, stores?.builder),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      root.unmount();
    },
  };
}
