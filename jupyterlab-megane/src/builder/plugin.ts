/**
 * megane Builder in JupyterLab.
 *
 * - The **megane panel** in the left sidebar (`BuilderSidebar`) opens the
 *   Builder tab and lists the structure files of the file browser's folder.
 * - **Open in Megane Builder** on structure files in the file browser's
 *   context menu, and **megane Builder** in the launcher and the command
 *   palette.
 * - Each Builder is a main-area tab (`BuilderWidget`) with a document of its
 *   own. *megane Builder* (and *Open Builder*) opens a new tab every time; a
 *   file opens in one tab, and asking for it again reveals that tab, as in
 *   VS Code. Save writes into the server's contents, suggesting the folder of
 *   the file the tab opened (else the file browser's folder), and asks before
 *   replacing a file.
 */

import {
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import {
  Dialog,
  ICommandPalette,
  InputDialog,
  Notification,
  showDialog,
} from "@jupyterlab/apputils";
import { IDefaultFileBrowser } from "@jupyterlab/filebrowser";
import { ILauncher } from "@jupyterlab/launcher";
import type { BuilderSaveRequest } from "@megane/builder/host";
import { BuilderWidget } from "./BuilderWidget";
import { BuilderSidebar, BUILDER_SIDEBAR_ID } from "./sidebar";
import {
  basename,
  dirname,
  isBuilderPath,
  readContentsFile,
  saveToContents,
  type SavePrompts,
} from "./contents";
import { meganeIcon } from "./icon";

export const CommandIDs = {
  openBuilder: "megane:open-builder",
  openInBuilder: "megane:open-in-builder",
} as const;

/** The parts of the default file browser the Builder uses. */
export interface FileBrowserLike {
  model: {
    path: string;
    items(): Iterable<{ name: string; path: string; type: string }>;
    pathChanged: { connect(fn: () => void): void };
    refreshed: { connect(fn: () => void): void };
  };
  selectedItems(): Iterable<{ path: string; type: string }>;
}

/** Save's questions, asked with JupyterLab's dialogs. */
export const dialogPrompts: SavePrompts = {
  async path(defaultPath) {
    const result = await InputDialog.getText({
      title: "Save structure",
      label: "Path (relative to the Jupyter root)",
      text: defaultPath,
      okLabel: "Save",
    });
    return result.button.accept ? result.value : null;
  },
  async overwrite(path) {
    const result = await showDialog({
      title: "Replace file?",
      body: `${path} already exists. Replace it?`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: "Replace" })],
    });
    return result.button.accept;
  },
};

export function activateBuilder(
  app: JupyterFrontEnd,
  restorer: ILayoutRestorer | null,
  browser: FileBrowserLike | null,
  launcher: ILauncher | null,
  palette: ICommandPalette | null,
  prompts: SavePrompts = dialogPrompts,
): void {
  const contents = app.serviceManager.contents;
  /** The tab each file was opened in. */
  const tabsByPath = new Map<string, BuilderWidget>();

  /** A new Builder tab in the main area, brought to front. */
  const addBuilder = (label?: string): BuilderWidget => {
    const tab: BuilderWidget = new BuilderWidget((file: BuilderSaveRequest) =>
      saveToContents(contents, file, tab.dir || browser?.model.path || "", prompts),
    );
    tab.title.icon = meganeIcon;
    if (label) tab.title.label = label;
    app.shell.add(tab, "main");
    app.shell.activateById(tab.id);
    return tab;
  };

  /** The structure file selected in the file browser, if one is. */
  const selectedPath = (): string | null => {
    if (!browser) return null;
    for (const item of browser.selectedItems()) {
      if (item.type !== "directory" && isBuilderPath(item.path)) return item.path;
    }
    return null;
  };

  app.commands.addCommand(CommandIDs.openBuilder, {
    label: "Megane Builder",
    caption: "Build and edit molecular structures",
    icon: meganeIcon,
    execute: () => {
      addBuilder();
    },
  });

  app.commands.addCommand(CommandIDs.openInBuilder, {
    label: "Open in Megane Builder",
    caption: "Edit this structure in Megane Builder",
    icon: meganeIcon,
    isVisible: (args) => !!((args.path as string | undefined) ?? selectedPath()),
    execute: async (args) => {
      const path = (args.path as string | undefined) ?? selectedPath();
      if (!path) {
        Notification.warning("Select a structure file in the file browser first.", {
          autoClose: 4000,
        });
        return;
      }
      const opened = tabsByPath.get(path);
      if (opened && !opened.isDisposed) {
        app.shell.activateById(opened.id);
        return;
      }
      const tab = addBuilder(`${basename(path)} — Builder`);
      tabsByPath.set(path, tab);
      try {
        const file = await readContentsFile(contents, path);
        await tab.open(file, dirname(path));
      } catch (err) {
        tab.dispose();
        Notification.error(
          `Megane Builder could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
          { autoClose: 6000 },
        );
      }
    },
  });

  app.contextMenu.addItem({
    command: CommandIDs.openInBuilder,
    selector: '.jp-DirListing-item[data-isdir="false"]',
    rank: 3,
  });

  launcher?.add({ command: CommandIDs.openBuilder, category: "Other", rank: 10 });
  palette?.addItem({ command: CommandIDs.openBuilder, category: "Megane" });
  palette?.addItem({ command: CommandIDs.openInBuilder, category: "Megane" });

  const sidebar = new BuilderSidebar({
    openBuilder: () => void app.commands.execute(CommandIDs.openBuilder),
    openFile: (path) => void app.commands.execute(CommandIDs.openInBuilder, { path }),
    folder: () =>
      browser ? { path: browser.model.path, items: [...browser.model.items()] } : null,
  });
  sidebar.title.icon = meganeIcon;
  app.shell.add(sidebar, "left", { rank: 850 });
  restorer?.add(sidebar, BUILDER_SIDEBAR_ID);
  browser?.model.pathChanged.connect(() => sidebar.refresh());
  browser?.model.refreshed.connect(() => sidebar.refresh());
}

export const builderPlugin: JupyterFrontEndPlugin<void> = {
  id: "megane-jupyterlab:builder",
  description:
    "Megane Builder (structure editor): a Megane panel in the left sidebar, a launcher item and " +
    "an Open in Megane Builder entry on structure files",
  autoStart: true,
  optional: [ILayoutRestorer, IDefaultFileBrowser, ILauncher, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    restorer: ILayoutRestorer | null,
    browser: FileBrowserLike | null,
    launcher: ILauncher | null,
    palette: ICommandPalette | null,
  ) => activateBuilder(app, restorer, browser, launcher, palette),
};
