/**
 * megane Builder as a JupyterLab main-area tab.
 *
 * The Builder's document lives in a page-wide store, so JupyterLab has one
 * Builder tab: the commands reveal it, and opening a file replaces its
 * document as *File › Open…* inside the Builder does. Closing the tab drops the
 * document. The tab keeps the directory of the file it opened last, which is
 * where Save suggests writing.
 */

import { Widget } from "@lumino/widgets";
import { mountBuilder, type MountedBuilder } from "@megane/builder/mount";
import { openStructureFile } from "@megane/builder/open";
import { useBuilderStore } from "@megane/builder/store";
import type { BuilderSaveRequest } from "@megane/builder/host";

export const BUILDER_WIDGET_ID = "megane-builder";

export class BuilderWidget extends Widget {
  /** Directory of the file opened last ("" for none): where Save starts. */
  dir = "";
  private readonly target: HTMLElement;
  private mounted: MountedBuilder | null = null;

  constructor(private readonly save: (file: BuilderSaveRequest) => Promise<string | null>) {
    super();
    this.id = BUILDER_WIDGET_ID;
    this.title.label = "Megane Builder";
    this.title.caption = "Megane Builder: build and edit structures";
    this.title.closable = true;
    this.addClass("megane-builder-panel");
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
    return openStructureFile(file);
  }

  /** Mount the app the first time the tab is on the page. */
  protected onAfterAttach(): void {
    if (this.mounted) return;
    this.mounted = mountBuilder(this.target, {
      save: (file) => this.save(file),
      tools: false,
      scopeShortcuts: true,
    });
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.mounted?.dispose();
    this.mounted = null;
    useBuilderStore.getState().closeDocument();
    super.dispose();
  }
}
