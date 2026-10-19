/**
 * VSCode webview entry point for megane Builder (the structure editor).
 *
 * The extension opens it in an editor tab from the megane view in the activity
 * bar (*New Structure*, *Open File in Builder…*) or from a structure file's
 * *Open in megane Builder* entry; in the last case it posts the file's bytes
 * (`openFile`) once the webview says it is ready. Save goes back to the
 * extension (`saveFile`), which asks where to write it with VS Code's save
 * dialog and answers with the name it was saved under (`saveResult`), or
 * null when the dialog was cancelled.
 *
 * The webview owns its page, so the keyboard shortcuts need no scope. The
 * *Tools* menu reaches MCP tool servers through the extension host (the
 * bridge, `vscode-megane/src/builderTools.ts`): a webview can neither start a
 * stdio server nor call a loopback one, so the host connects to the servers in
 * the `megane.builder.mcpServers` setting and relays the calls.
 */

import { mountBuilder } from "../../src/builder/mount";
import type { BuilderHost } from "../../src/builder/host";
import { createMessageBridge } from "../../src/builder/tools/bridge";
import { installCrossOriginWorker } from "../../src/utils/crossOriginWorker";
import "../../src/styles/megane.css";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

// RDKit's and Ketcher's workers are served from the extension's resource
// origin, which `new Worker` refuses from the webview's own origin.
installCrossOriginWorker();

const vscode = acquireVsCodeApi();

let nextSaveId = 0;
const pendingSaves = new Map<number, (said: string | null) => void>();

const host: BuilderHost = {
  save: (file) =>
    new Promise<string | null>((resolve) => {
      const id = nextSaveId++;
      pendingSaves.set(id, resolve);
      vscode.postMessage({
        type: "saveFile",
        id,
        filename: file.name,
        bytes: Array.from(new TextEncoder().encode(file.text)),
      });
    }),
  toolBridge: createMessageBridge(
    {
      post: (message) => vscode.postMessage(message),
      listen: (handler) => {
        const onMessage = (event: MessageEvent) => handler(event.data);
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      },
    },
    { configHint: "the megane.builder.mcpServers setting", openSettings: true },
  ),
};

const builder = mountBuilder(document.getElementById("root")!, host);

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as {
    type?: string;
    id?: number;
    path?: string | null;
    filename?: string;
    contentBytes?: ArrayBuffer;
  };
  if (message.type === "openFile" && message.contentBytes && message.filename) {
    void builder.open(new File([new Uint8Array(message.contentBytes)], message.filename));
  } else if (message.type === "saveResult" && typeof message.id === "number") {
    const resolve = pendingSaves.get(message.id);
    pendingSaves.delete(message.id);
    resolve?.(message.path ? `Saved ${message.path}` : null);
  }
});

vscode.postMessage({ type: "ready" });
