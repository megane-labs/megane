/**
 * megane Builder as a JupyterLab main-area tab.
 *
 * Every tab edits a document of its own (`createBuilderStores()`), so the
 * commands open as many as asked for, as VS Code does. Opening a file replaces
 * the tab's document as *File › Open…* inside the Builder does; closing the
 * tab drops it. The tab keeps the directory of the file it opened last, which
 * is where Save suggests writing. With a `toolBridge` (its own connection to
 * the Jupyter server's tool servers, `tools.ts`), the tab has the *Tools* menu;
 * closing the tab closes that connection, so a tool server it alone used stops.
 */

import { Widget } from "@lumino/widgets";
import { createBuilderStores, type BuilderStores } from "@megane/builder/BuilderStores";
import { mountBuilder, type MountedBuilder } from "@megane/builder/mount";
import { openStructureFile } from "@megane/builder/open";
import type { BuilderSaveRequest } from "@megane/builder/host";
import type { JupyterToolBridge } from "./tools";

/** The class of every Builder tab; each has its own id. */
export const BUILDER_WIDGET_CLASS = "megane-builder-panel";

let nextTab = 1;

export class BuilderWidget extends Widget {
  /** Directory of the file opened last ("" for none): where Save starts. */
  dir = "";
  readonly stores: BuilderStores = createBuilderStores();
  private readonly target: HTMLElement;
  private mounted: MountedBuilder | null = null;

  constructor(
    private readonly save: (file: BuilderSaveRequest) => Promise<string | null>,
    private readonly toolBridge: JupyterToolBridge | null = null,
  ) {
    super();
    this.id = `megane-builder-${nextTab++}`;
    this.title.label = "megane Builder";
    this.title.caption = "megane Builder: build and edit structures";
    this.title.closable = true;
    this.addClass(BUILDER_WIDGET_CLASS);
    // The Builder's own keys (tools, Undo, Save) win over JupyterLab's while
    // the focus is in it; outside it, the Builder ignores keys (scopeShortcuts).
    this.node.dataset.lmSuppressShortcuts = "true";
    this.node.style.overflow = "hidden";
    this.target = document.createElement("div");
    this.target.style.cssText = "position:relative;width:100%;height:100%";
    this.node.appendChild(this.target);
  }

  /** Open `file` (read from `dir`) as the document. */
  open(file: File, dir: string): Promise<boolean> {
    this.dir = dir;
    return openStructureFile(file, this.stores.builder);
  }

  /** Mount the app the first time the tab is on the page. */
  protected onAfterAttach(): void {
    if (this.mounted) return;
    this.mounted = mountBuilder(
      this.target,
      {
        save: (file) => this.save(file),
        tools: !!this.toolBridge,
        toolBridge: this.toolBridge ?? undefined,
        scopeShortcuts: true,
      },
      this.stores,
    );
  }

  /**
   * Closing the tab disposes it. A plain Widget is only detached on close, so
   * the commands would keep revealing a tab that is no longer in the shell.
   */
  protected onCloseRequest(msg: import("@lumino/messaging").Message): void {
    super.onCloseRequest(msg);
    this.dispose();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.mounted?.dispose();
    this.mounted = null;
    this.stores.builder.getState().closeDocument();
    this.toolBridge?.dispose();
    super.dispose();
  }
}
