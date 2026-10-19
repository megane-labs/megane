/**
 * The megane panel in JupyterLab's left sidebar: the way into megane Builder.
 *
 * It holds *Open Builder* (a new Builder tab), and the structure files in the
 * file browser's current folder, each opening in a Builder tab with a click.
 * The same files have *Open in megane Builder* in the file browser's context
 * menu.
 */

import { Widget } from "@lumino/widgets";
import { isBuilderPath } from "./contents";

/** What the panel needs from the app; `files` lists the folder the file browser shows. */
export interface BuilderSidebarOptions {
  openBuilder: () => void;
  openFile: (path: string) => void;
  /** The file browser's current folder and its entries, or null without a file browser. */
  folder: () => { path: string; items: { name: string; path: string; type: string }[] } | null;
}

export const BUILDER_SIDEBAR_ID = "megane-builder-sidebar";

export class BuilderSidebar extends Widget {
  private readonly list: HTMLElement;
  private readonly heading: HTMLElement;

  constructor(private readonly options: BuilderSidebarOptions) {
    super();
    this.id = BUILDER_SIDEBAR_ID;
    this.title.caption = "megane Builder";
    this.addClass("megane-builder-sidebar");
    this.node.style.cssText =
      "padding:12px;display:flex;flex-direction:column;gap:10px;overflow:auto;" +
      "font-size:var(--jp-ui-font-size1);color:var(--jp-ui-font-color1);" +
      "background:var(--jp-layout-color1)";

    const title = document.createElement("h2");
    title.textContent = "megane Builder";
    title.style.cssText = "margin:0;font-size:var(--jp-ui-font-size2);font-weight:600";
    const about = document.createElement("p");
    about.textContent =
      "Build and edit structures: add, delete and move atoms, draw bonds, build crystals " +
      "and save as XYZ, PDB or MOL into this folder tree.";
    about.style.cssText = "margin:0;color:var(--jp-ui-font-color2);line-height:1.4";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "jp-mod-styled jp-mod-accept";
    open.dataset.testid = "megane-builder-sidebar-open";
    open.textContent = "Open Builder";
    open.onclick = () => this.options.openBuilder();

    this.heading = document.createElement("div");
    this.heading.style.cssText = "margin-top:6px;font-weight:600;color:var(--jp-ui-font-color2)";
    this.list = document.createElement("ul");
    this.list.dataset.testid = "megane-builder-sidebar-files";
    this.list.style.cssText =
      "list-style:none;margin:0;padding:0;display:flex;flex-direction:column";

    this.node.append(title, about, open, this.heading, this.list);
    this.refresh();
  }

  /** Re-read the file browser's folder. */
  refresh(): void {
    const folder = this.options.folder();
    this.list.replaceChildren();
    if (!folder) {
      this.heading.textContent = "Right-click a structure file and choose Open in megane Builder.";
      return;
    }
    const files = folder.items
      .filter((item) => item.type !== "directory" && isBuilderPath(item.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.heading.textContent = files.length
      ? `Structures in /${folder.path}`
      : `No structure files in /${folder.path}`;
    for (const file of files) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jp-mod-styled";
      button.dataset.testid = "megane-builder-sidebar-file";
      button.dataset.path = file.path;
      button.title = `Open ${file.path} in megane Builder`;
      button.textContent = file.name;
      button.style.cssText =
        "width:100%;text-align:left;background:none;border:none;padding:4px 6px;" +
        "cursor:pointer;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      button.onclick = () => this.options.openFile(file.path);
      li.appendChild(button);
      this.list.appendChild(li);
    }
  }
}
