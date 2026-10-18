/**
 * What the page hosting megane Builder provides, and what it leaves out.
 *
 * The Builder runs as its own web page (`builder.html`) and, embedded, inside
 * the VS Code extension (an editor tab opened from the megane activity-bar
 * view), the JupyterLab extension (a main-area tab opened from the megane
 * left sidebar) and the Jupyter widget (`megane.Builder()` in a notebook).
 * Each host differs in three ways the app has to know about:
 *
 * - **Save.** The web app downloads the file. A host with a file system of its
 *   own writes it there instead: VS Code through its save dialog, JupyterLab
 *   into the server's contents, the Jupyter widget into the kernel's working
 *   directory. `save` receives the file and resolves to the notice to show
 *   (`Saved …`), or null when the user cancelled.
 * - **Keyboard.** The web app owns the window, so the tool keys work wherever
 *   the focus is. Embedded, the Builder shares the page with an IDE, so with
 *   `scopeShortcuts` the keys only act while the focus is inside the Builder.
 * - **Optional parts.** The Python tools menu needs a reachable MCP tool server
 *   (`tools`), which only the web app can count on.
 *
 * `BuilderApp` takes the host as a prop; `mountBuilder` (`mount.tsx`) is how a
 * host puts the app on a page.
 */

import type { StructureWriteFormat } from "../parsers/parseCore";

/** A file Save produced, for the host to deliver. */
export interface BuilderSaveRequest {
  /** File name, e.g. `caffeine.xyz` for a document opened from `caffeine.sdf`. */
  name: string;
  /** The file's contents (every format the Builder writes is text). */
  text: string;
  format: StructureWriteFormat;
}

export interface BuilderHost {
  /**
   * Deliver a saved file. Resolves to the notice to show (e.g. `Saved
   * caffeine.xyz`), or null / undefined when the user cancelled and nothing
   * should be said. A rejection is reported as an error notice. Without it,
   * Save downloads the file (`downloadBlob`).
   */
  save?: (file: BuilderSaveRequest) => Promise<string | null | void>;
  /** Show the *Tools* menu (MCP tool servers). Default true. */
  tools?: boolean;
  /** Only handle keyboard shortcuts while the focus is inside the Builder. Default false. */
  scopeShortcuts?: boolean;
}

/** The standalone web app: download on Save, every part on, window-wide keys. */
export const WEB_HOST: BuilderHost = {};

/** Whether the host shows the Tools menu. */
export function hostHasTools(host: BuilderHost): boolean {
  return host.tools !== false;
}
