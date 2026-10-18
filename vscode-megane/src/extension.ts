import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { webcrypto } from "crypto";

interface SerializedPipelineNode {
  id: string;
  type: string;
  fileName?: string | null;
  [key: string]: unknown;
}

interface SerializedPipeline {
  version: number;
  nodes: SerializedPipelineNode[];
  edges: unknown[];
}

interface SaveFileMessage {
  filename: string;
  bytes: number[];
}

/**
 * File extensions megane Builder offers to open from the Explorer: the
 * structure formats with coordinates. Trajectory-only formats (XTC, DCD,
 * NetCDF), topologies without coordinates (prmtop), volumetric grids and
 * spectra are left out. VASP's extension-less POSCAR / CONTCAR / XDATCAR are
 * matched by name (`BUILDER_FILENAME_PREFIXES`). The `explorer/context` menu's
 * `when` clause in package.json mirrors both lists (checked by the tests).
 */
export const BUILDER_EXTENSIONS = [
  "pdb",
  "gro",
  "xyz",
  "extxyz",
  "jxyz",
  "mol",
  "sdf",
  "mol2",
  "cif",
  "mmcif",
  "data",
  "lammps",
  "lammpstrj",
  "dump",
  "trj",
  "traj",
  "vasp",
  "molden",
  "cml",
  "xsf",
  "axsf",
  "c3xml",
  "xodydata",
  "odydata",
  "magres",
  "gamess",
  "phonon",
];
export const BUILDER_FILENAME_PREFIXES = ["POSCAR", "CONTCAR", "XDATCAR"];

const SAVE_FILTERS: Record<string, [string, string[]]> = {
  glb: ["3D Model", ["glb"]],
  gltf: ["3D Model", ["gltf"]],
  obj: ["Wavefront OBJ", ["obj"]],
  png: ["PNG Image", ["png"]],
  svg: ["SVG Image", ["svg"]],
  eps: ["EPS Image", ["eps"]],
  gif: ["GIF Animation", ["gif"]],
  webm: ["WebM Video", ["webm"]],
  json: ["JSON", ["json"]],
  csv: ["CSV", ["csv"]],
};

/**
 * Save bytes posted from the webview (`{ type: "saveFile", filename, bytes }`).
 * Webviews cannot trigger `<a download>` saves, so exports (render output,
 * pipeline JSON, measurement CSV/JSON) are relayed here and written via the
 * workspace filesystem API. In E2E mode the native save dialog is skipped —
 * Playwright cannot drive it — and the file lands next to the open document.
 */
