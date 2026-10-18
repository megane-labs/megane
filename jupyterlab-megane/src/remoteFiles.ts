/**
 * The JupyterLab host's remote file source: the Load nodes' "Open from
 * server..." dialog browses the Jupyter server's contents (the file browser's
 * tree) and reads the chosen file through the Contents API. The browser's own
 * file dialog only sees the computer the browser runs on, which is not where
 * the files are when JupyterLab runs on a remote machine.
 */

import type { Contents } from "@jupyterlab/services";
import type { BrowsableRemoteFileSource } from "@megane/remote/fileSource";
import { basename, dirname } from "./builder/contents";

export function createJupyterFileSource(
  contents: Pick<Contents.IManager, "get">,
  currentDir: () => string = () => "",
): BrowsableRemoteFileSource {
  return {
    mode: "browse",
    label: "Open from server...",
    initialPath: currentDir,
    async list(path) {
      const model = await contents.get(path, { content: true });
      if (model.type !== "directory") throw new Error(`Not a folder: ${path}`);
      const items = (model.content ?? []) as Contents.IModel[];
      const entries = items
        .map((item) => ({
          name: item.name,
          path: item.path,
          isDir: item.type === "directory",
          size: item.size ?? null,
        }))
        .sort((a, b) =>
          a.isDir !== b.isDir
            ? a.isDir
              ? -1
              : 1
            : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        );
      return { path: model.path, parent: model.path ? dirname(model.path) : null, entries };
    },
    async read(path) {
      const model = await contents.get(path, { content: true, format: "base64", type: "file" });
      const bytes = Uint8Array.from(atob(String(model.content ?? "")), (c) => c.charCodeAt(0));
      return new File([bytes], basename(path));
    },
  };
}
