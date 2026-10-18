/**
 * A native remote file source over `postMessage`, for hosts whose file dialog
 * lives on the other side of a message channel — the VS Code webview, where
 * the extension host calls `vscode.window.showOpenDialog`. Under VS Code
 * Remote and code-server that dialog browses the remote machine, while the
 * webview's own `<input type="file">` only sees the user's computer.
 *
 * Protocol: the page posts `{ type: "pickFile", id, kind, extensions }`; the
 * host answers `{ type: "pickFileResult", id, filename, contentBytes }` with
 * the file's bytes as an ArrayBuffer, `{ type: "pickFileResult", id }` when the
 * user cancels, or `{ type: "pickFileResult", id, error }` when reading fails.
 */

import type { NativeRemoteFileSource, RemoteFileRequest } from "./fileSource";

export interface PickFileMessage {
  type: "pickFile";
  id: number;
  kind: RemoteFileRequest["kind"];
  extensions: string[];
}

export interface PickFileResultMessage {
  type: "pickFileResult";
  id: number;
  filename?: string;
  contentBytes?: ArrayBuffer;
  error?: string;
}

export function createMessageFileSource(
  post: (message: PickFileMessage) => void,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  label = "Open from remote...",
): NativeRemoteFileSource {
  let nextId = 1;
  return {
    mode: "native",
    label,
    pick(request) {
      const id = nextId++;
      return new Promise<File | null>((resolve, reject) => {
        const onMessage = (event: Event) => {
          const data = (event as MessageEvent).data as PickFileResultMessage | undefined;
          if (!data || data.type !== "pickFileResult" || data.id !== id) return;
          target.removeEventListener("message", onMessage);
          if (data.error) reject(new Error(data.error));
          else if (data.filename && data.contentBytes)
            resolve(new File([new Uint8Array(data.contentBytes)], data.filename));
          else resolve(null);
        };
        target.addEventListener("message", onMessage);
        post({
          type: "pickFile",
          id,
          kind: request.kind,
          extensions: [...request.extensions],
        });
      });
    },
  };
}