export async function handleSaveFileMessage(
  message: SaveFileMessage,
  documentUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  const { filename, bytes } = message;
  const defaultUri = vscode.Uri.file(path.join(path.dirname(documentUri.fsPath), filename));
  const ext = path.extname(filename).slice(1).toLowerCase();
  const entry = SAVE_FILTERS[ext];
  const filters = entry ? { [entry[0]]: entry[1] } : { "All Files": ["*"] };

  const target =
    process.env.MEGANE_E2E_MODE === "1"
      ? defaultUri
      : await vscode.window.showSaveDialog({ defaultUri, filters });

  if (!target) return undefined; // user cancelled the dialog
  try {
    await vscode.workspace.fs.writeFile(target, new Uint8Array(bytes));
    void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
    return target;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to save file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

interface PickFileMessage {
  id: number;
  kind?: string;
  extensions?: string[];
}

/**
 * Whether the webview's own `<input type="file">` sees a different machine
 * than the workspace: under VS Code Remote (SSH, WSL, containers, Codespaces)
 * and in the browser (code-server, vscode.dev) the dialog it opens browses the
 * user's computer while the files live on the remote side. The Load nodes then
 * also offer "Open from remote...", answered by `handlePickFileMessage`.
 */
export function workspaceIsRemote(): boolean {
  const env = vscode.env as { remoteName?: string; uiKind?: number } | undefined;
  const web = (vscode as { UIKind?: { Web?: number } }).UIKind?.Web;
  return env?.remoteName !== undefined || (web !== undefined && env?.uiKind === web);
}

/**
 * Answer a webview's `{ type: "pickFile" }` (a Load node's "Open from
 * remote..."): show VS Code's open dialog, which browses the workspace's
 * machine, starting beside `documentUri`, and post the chosen file's bytes
 * back as `pickFileResult` (no file when cancelled, `error` when it can't be
 * read). The protocol's page side is `src/remote/messageFiles.ts`.
 */
export async function handlePickFileMessage(
  message: PickFileMessage,
  documentUri: vscode.Uri,
  webview: Pick<vscode.Webview, "postMessage">,
): Promise<void> {
  const { id } = message;
  const exts = (message.extensions ?? []).map((e) => e.replace(/^\./, "")).filter(Boolean);
  const label = message.kind === "trajectory" ? "Trajectory files" : "Structure files";
  const filters: Record<string, string[]> = exts.length
    ? { [label]: exts, "All files": ["*"] }
    : { "All files": ["*"] };
  try {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Load",
      defaultUri: vscode.Uri.joinPath(documentUri, ".."),
      filters,
    });
    const uri = picked?.[0];
    if (!uri) {
      void webview.postMessage({ type: "pickFileResult", id });
      return;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    void webview.postMessage({
      type: "pickFileResult",
      id,
      filename: path.basename(uri.fsPath),
      contentBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  } catch (err) {
    void webview.postMessage({
      type: "pickFileResult",
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

class MeganePipelineEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = "megane.pipelineViewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MeganePipelineEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      MeganePipelineEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, "media");

    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaDir],
    };

    let payload: object;
    try {
      // The WASM module is fetched by the webview directly via the
      // asWebviewUri set in getHtmlForWebview (window.__MEGANE_WASM_URL__), so
      // we no longer read + serialize the whole .wasm into the message payload.
      const pipelineData = await vscode.workspace.fs.readFile(document.uri);
      const pipeline = JSON.parse(
        new TextDecoder("utf-8").decode(pipelineData),
      ) as SerializedPipeline;

      if (pipeline.version !== 3) {
        throw new Error(
          `Not a valid megane pipeline file (version 3 required, got ${pipeline.version})`,
        );
      }

      const dir = path.dirname(document.uri.fsPath);

      // Read structure files referenced by load_structure nodes
      const structureFiles: Array<{ nodeId: string; content: string; filename: string }> = [];
      // Read trajectory files referenced by load_trajectory nodes (binary as ArrayBuffer)
      const trajectoryFiles: Array<{ nodeId: string; content: ArrayBuffer; filename: string }> = [];

      for (const node of pipeline.nodes) {
        if (!node.fileName) continue;
        const filePath = String(node.fileName);

        // Reject absolute paths and paths that escape the pipeline file's directory
        if (path.isAbsolute(filePath)) {
          continue;
        }
        const resolvedPath = path.resolve(dir, filePath);
        if (!(resolvedPath === dir || resolvedPath.startsWith(dir + path.sep))) {
          continue;
        }

        const fileUri = vscode.Uri.file(resolvedPath);
        const filename = path.basename(filePath);
        try {
          if (node.type === "load_structure") {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            structureFiles.push({
              nodeId: node.id,
              content: new TextDecoder("utf-8").decode(raw),
              filename,
            });
          } else if (node.type === "load_trajectory") {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            trajectoryFiles.push({ nodeId: node.id, content: raw.buffer as ArrayBuffer, filename });
          }
        } catch {
          // File not found — skip silently; webview will show a warning on the node
        }
      }

      payload = {
        type: "loadPipeline",
        pipeline,
        structureFiles,
        trajectoryFiles,
      };
    } catch (err) {
      payload = { type: "error", message: err instanceof Error ? err.message : String(err) };
    }

    webview.onDidReceiveMessage((message) => {
      if (message.type === "ready") {
        webview.postMessage(payload);
        return;
      }
      if (message.type === "saveFile") {
        void handleSaveFileMessage(message as SaveFileMessage, document.uri);
        return;
      }
      if (message.type === "pickFile") {
        void handlePickFileMessage(message as PickFileMessage, document.uri, webview);
      }
    });

    webview.html = getHtmlForWebview(webview, mediaDir);
  }
}

export function createFrameStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.tooltip = "Current trajectory frame";
  return item;
}

export function createSelectionStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.tooltip = "Current atom selection or measurement";
  return item;
}

export class MeganeEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = "megane.structureViewer";
  private activePanel: vscode.WebviewPanel | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Programmatically seek the active megane viewer to a trajectory frame.
   * Returns `true` if a panel was active and the message was posted, `false` otherwise.
   */
  seekFrame(frame: number): boolean {
    if (!this.activePanel) return false;
    this.activePanel.webview.postMessage({ type: "seekFrame", frame });
    return true;
  }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, "media");

    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaDir],
    };

    // Prepare the message to send, then register handler, then set HTML.
    // This avoids both: (a) race where "ready" fires before handler, and
    // (b) blank screen if file reading fails before HTML is set.
    let payload: object;
    try {
      // Read only the document file. The WASM module is fetched by the webview
      // directly via the asWebviewUri set in getHtmlForWebview
      // (window.__MEGANE_WASM_URL__), so we no longer read + serialize the whole
      // .wasm into the message payload.
      const fileData = await vscode.workspace.fs.readFile(document.uri);
      // Send raw bytes (not decoded text) so binary formats like .traj survive
      // the trip into the webview. The webview builds a File and the shared
      // parser dispatches by extension to either text() or arrayBuffer().
      // Transfer the bytes as an ArrayBuffer (structured clone) rather than a
      // plain number[]; a number[] is JSON-serialized by postMessage and
      // inflates ~4-6x, which dominated the open latency for large files.
      const filename = path.basename(document.uri.fsPath);
      let topBytes: ArrayBuffer | null = null;
      let topFilename: string | null = null;
      if (filename.toLowerCase().endsWith(".gro")) {
        const stem = filename.slice(0, filename.lastIndexOf("."));
        const topName = stem + ".top";
        const topUri = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), topName));
        try {
          const topData = await vscode.workspace.fs.readFile(topUri);
          topBytes = topData.buffer as ArrayBuffer;
          topFilename = topName;
        } catch {
          // .top file not found — proceed without topology bonds
        }
      }
      payload = {
        type: "loadFile",
        contentBytes: fileData.buffer as ArrayBuffer,
        filename,
        topBytes,
        topFilename,
      };
    } catch (err) {
      payload = { type: "error", message: err instanceof Error ? err.message : String(err) };
    }

    const frameStatusBar = createFrameStatusBarItem();

    const selectionStatusBar = createSelectionStatusBarItem();

    this.activePanel = webviewPanel;
    webviewPanel.onDidChangeViewState(({ webviewPanel: panel }) => {
      if (panel.active) this.activePanel = panel;
    });

    webview.onDidReceiveMessage((message) => {
      if (message.type === "ready") {
        webview.postMessage(payload);
        return;
      }
      if (message.type === "saveFile") {
        void handleSaveFileMessage(message as SaveFileMessage, document.uri);
        return;
      }
      if (message.type === "pickFile") {
        void handlePickFileMessage(message as PickFileMessage, document.uri, webview);
        return;
      }
      if (message.type === "frameChange") {
        const frame = message.frame as number;
        frameStatusBar.text = `$(megane-frame) Frame ${frame}`;
        frameStatusBar.show();
        return;
      }
      if (message.type === "selectionChange") {
        const atoms = (message.selection as { atoms: number[] }).atoms;
        if (atoms.length === 0) {
          selectionStatusBar.hide();
        } else {
          selectionStatusBar.text = `$(megane-atom) ${atoms.length} atom${atoms.length === 1 ? "" : "s"} selected`;
          selectionStatusBar.show();
        }
        return;
      }
      if (message.type === "measurementChange") {
        const measurement = message.measurement as {
          type: string;
          value: number;
          label: string;
        } | null;
        if (!measurement) {
          selectionStatusBar.hide();
        } else {
          selectionStatusBar.text = `$(megane-atom) ${measurement.label}`;
          selectionStatusBar.show();
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) this.activePanel = null;
      frameStatusBar.dispose();
      selectionStatusBar.dispose();
    });

    webview.html = getHtmlForWebview(webview, mediaDir);
  }
}

/**
 * A URI in the folder the Builder's save dialog should start in: beside the
 * file the Builder was opened from, else the first workspace folder, else the
 * home directory. Only its directory is used (`handleSaveFileMessage`).
 */
export function builderSaveBase(file: vscode.Uri | undefined): vscode.Uri {
  if (file) return file;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) return vscode.Uri.joinPath(folder.uri, "untitled");
  return vscode.Uri.file(path.join(os.homedir(), "untitled"));
}

/** The file of the editor in front (a text editor or a megane viewer tab), if any. */
function activeFileUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input as
    | { uri?: vscode.Uri }
    | undefined;
  return input?.uri ?? vscode.window.activeTextEditor?.document.uri;
}

/**
 * megane Builder (the structure editor) in editor tabs.
 *
 * Opened from the megane view in the activity bar (*New Structure*, *Open File
 * in Builder…*), from a structure file's *Open in megane Builder* entry in the
 * Explorer, or from the button in a megane viewer tab's title bar. A file is
 * opened in one Builder tab: asking again reveals it. Each tab is its own
 * webview, so tabs do not share a document.
 */
export class MeganeBuilderPanels {
  static readonly viewType = "megane.builder";
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Open a Builder tab, on `file` when given (revealing its tab if it has one). */
  open(file?: vscode.Uri): vscode.WebviewPanel {
    const key = file?.toString();
    const existing = key ? this.panels.get(key) : undefined;
    if (existing) {
      existing.reveal();
      return existing;
    }
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const title = file ? `${path.basename(file.fsPath)} — Builder` : "megane Builder";
    const panel = vscode.window.createWebviewPanel(
      MeganeBuilderPanels.viewType,
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaDir] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "megane.svg");
    if (key) this.panels.set(key, panel);

    const webview = panel.webview;
    webview.onDidReceiveMessage(async (message: { type?: string; id?: number }) => {
      if (message.type === "ready") {
        if (!file) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(file);
          void webview.postMessage({
            type: "openFile",
            contentBytes: bytes.buffer as ArrayBuffer,
            filename: path.basename(file.fsPath),
          });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `megane Builder could not read ${path.basename(file.fsPath)}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return;
      }
      if (message.type === "saveFile") {
        const target = await handleSaveFileMessage(
          message as unknown as SaveFileMessage,
          builderSaveBase(file),
        );
        void webview.postMessage({
          type: "saveResult",
          id: message.id,
          path: target ? path.basename(target.fsPath) : null,
        });
      }
    });
    panel.onDidDispose(() => {
      if (key && this.panels.get(key) === panel) this.panels.delete(key);
    });
    webview.html = getBuilderHtml(webview, mediaDir);
    return panel;
  }

  /** Ask for a structure file and open it in a Builder tab. */
  async openFromDialog(): Promise<vscode.WebviewPanel | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Open in Builder",
      filters: { "Structure files": BUILDER_EXTENSIONS, "All files": ["*"] },
    });
    return picked?.[0] ? this.open(picked[0]) : undefined;
  }

  /**
   * *Open in megane Builder*: the file the Explorer or a title bar passed, else
   * the file of the editor in front, else ask for one.
   */
  async openFile(uri?: vscode.Uri): Promise<vscode.WebviewPanel | undefined> {
    const file = uri instanceof vscode.Uri ? uri : activeFileUri();
    return file ? this.open(file) : this.openFromDialog();
  }
}

/** The welcome view in the megane activity-bar container: an empty tree shows its buttons. */
class EmptyTree implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }
  getChildren(): never[] {
    return [];
  }
}

/**
 * The Builder webview's page. Its bundle is split into chunks (Ketcher loads
 * on demand), so the CSP admits scripts from the extension's resource origin
 * besides the nonce'd entry. Workers start from blob: bootstraps that import
 * their scripts from there (see `src/utils/crossOriginWorker.ts`); a module
 * worker's imports are checked against `worker-src`, which therefore lists
 * the resource origin too. RDKit (Emscripten + embind) builds its call
 * wrappers with `new Function`, and its worker inherits this page's policy, so
 * this page — unlike the viewer's — also allows `'unsafe-eval'`. It runs only
 * the extension's own bundle; opened files are parsed by WASM, never evaluated.
 */
export function getBuilderHtml(webview: vscode.Webview, mediaDir: vscode.Uri): string {
  const builderDir = vscode.Uri.joinPath(mediaDir, "builder");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(builderDir, "builder.js"));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(builderDir, "builder.css"));
  const nonce = getNonce();
  const e2eMode = process.env.MEGANE_E2E_MODE === "1";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval' 'unsafe-eval' blob:;
             style-src ${webview.cspSource} 'unsafe-inline';
             img-src ${webview.cspSource} data: blob:;
             font-src ${webview.cspSource} data:;
             connect-src ${webview.cspSource} blob: data:;
             worker-src blob: ${webview.cspSource};" />
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__MEGANE_CONTEXT__ = "vscode";
    ${e2eMode ? "window.__MEGANE_TEST__ = true;" : ""}
  </script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function getHtmlForWebview(webview: vscode.Webview, mediaDir: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, "webview.js"));
  const wasmUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, "megane_wasm_bg.wasm"));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, "main.css"));
  const nonce = getNonce();
  // E2E test-mode flag — gated on MEGANE_E2E_MODE in the extension host's
  // environment so production builds don't expose it. Setting
  // window.__MEGANE_TEST__ before the bundle loads switches the megane
  // renderer into deterministic mode (see src/renderer/MoleculeRenderer.ts).
  const e2eMode = process.env.MEGANE_E2E_MODE === "1";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' 'wasm-unsafe-eval' blob:;
             style-src ${webview.cspSource} 'unsafe-inline';
             img-src ${webview.cspSource} data: blob:;
             font-src ${webview.cspSource};
             connect-src ${webview.cspSource} blob: data:;
             worker-src blob:;" />
  <link rel="stylesheet" href="${cssUri}" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #root {
      width: 100%; height: 100%; overflow: hidden;
      font-family: Inter, system-ui, -apple-system, sans-serif;
      background: #ffffff;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__MEGANE_WASM_URL__ = "${wasmUri}";
    window.__MEGANE_CONTEXT__ = "vscode";
    ${workspaceIsRemote() ? "window.__MEGANE_REMOTE_FILES__ = true;" : ""}
    ${e2eMode ? "window.__MEGANE_TEST__ = true;" : ""}
  </script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  // The nonce backs the webview CSP (`script-src 'nonce-...'`), so it must be
  // unpredictable. Use a CSPRNG (webcrypto) rather than Math.random().
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  let text = "";
  for (let i = 0; i < bytes.length; i++) {
    text += chars.charAt(bytes[i] % chars.length);
  }
  return text;
}

export function activate(context: vscode.ExtensionContext) {
  const editorProvider = new MeganeEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(MeganeEditorProvider.viewType, editorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );
  context.subscriptions.push(MeganePipelineEditorProvider.register(context));
  context.subscriptions.push(
    vscode.commands.registerCommand("megane.seekFrame", (frame: number) => {
      editorProvider.seekFrame(frame);
    }),
  );

  // megane Builder: the activity-bar view and its commands.
  const builder = new MeganeBuilderPanels(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("megane.builderView", new EmptyTree()),
    vscode.commands.registerCommand("megane.builder.new", () => builder.open()),
    vscode.commands.registerCommand("megane.builder.open", () => builder.openFromDialog()),
    vscode.commands.registerCommand("megane.builder.openFile", (uri?: vscode.Uri) =>
      builder.openFile(uri),
    ),
  );
}

export function deactivate() {}
