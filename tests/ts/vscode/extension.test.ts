import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { webcrypto } from "crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface FakeProvider {
  openCustomDocument: (
    uri: FakeUri,
    openContext: unknown,
    token: unknown,
  ) => { uri: FakeUri; dispose: () => void };
  resolveCustomEditor: (
    document: { uri: FakeUri; dispose: () => void },
    webviewPanel: FakeWebviewPanel,
    token: unknown,
  ) => Promise<void>;
}

interface RegisteredProvider {
  viewType: string;
  provider: FakeProvider;
  options: {
    webviewOptions?: { retainContextWhenHidden?: boolean };
    supportsMultipleEditorsPerDocument?: boolean;
  };
}

interface FakeUri {
  scheme: string;
  authority: string;
  path: string;
  fsPath: string;
  toString(): string;
}

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  onDidReceiveMessage: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  asWebviewUri: (uri: FakeUri) => string;
}

interface FakeStatusBarItem {
  tooltip: string;
  text: string;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeWebviewPanel {
  webview: FakeWebview;
  onDidDispose: ReturnType<typeof vi.fn>;
  onDidChangeViewState: ReturnType<typeof vi.fn>;
  active: boolean;
}

interface RegisteredCommand {
  command: string;
  handler: (...args: unknown[]) => unknown;
}

const { mockState } = vi.hoisted(() => ({
  mockState: {
    registered: [] as RegisteredProvider[],
    registeredCommands: [] as RegisteredCommand[],
    readFile: vi.fn<(uri: FakeUri) => Promise<Uint8Array>>(),
    writeFile: vi.fn<(uri: FakeUri, content: Uint8Array) => Promise<void>>(),
    showSaveDialog: vi.fn<(options?: unknown) => Promise<FakeUri | undefined>>(),
    showInformationMessage: vi.fn<(message: string) => Promise<undefined>>(),
    showErrorMessage: vi.fn<(message: string) => Promise<undefined>>(),
    statusBarItems: [] as FakeStatusBarItem[],
    createdPanels: [] as Array<{
      viewType: string;
      title: string;
      column: unknown;
      options: {
        enableScripts?: boolean;
        retainContextWhenHidden?: boolean;
        localResourceRoots?: FakeUri[];
      };
      panel: FakeBuilderPanel;
    }>,
    treeProviders: [] as Array<{
      id: string;
      provider: { getChildren(): unknown[]; getTreeItem(x: unknown): unknown };
    }>,
    showOpenDialog: vi.fn<(options?: unknown) => Promise<FakeUri[] | undefined>>(),
    workspaceFolders: undefined as Array<{ uri: FakeUri }> | undefined,
    activeTabInput: undefined as { uri?: FakeUri } | undefined,
    activeTextEditorUri: undefined as FakeUri | undefined,
    remoteName: undefined as string | undefined,
    uiKind: 1,
  },
}));

interface FakeBuilderPanel {
  webview: FakeWebview;
  iconPath?: unknown;
  reveal: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  fireMessage: (msg: unknown) => Promise<void>;
  fireDispose: () => void;
}

vi.mock("vscode", () => {
  class Uri {
    scheme: string;
    authority: string;
    path: string;
    constructor(scheme = "", authority = "", path = "") {
      this.scheme = scheme;
      this.authority = authority;
      this.path = path;
    }
    get fsPath(): string {
      return this.path;
    }
    static file(p: string): Uri {
      return new Uri("file", "", p);
    }
    static joinPath(base: Uri, ...segs: string[]): Uri {
      const trimmed = base.path.replace(/\/+$/, "");
      const joined = [trimmed, ...segs].filter((s) => s.length > 0).join("/");
      return new Uri(base.scheme, base.authority, joined);
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }
  return {
    Uri,
    UIKind: { Desktop: 1, Web: 2 },
    env: {
      get remoteName() {
        return mockState.remoteName;
      },
      get uiKind() {
        return mockState.uiKind;
      },
    },
    ViewColumn: { Active: -1 },
    workspace: {
      fs: { readFile: mockState.readFile, writeFile: mockState.writeFile },
      get workspaceFolders() {
        return mockState.workspaceFolders;
      },
    },
    window: {
      get tabGroups() {
        return { activeTabGroup: { activeTab: { input: mockState.activeTabInput } } };
      },
      get activeTextEditor() {
        return mockState.activeTextEditorUri
          ? { document: { uri: mockState.activeTextEditorUri } }
          : undefined;
      },
      showOpenDialog: mockState.showOpenDialog,
      registerTreeDataProvider: vi.fn((id: string, provider: never) => {
        mockState.treeProviders.push({ id, provider });
        return { dispose: vi.fn() };
      }),
      createWebviewPanel: vi.fn(
        (viewType: string, title: string, column: unknown, options: never) => {
          let onMessage: ((m: unknown) => unknown) | undefined;
          let onDispose: (() => void) | undefined;
          const panel: FakeBuilderPanel = {
            webview: {
              options: undefined,
              html: "",
              cspSource: "vscode-webview://test",
              onDidReceiveMessage: vi.fn((h: (m: unknown) => unknown) => {
                onMessage = h;
                return { dispose: vi.fn() };
              }),
              postMessage: vi.fn(),
              asWebviewUri: (uri: FakeUri) => `webview:${uri.toString()}`,
            },
            reveal: vi.fn(),
            onDidDispose: vi.fn((h: () => void) => {
              onDispose = h;
              return { dispose: vi.fn() };
            }),
            fireMessage: async (m) => {
              await onMessage?.(m);
            },
            fireDispose: () => onDispose?.(),
          };
          mockState.createdPanels.push({ viewType, title, column, options, panel });
          return panel;
        },
      ),
      showSaveDialog: mockState.showSaveDialog,
      showInformationMessage: mockState.showInformationMessage,
      showErrorMessage: mockState.showErrorMessage,
      registerCustomEditorProvider: vi.fn(
        (viewType: string, provider: FakeProvider, options: RegisteredProvider["options"]) => {
          mockState.registered.push({ viewType, provider, options });
          return { dispose: vi.fn() };
        },
      ),
      createStatusBarItem: vi.fn((_alignment: unknown, _priority: unknown) => {
        const item: FakeStatusBarItem = {
          tooltip: "",
          text: "",
          show: vi.fn(),
          hide: vi.fn(),
          dispose: vi.fn(),
        };
        mockState.statusBarItems.push(item);
        return item;
      }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: {
      registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
        mockState.registeredCommands.push({ command, handler });
        return { dispose: vi.fn() };
      }),
    },
  };
});

import * as vscode from "vscode";
import {
  activate,
  deactivate,
  createFrameStatusBarItem,
  createSelectionStatusBarItem,
  handleSaveFileMessage,
  handlePickFileMessage,
  workspaceIsRemote,
  MeganeEditorProvider,
  builderSaveBase,
  getBuilderHtml,
  MeganeBuilderPanels,
  BUILDER_EXTENSIONS,
  BUILDER_FILENAME_PREFIXES,
  PIPELINE_COMPANION_FILE_PARAMS,
  readPipelineCompanions,
  toArrayBuffer,
  documentMessages,
  PROGRESSIVE_HEAD_BYTES,
  PROGRESSIVE_TAIL_BYTES,
} from "../../../vscode-megane/src/extension";
import { COMPANION_FILE_PARAMS } from "../../../src/pipeline/companionFiles";
import * as progressiveFile from "../../../src/hosts/progressiveFile";

const VscodeUri = (vscode as unknown as { Uri: { file: (p: string) => FakeUri } }).Uri;

function makeContext(extensionPath = "/ext"): {
  extensionUri: FakeUri;
  subscriptions: Array<{ dispose: () => void }>;
} {
  return {
    extensionUri: VscodeUri.file(extensionPath),
    subscriptions: [],
  };
}

function makeWebviewPanel(): {
  panel: FakeWebviewPanel;
  fireMessage: (msg: unknown) => void;
  fireDispose: () => void;
  fireViewStateChange: (active: boolean) => void;
} {
  let onMessage: ((m: unknown) => void) | undefined;
  let onDispose: (() => void) | undefined;
  let onViewStateChange: ((e: { webviewPanel: FakeWebviewPanel }) => void) | undefined;
  const webview: FakeWebview = {
    options: undefined,
    html: "",
    cspSource: "vscode-webview://test",
    onDidReceiveMessage: vi.fn((handler: (m: unknown) => void) => {
      onMessage = handler;
      return { dispose: vi.fn() };
    }),
    postMessage: vi.fn(),
    asWebviewUri: (uri: FakeUri) => `webview:${uri.toString()}`,
  };
  const panel: FakeWebviewPanel = {
    webview,
    active: true,
    onDidDispose: vi.fn((handler: () => void) => {
      onDispose = handler;
      return { dispose: vi.fn() };
    }),
    onDidChangeViewState: vi.fn((handler: (e: { webviewPanel: FakeWebviewPanel }) => void) => {
      onViewStateChange = handler;
      return { dispose: vi.fn() };
    }),
  };
  return {
    panel,
    fireMessage: (msg) => {
      if (!onMessage) throw new Error("onDidReceiveMessage not registered");
      onMessage(msg);
    },
    fireDispose: () => {
      if (!onDispose) throw new Error("onDidDispose not registered");
      onDispose();
    },
    fireViewStateChange: (active: boolean) => {
      if (!onViewStateChange) throw new Error("onDidChangeViewState not registered");
      panel.active = active;
      onViewStateChange({ webviewPanel: panel });
    },
  };
}

function getProvider(viewType: string): FakeProvider {
  const entry = mockState.registered.find((r) => r.viewType === viewType);
  if (!entry) throw new Error(`provider not registered: ${viewType}`);
  return entry.provider;
}

beforeEach(() => {
  mockState.registered.length = 0;
  mockState.registeredCommands.length = 0;
  mockState.statusBarItems.length = 0;
  mockState.readFile.mockReset();
  mockState.writeFile.mockReset();
  mockState.showSaveDialog.mockReset();
  mockState.showInformationMessage.mockReset();
  mockState.showErrorMessage.mockReset();
  mockState.showOpenDialog.mockReset();
  mockState.createdPanels.length = 0;
  mockState.treeProviders.length = 0;
  mockState.workspaceFolders = undefined;
  mockState.activeTabInput = undefined;
  mockState.activeTextEditorUri = undefined;
  mockState.remoteName = undefined;
  mockState.uiKind = 1;
  vi.mocked(vscode.window.registerCustomEditorProvider).mockClear();
  delete process.env.MEGANE_E2E_MODE;
});

afterEach(() => {
  delete process.env.MEGANE_E2E_MODE;
});

describe("activate / deactivate", () => {
  it("registers two custom editor providers", () => {
    const ctx = makeContext();
    activate(ctx as unknown as Parameters<typeof activate>[0]);

    expect(mockState.registered.map((r) => r.viewType)).toEqual([
      "megane.structureViewer",
      "megane.pipelineViewer",
    ]);
  });

  it("pushes the providers, the seekFrame command and the Builder view and commands onto context.subscriptions", () => {
    const ctx = makeContext();
    activate(ctx as unknown as Parameters<typeof activate>[0]);

    // 2 editor providers + seekFrame + the Builder's tool servers + the Builder view + 3 Builder commands.
    expect(ctx.subscriptions).toHaveLength(8);
    for (const sub of ctx.subscriptions) {
      expect(typeof sub.dispose).toBe("function");
    }
  });

  it("registers the megane.seekFrame command", () => {
    activate(makeContext() as unknown as Parameters<typeof activate>[0]);
    const commandNames = mockState.registeredCommands.map((c) => c.command);
    expect(commandNames).toContain("megane.seekFrame");
  });

  it("configures retainContextWhenHidden and disables multi-editor for both providers", () => {
    activate(makeContext() as unknown as Parameters<typeof activate>[0]);

    for (const reg of mockState.registered) {
      expect(reg.options.webviewOptions?.retainContextWhenHidden).toBe(true);
      expect(reg.options.supportsMultipleEditorsPerDocument).toBe(false);
    }
  });

  it("deactivate is a no-op", () => {
    expect(() => deactivate()).not.toThrow();
    expect(deactivate()).toBeUndefined();
  });
});

describe("MeganeEditorProvider — structureViewer", () => {
  beforeEach(() => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
  });

  it("openCustomDocument returns a CustomDocument bound to the supplied uri", () => {
    const provider = getProvider("megane.structureViewer");
    const uri = VscodeUri.file("/work/sample.pdb");
    const doc = provider.openCustomDocument(uri, {}, {});
    expect(doc.uri).toBe(uri);
    expect(typeof doc.dispose).toBe("function");
    expect(() => doc.dispose()).not.toThrow();
  });

  it("sets webview.options with enableScripts and the media folder as the only resource root", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const options = panel.webview.options as {
      enableScripts: boolean;
      localResourceRoots: FakeUri[];
    };
    expect(options.enableScripts).toBe(true);
    expect(options.localResourceRoots).toHaveLength(1);
    expect(options.localResourceRoots[0].path).toBe("/ext/media");
  });

  it("posts a large document as head + tail first, then the middle, in that order", async () => {
    const provider = getProvider("megane.structureViewer");
    const size = PROGRESSIVE_HEAD_BYTES + PROGRESSIVE_TAIL_BYTES + 5;
    const data = new Uint8Array(size);
    data[0] = 11; // head
    data[PROGRESSIVE_HEAD_BYTES] = 22; // middle
    data[size - 1] = 33; // tail
    mockState.readFile.mockResolvedValueOnce(data);

    const doc = { uri: VscodeUri.file("/work/big.traj"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});
    fireMessage({ type: "ready" });

    const [first, second] = panel.webview.postMessage.mock.calls.map((c) => c[0]) as [
      { type: string; size: number; headBytes: ArrayBuffer; tailBytes: ArrayBuffer },
      { type: string; middleBytes: ArrayBuffer },
    ];
    expect(first.type).toBe("loadFile");
    expect(first).not.toHaveProperty("contentBytes");
    expect(first.size).toBe(size);
    expect(first.headBytes.byteLength).toBe(PROGRESSIVE_HEAD_BYTES);
    expect(new Uint8Array(first.headBytes)[0]).toBe(11);
    expect(first.tailBytes.byteLength).toBe(PROGRESSIVE_TAIL_BYTES);
    expect(new Uint8Array(first.tailBytes)[PROGRESSIVE_TAIL_BYTES - 1]).toBe(33);
    expect(second.type).toBe("loadFileRest");
    expect(second.middleBytes.byteLength).toBe(5);
    expect(new Uint8Array(second.middleBytes)[0]).toBe(22);
  });

  it("documentMessages splits only files larger than head + tail, with sizes pinned to the webview's", () => {
    // The webview reassembles with src/hosts/progressiveFile.ts: same sizes.
    expect(PROGRESSIVE_HEAD_BYTES).toBe(progressiveFile.PROGRESSIVE_HEAD_BYTES);
    expect(PROGRESSIVE_TAIL_BYTES).toBe(progressiveFile.PROGRESSIVE_TAIL_BYTES);
    const edge = new Uint8Array(PROGRESSIVE_HEAD_BYTES + PROGRESSIVE_TAIL_BYTES);
    const one = documentMessages(edge, "a.xyz", null, null);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ type: "loadFile", filename: "a.xyz" });
    expect(progressiveFile.shouldDeliverProgressively(edge.byteLength)).toBe(false);
    const big = new Uint8Array(edge.byteLength + 1);
    expect(documentMessages(big, "a.xyz", null, null)).toHaveLength(2);
    expect(progressiveFile.shouldDeliverProgressively(big.byteLength)).toBe(true);
  });

  it("posts loadFile payload (file bytes as ArrayBuffer + filename, no wasm bytes) when the webview signals ready", async () => {
    const provider = getProvider("megane.structureViewer");
    // Only the document file is read now — the WASM module is fetched by the
    // webview directly via asWebviewUri, not shipped in the message payload.
    mockState.readFile.mockResolvedValueOnce(new Uint8Array([72, 73, 74])); // doc bytes

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    fireMessage({ type: "ready" });

    expect(mockState.readFile).toHaveBeenCalledTimes(1);
    const payload = panel.webview.postMessage.mock.calls[0][0] as {
      type: string;
      contentBytes: ArrayBuffer;
      filename: string;
      topBytes: ArrayBuffer | null;
      topFilename: string | null;
      wasmBytes?: unknown;
    };
    expect(payload.type).toBe("loadFile");
    expect(payload.filename).toBe("sample.pdb");
    expect(payload).not.toHaveProperty("wasmBytes");
    expect(payload.contentBytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(payload.contentBytes)).toEqual(new Uint8Array([72, 73, 74]));
    expect(payload.topBytes).toBeNull();
    expect(payload.topFilename).toBeNull();
  });

  it("includes topBytes and topFilename when a sibling .top file exists alongside a .gro", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile
      .mockResolvedValueOnce(new Uint8Array([10, 20, 30])) // .gro doc bytes
      .mockResolvedValueOnce(new Uint8Array([40, 50, 60])); // .top bytes

    const doc = { uri: VscodeUri.file("/work/water.gro"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});
    fireMessage({ type: "ready" });

    const payload = panel.webview.postMessage.mock.calls[0][0] as {
      type: string;
      contentBytes: ArrayBuffer;
      filename: string;
      topBytes: ArrayBuffer | null;
      topFilename: string | null;
    };
    expect(payload.type).toBe("loadFile");
    expect(payload.filename).toBe("water.gro");
    expect(new Uint8Array(payload.contentBytes)).toEqual(new Uint8Array([10, 20, 30]));
    expect(payload.topBytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(payload.topBytes as ArrayBuffer)).toEqual(new Uint8Array([40, 50, 60]));
    expect(payload.topFilename).toBe("water.top");
  });

  it("sets topBytes/topFilename to null when no sibling .top exists for a .gro", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile
      .mockResolvedValueOnce(new Uint8Array([10, 20, 30])) // .gro doc bytes
      .mockRejectedValueOnce(new Error("FileNotFound")); // .top not present

    const doc = { uri: VscodeUri.file("/work/water.gro"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});
    fireMessage({ type: "ready" });

    const payload = panel.webview.postMessage.mock.calls[0][0] as {
      type: string;
      contentBytes: ArrayBuffer;
      filename: string;
      topBytes: ArrayBuffer | null;
      topFilename: string | null;
    };
    expect(payload.type).toBe("loadFile");
    expect(payload.filename).toBe("water.gro");
    expect(new Uint8Array(payload.contentBytes)).toEqual(new Uint8Array([10, 20, 30]));
    expect(payload.topBytes).toBeNull();
    expect(payload.topFilename).toBeNull();
  });

  it("ignores webview messages whose type is not 'ready'", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([0]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "selectionChanged" });
    fireMessage({});
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it("posts an error payload when reading the document fails", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockRejectedValueOnce(new Error("ENOENT: missing"));
    mockState.readFile.mockResolvedValueOnce(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "ready" });
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "ENOENT: missing",
    });
  });

  it("coerces non-Error throws into a string message", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockRejectedValueOnce("filesystem unavailable");
    mockState.readFile.mockResolvedValueOnce(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "ready" });
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "filesystem unavailable",
    });
  });

  it("renders webview.html with CSP, vscode context flag, and a 32-char nonce", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const html = panel.webview.html;
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain('window.__MEGANE_CONTEXT__ = "vscode"');
    expect(html).toContain("__MEGANE_WASM_URL__");
    expect(html).not.toContain("__MEGANE_TEST__");

    const nonceMatch = html.match(/nonce-([A-Za-z0-9]+)/);
    expect(nonceMatch).not.toBeNull();
    expect(nonceMatch![1]).toHaveLength(32);
  });

  it("admits the parse worker, served from the resource origin through a blob: bootstrap", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const html = panel.webview.html;
    expect(html).toMatch(
      /script-src 'nonce-[A-Za-z0-9]{32}' vscode-webview:\/\/test 'wasm-unsafe-eval' blob:;/,
    );
    expect(html).toContain("worker-src blob: vscode-webview://test;");
    // Unlike the Builder's page, the viewer never needs eval.
    expect(html).not.toContain("'unsafe-eval'");
  });

  it("emits __MEGANE_TEST__ when MEGANE_E2E_MODE=1 is set on the extension host", async () => {
    process.env.MEGANE_E2E_MODE = "1";
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    expect(panel.webview.html).toContain("window.__MEGANE_TEST__ = true;");
  });

  it("each call to getNonce produces a fresh random nonce", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array());

    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
      const { panel } = makeWebviewPanel();
      await provider.resolveCustomEditor(doc, panel, {});
      const nonce = panel.webview.html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
      expect(nonce).toBeDefined();
      seen.add(nonce!);
    }
    // Random — collisions across 4 picks of 32-char strings should be effectively impossible.
    expect(seen.size).toBe(4);
  });

  it("derives the CSP nonce from a CSPRNG, not Math.random", async () => {
    const getRandomValuesSpy = vi.spyOn(webcrypto, "getRandomValues");
    const mathRandomSpy = vi.spyOn(Math, "random");

    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const nonce = panel.webview.html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
    expect(nonce).toHaveLength(32);
    expect(getRandomValuesSpy).toHaveBeenCalled();
    expect(mathRandomSpy).not.toHaveBeenCalled();

    getRandomValuesSpy.mockRestore();
    mathRandomSpy.mockRestore();
  });
});

describe("createFrameStatusBarItem", () => {
  it("returns a status bar item with a trajectory tooltip", () => {
    const item = createFrameStatusBarItem();
    expect(item).toBeDefined();
    expect(mockState.statusBarItems).toHaveLength(1);
    expect(mockState.statusBarItems[0].tooltip).toBe("Current trajectory frame");
  });
});

describe("MeganeEditorProvider — frameChange message handling", () => {
  beforeEach(() => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
  });

  it("creates frame and selection status bar items when resolveCustomEditor is called", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    expect(mockState.statusBarItems).toHaveLength(2);
  });

  it("updates the status bar text when a frameChange message arrives", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "frameChange", frame: 5 });

    const item = mockState.statusBarItems[0];
    expect(item.text).toContain("5");
    expect(item.show).toHaveBeenCalledTimes(1);
  });

  it("shows successive frame indices as the frame progresses", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "frameChange", frame: 0 });
    fireMessage({ type: "frameChange", frame: 42 });

    const item = mockState.statusBarItems[0];
    expect(item.text).toContain("42");
    expect(item.show).toHaveBeenCalledTimes(2);
  });

  it("disposes both status bar items when the panel is disposed", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireDispose } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    for (const item of mockState.statusBarItems) {
      expect(item.dispose).not.toHaveBeenCalled();
    }
    fireDispose();
    for (const item of mockState.statusBarItems) {
      expect(item.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("does not call postMessage for frameChange messages", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "frameChange", frame: 10 });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe("createSelectionStatusBarItem", () => {
  it("returns a status bar item with a selection tooltip", () => {
    const item = createSelectionStatusBarItem();
    expect(item).toBeDefined();
    expect(mockState.statusBarItems).toHaveLength(1);
    expect(mockState.statusBarItems[0].tooltip).toBe("Current atom selection or measurement");
  });
});

describe("MeganeEditorProvider — selectionChange and measurementChange message handling", () => {
  beforeEach(() => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
  });

  it("shows atom count in selection status bar when selectionChange arrives", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    // statusBarItems[1] is the selection status bar (frame is [0])
    const selItem = mockState.statusBarItems[1];
    fireMessage({ type: "selectionChange", selection: { atoms: [0, 1, 2] } });
    expect(selItem.text).toContain("3");
    expect(selItem.show).toHaveBeenCalledTimes(1);
  });

  it("uses singular 'atom' for a single atom selection", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const selItem = mockState.statusBarItems[1];
    fireMessage({ type: "selectionChange", selection: { atoms: [5] } });
    expect(selItem.text).toContain("1 atom selected");
    expect(selItem.text).not.toContain("atoms");
  });

  it("hides selection status bar when selectionChange arrives with empty atoms", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const selItem = mockState.statusBarItems[1];
    // First show it
    fireMessage({ type: "selectionChange", selection: { atoms: [0] } });
    expect(selItem.show).toHaveBeenCalledTimes(1);
    // Then clear
    fireMessage({ type: "selectionChange", selection: { atoms: [] } });
    expect(selItem.hide).toHaveBeenCalled();
  });

  it("shows measurement label in selection status bar when measurementChange arrives", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const selItem = mockState.statusBarItems[1];
    fireMessage({
      type: "measurementChange",
      measurement: { type: "distance", value: 1.5, label: "d=1.50 Å", atoms: [0, 1] },
    });
    expect(selItem.text).toContain("d=1.50 Å");
    expect(selItem.show).toHaveBeenCalledTimes(1);
  });

  it("hides selection status bar when measurementChange arrives with null", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    const selItem = mockState.statusBarItems[1];
    fireMessage({
      type: "measurementChange",
      measurement: { type: "distance", value: 1.5, label: "d=1.50 Å", atoms: [0, 1] },
    });
    fireMessage({ type: "measurementChange", measurement: null });
    expect(selItem.hide).toHaveBeenCalled();
  });
});

describe("MeganePipelineEditorProvider — pipelineViewer", () => {
  beforeEach(() => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
  });

  function pipelineBytes(payload: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(payload));
  }

  it("openCustomDocument returns a CustomDocument bound to the supplied uri", () => {
    const provider = getProvider("megane.pipelineViewer");
    const uri = VscodeUri.file("/work/pipe.megane.json");
    const doc = provider.openCustomDocument(uri, {}, {});
    expect(doc.uri).toBe(uri);
    expect(() => doc.dispose()).not.toThrow();
  });

  type CompanionPayload = {
    type: string;
    pipeline: unknown;
    companionFiles: Array<{
      nodeId: string;
      nodeType: string;
      filename: string;
      content: ArrayBuffer;
    }>;
    wasmBytes?: unknown;
  };

  async function openPipeline(
    pipeline: unknown,
    companionReads: Array<Uint8Array | Error>,
    docPath = "/work/pipe.megane.json",
  ): Promise<CompanionPayload> {
    const provider = getProvider("megane.pipelineViewer");
    mockState.readFile.mockResolvedValueOnce(pipelineBytes(pipeline));
    for (const read of companionReads) {
      if (read instanceof Error) mockState.readFile.mockRejectedValueOnce(read);
      else mockState.readFile.mockResolvedValueOnce(read);
    }
    const doc = { uri: VscodeUri.file(docPath), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});
    fireMessage({ type: "ready" });
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    return panel.webview.postMessage.mock.calls[0][0] as CompanionPayload;
  }

  it("posts loadPipeline with structure + trajectory companions resolved relative to the pipeline file", async () => {
    const pipeline = {
      version: 3,
      nodes: [
        { id: "n1", type: "load_structure", fileName: "struct.pdb" },
        { id: "n2", type: "load_trajectory", fileName: "traj.xtc" },
      ],
      edges: [],
    };
    // No wasm read now: pipeline, then structure companion, then trajectory.
    const payload = await openPipeline(pipeline, [
      new TextEncoder().encode("ATOM 1"),
      new Uint8Array([9, 8, 7]),
    ]);

    expect(payload.type).toBe("loadPipeline");
    expect(payload.pipeline).toEqual(pipeline);
    expect(payload).not.toHaveProperty("wasmBytes");
    expect(payload).not.toHaveProperty("structureFiles");
    expect(payload.companionFiles.map((c) => [c.nodeId, c.nodeType, c.filename])).toEqual([
      ["n1", "load_structure", "struct.pdb"],
      ["n2", "load_trajectory", "traj.xtc"],
    ]);
    expect(mockState.readFile.mock.calls[1][0].fsPath).toBe("/work/struct.pdb");
    expect(mockState.readFile.mock.calls[2][0].fsPath).toBe("/work/traj.xtc");
    expect(new TextDecoder().decode(payload.companionFiles[0].content)).toBe("ATOM 1");
    expect(new Uint8Array(payload.companionFiles[1].content)).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("sends a binary load_structure companion (ASE .traj) as untouched bytes, not decoded text", async () => {
    // Bytes that are not valid UTF-8: decoding them as text (the old path)
    // replaced each with U+FFFD and corrupted the file.
    const traj = new Uint8Array([0x2d, 0x20, 0x6f, 0x66, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
    const payload = await openPipeline(
      {
        version: 3,
        nodes: [{ id: "s", type: "load_structure", fileName: "data/water.traj" }],
        edges: [],
      },
      [traj],
    );
    expect(payload.companionFiles).toHaveLength(1);
    expect(payload.companionFiles[0].filename).toBe("water.traj");
    expect(payload.companionFiles[0].content).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(payload.companionFiles[0].content)).toEqual(traj);
    expect(mockState.readFile.mock.calls[1][0].fsPath).toBe("/work/data/water.traj");
  });

  it("reads the companion of every file-bearing node type, under its own param", async () => {
    const nodes = [
      { id: "s", type: "load_structure", fileName: "a.pdb" },
      { id: "t", type: "load_trajectory", fileName: "b.xtc" },
      { id: "v", type: "load_vector", fileName: "c.vec" },
      { id: "g", type: "load_volumetric", fileName: "d.cube" },
      { id: "sp", type: "load_spectrum", fileName: "e.jdx" },
      { id: "ab", type: "add_bond", bondSource: "file", bondFileName: "f.top" },
    ];
    const reads = nodes.map((_, i) => new Uint8Array([i]));
    const payload = await openPipeline({ version: 3, nodes, edges: [] }, reads);
    expect(payload.companionFiles.map((c) => [c.nodeId, c.nodeType, c.filename])).toEqual([
      ["s", "load_structure", "a.pdb"],
      ["t", "load_trajectory", "b.xtc"],
      ["v", "load_vector", "c.vec"],
      ["g", "load_volumetric", "d.cube"],
      ["sp", "load_spectrum", "e.jdx"],
      ["ab", "add_bond", "f.top"],
    ]);
    payload.companionFiles.forEach((c, i) => {
      expect(new Uint8Array(c.content)).toEqual(new Uint8Array([i]));
    });
  });

  it("skips a load_vector node fed by an embedded channel (no file to read)", async () => {
    const payload = await openPipeline(
      {
        version: 3,
        nodes: [{ id: "v", type: "load_vector", fileName: "[embedded] velocities" }],
        edges: [],
      },
      [],
    );
    expect(payload.companionFiles).toEqual([]);
    expect(mockState.readFile).toHaveBeenCalledTimes(1);
  });

  it("rejects pipelines whose version is not 3", async () => {
    const provider = getProvider("megane.pipelineViewer");
    mockState.readFile
      .mockResolvedValueOnce(pipelineBytes({ version: 2, nodes: [], edges: [] }))
      .mockResolvedValueOnce(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/pipe.megane.json"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "ready" });
    const payload = panel.webview.postMessage.mock.calls[0][0] as {
      type: string;
      message: string;
    };
    expect(payload.type).toBe("error");
    expect(payload.message).toContain("version 3 required");
    expect(payload.message).toContain("got 2");
  });

  it("posts an error payload when the pipeline JSON is malformed", async () => {
    const provider = getProvider("megane.pipelineViewer");
    mockState.readFile
      .mockResolvedValueOnce(new TextEncoder().encode("{ not json"))
      .mockResolvedValueOnce(new Uint8Array());

    const doc = { uri: VscodeUri.file("/work/pipe.megane.json"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "ready" });
    const payload = panel.webview.postMessage.mock.calls[0][0] as {
      type: string;
      message: string;
    };
    expect(payload.type).toBe("error");
    expect(payload.message.length).toBeGreaterThan(0);
  });

  it("skips nodes referencing absolute fileName paths (path traversal protection)", async () => {
    const payload = await openPipeline(
      {
        version: 3,
        nodes: [
          { id: "n1", type: "load_structure", fileName: "/etc/passwd" },
          { id: "n2", type: "add_bond", bondFileName: "/etc/shadow" },
        ],
        edges: [],
      },
      [],
    );
    expect(payload.companionFiles).toEqual([]);
    // Only the pipeline file is read; no companion read attempted.
    expect(mockState.readFile).toHaveBeenCalledTimes(1);
  });

  it("skips nodes whose fileName escapes the pipeline directory", async () => {
    const payload = await openPipeline(
      {
        version: 3,
        nodes: [{ id: "n1", type: "load_structure", fileName: "../../escape.pdb" }],
        edges: [],
      },
      [],
      "/work/sub/pipe.megane.json",
    );
    expect(payload.companionFiles).toEqual([]);
    expect(mockState.readFile).toHaveBeenCalledTimes(1);
  });

  it("silently skips nodes whose companion file cannot be read", async () => {
    const payload = await openPipeline(
      {
        version: 3,
        nodes: [
          { id: "n1", type: "load_structure", fileName: "missing.pdb" },
          { id: "n2", type: "load_trajectory", fileName: "ok.xtc" },
        ],
        edges: [],
      },
      [new Error("ENOENT"), new Uint8Array([4, 5])],
    );
    expect(payload.type).toBe("loadPipeline");
    expect(payload.companionFiles.map((c) => c.nodeId)).toEqual(["n2"]);
  });

  it("skips nodes that have no fileName at all", async () => {
    const payload = await openPipeline(
      {
        version: 3,
        nodes: [
          { id: "n1", type: "filter" },
          { id: "n2", type: "load_structure", fileName: null },
          { id: "n3", type: "add_bond", bondSource: "distance" },
        ],
        edges: [],
      },
      [],
    );
    expect(mockState.readFile).toHaveBeenCalledTimes(1);
    expect(payload.companionFiles).toEqual([]);
  });

  it("ignores fileName params on node types that read no file", async () => {
    const payload = await openPipeline(
      {
        version: 3,
        nodes: [
          { id: "n1", type: "filter", fileName: "filter.txt" },
          // `fileName` is not add_bond's file param; only bondFileName is.
          { id: "n2", type: "add_bond", fileName: "wrong.top" },
          // A prototype key must not be mistaken for a table entry.
          { id: "n3", type: "constructor", fileName: "proto.pdb" },
        ],
        edges: [],
      },
      [],
    );
    expect(mockState.readFile).toHaveBeenCalledTimes(1);
    expect(payload.companionFiles).toEqual([]);
  });
});

describe("pipeline companion helpers", () => {
  it("PIPELINE_COMPANION_FILE_PARAMS mirrors the shared COMPANION_FILE_PARAMS", () => {
    // The extension host is compiled apart from src/, so it keeps a copy.
    expect(PIPELINE_COMPANION_FILE_PARAMS).toEqual(COMPANION_FILE_PARAMS);
  });

  it("toArrayBuffer returns the backing buffer when the view covers all of it", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(toArrayBuffer(data)).toBe(data.buffer);
  });

  it("toArrayBuffer copies out only the viewed bytes of a pooled buffer", () => {
    const pool = new Uint8Array([0, 0, 7, 8, 9, 0]);
    const view = pool.subarray(2, 5);
    const out = toArrayBuffer(view);
    expect(out).not.toBe(pool.buffer);
    expect(new Uint8Array(out)).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("readPipelineCompanions defaults to the workspace filesystem", async () => {
    mockState.readFile.mockResolvedValueOnce(new Uint8Array([5]));
    const out = await readPipelineCompanions(
      {
        version: 3,
        nodes: [{ id: "s", type: "load_structure", fileName: "x.traj" }],
        edges: [],
      },
      "/w",
    );
    expect(out).toHaveLength(1);
    expect(mockState.readFile.mock.calls[0][0].fsPath).toBe("/w/x.traj");
  });

  it("readPipelineCompanions accepts an injected reader", async () => {
    const reader = vi.fn(async () => new Uint8Array([1, 2]));
    const out = await readPipelineCompanions(
      {
        version: 3,
        nodes: [
          { id: "g", type: "load_volumetric", fileName: "grid.cube" },
          { id: "x", type: "viewport" },
        ],
        edges: [],
      },
      "/w",
      reader,
    );
    expect(reader).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      {
        nodeId: "g",
        nodeType: "load_volumetric",
        filename: "grid.cube",
        content: expect.any(ArrayBuffer),
      },
    ]);
  });
});

describe("handleSaveFileMessage", () => {
  const docUri = () =>
    VscodeUri.file("/work/sample.pdb") as unknown as Parameters<typeof handleSaveFileMessage>[1];

  it("writes the chosen file and shows an info message on success", async () => {
    const target = VscodeUri.file("/elsewhere/out.png");
    mockState.showSaveDialog.mockResolvedValueOnce(target);

    await handleSaveFileMessage({ filename: "megane-render.png", bytes: [1, 2, 3] }, docUri());

    expect(mockState.writeFile).toHaveBeenCalledTimes(1);
    const [uri, content] = mockState.writeFile.mock.calls[0];
    expect(uri).toBe(target);
    expect(content).toEqual(new Uint8Array([1, 2, 3]));
    expect(mockState.showInformationMessage).toHaveBeenCalledWith("Saved out.png");
    expect(mockState.showErrorMessage).not.toHaveBeenCalled();
  });

  it("does nothing when the user cancels the save dialog", async () => {
    mockState.showSaveDialog.mockResolvedValueOnce(undefined);

    await handleSaveFileMessage({ filename: "megane-render.png", bytes: [1] }, docUri());

    expect(mockState.writeFile).not.toHaveBeenCalled();
    expect(mockState.showInformationMessage).not.toHaveBeenCalled();
    expect(mockState.showErrorMessage).not.toHaveBeenCalled();
  });

  it("shows an error message when the write fails", async () => {
    mockState.showSaveDialog.mockResolvedValueOnce(VscodeUri.file("/work/out.gif"));
    mockState.writeFile.mockRejectedValueOnce(new Error("disk full"));

    await handleSaveFileMessage({ filename: "megane-render.gif", bytes: [1] }, docUri());

    expect(mockState.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(mockState.showErrorMessage.mock.calls[0][0]).toContain("disk full");
    expect(mockState.showInformationMessage).not.toHaveBeenCalled();
  });

  it("coerces non-Error write failures into a string message", async () => {
    mockState.showSaveDialog.mockResolvedValueOnce(VscodeUri.file("/work/out.png"));
    mockState.writeFile.mockRejectedValueOnce("permission denied");

    await handleSaveFileMessage({ filename: "megane-render.png", bytes: [1] }, docUri());

    expect(mockState.showErrorMessage.mock.calls[0][0]).toContain("permission denied");
  });

  it("suggests the document directory + filename and an extension-derived filter", async () => {
    mockState.showSaveDialog.mockResolvedValueOnce(undefined);

    await handleSaveFileMessage({ filename: "megane-render.glb", bytes: [1] }, docUri());

    const options = mockState.showSaveDialog.mock.calls[0][0] as {
      defaultUri: FakeUri;
      filters: Record<string, string[]>;
    };
    expect(options.defaultUri.fsPath).toBe("/work/megane-render.glb");
    expect(options.filters).toEqual({ "3D Model": ["glb"] });
  });

  it("falls back to an All Files filter for unknown extensions", async () => {
    mockState.showSaveDialog.mockResolvedValueOnce(undefined);

    await handleSaveFileMessage({ filename: "output.xyz123", bytes: [1] }, docUri());

    const options = mockState.showSaveDialog.mock.calls[0][0] as {
      filters: Record<string, string[]>;
    };
    expect(options.filters).toEqual({ "All Files": ["*"] });
  });

  it("skips the dialog and writes to the default path in E2E mode", async () => {
    process.env.MEGANE_E2E_MODE = "1";

    await handleSaveFileMessage({ filename: "megane-render.png", bytes: [9, 8] }, docUri());

    expect(mockState.showSaveDialog).not.toHaveBeenCalled();
    expect(mockState.writeFile).toHaveBeenCalledTimes(1);
    const [uri, content] = mockState.writeFile.mock.calls[0];
    expect((uri as FakeUri).fsPath).toBe("/work/megane-render.png");
    expect(content).toEqual(new Uint8Array([9, 8]));
    expect(mockState.showInformationMessage).toHaveBeenCalledWith("Saved megane-render.png");
  });
});

describe("saveFile message routing", () => {
  beforeEach(() => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
  });

  it("structureViewer routes saveFile messages to the save handler", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));
    mockState.showSaveDialog.mockResolvedValueOnce(VscodeUri.file("/work/out.png"));

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "saveFile", filename: "megane-render.png", bytes: [1, 2, 3] });
    await vi.waitFor(() => expect(mockState.writeFile).toHaveBeenCalledTimes(1));

    const options = mockState.showSaveDialog.mock.calls[0][0] as { defaultUri: FakeUri };
    expect(options.defaultUri.fsPath).toBe("/work/megane-render.png");
    expect(mockState.writeFile.mock.calls[0][1]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("pipelineViewer routes saveFile messages to the save handler", async () => {
    const provider = getProvider("megane.pipelineViewer");
    mockState.readFile
      .mockResolvedValueOnce(
        new TextEncoder().encode(JSON.stringify({ version: 3, nodes: [], edges: [] })),
      )
      .mockResolvedValueOnce(new Uint8Array());
    mockState.showSaveDialog.mockResolvedValueOnce(VscodeUri.file("/work/pipeline.megane.json"));

    const doc = { uri: VscodeUri.file("/work/pipe.megane.json"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "saveFile", filename: "pipeline.megane.json", bytes: [7] });
    await vi.waitFor(() => expect(mockState.writeFile).toHaveBeenCalledTimes(1));

    const options = mockState.showSaveDialog.mock.calls[0][0] as {
      defaultUri: FakeUri;
      filters: Record<string, string[]>;
    };
    expect(options.defaultUri.fsPath).toBe("/work/pipeline.megane.json");
    expect(options.filters).toEqual({ JSON: ["json"] });
    expect(mockState.writeFile.mock.calls[0][1]).toEqual(new Uint8Array([7]));
  });

  it("saveFile does not trigger the loadFile payload post", async () => {
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));
    mockState.showSaveDialog.mockResolvedValueOnce(undefined);

    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireMessage } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireMessage({ type: "saveFile", filename: "a.png", bytes: [] });
    await vi.waitFor(() => expect(mockState.showSaveDialog).toHaveBeenCalledTimes(1));
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe("MeganeEditorProvider.seekFrame", () => {
  it("returns false and does not post when no panel has been opened", () => {
    const ctx = makeContext();
    const provider = new MeganeEditorProvider(
      ctx as unknown as Parameters<typeof MeganeEditorProvider>[0],
    );
    expect(provider.seekFrame(5)).toBe(false);
  });

  it("returns true and posts seekFrame message to the active panel", async () => {
    const ctx = makeContext();
    const provider = new MeganeEditorProvider(
      ctx as unknown as Parameters<typeof MeganeEditorProvider>[0],
    );
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));
    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    // Clear postMessage calls from the initial load
    panel.webview.postMessage.mockClear();

    const result = provider.seekFrame(42);
    expect(result).toBe(true);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "seekFrame", frame: 42 });
  });

  it("returns false after the panel is disposed", async () => {
    const ctx = makeContext();
    const provider = new MeganeEditorProvider(
      ctx as unknown as Parameters<typeof MeganeEditorProvider>[0],
    );
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));
    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };
    const { panel, fireDispose } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, {});

    fireDispose();
    expect(provider.seekFrame(10)).toBe(false);
  });

  it("updates the active panel when a different panel becomes active via onDidChangeViewState", async () => {
    const ctx = makeContext();
    const provider = new MeganeEditorProvider(
      ctx as unknown as Parameters<typeof MeganeEditorProvider>[0],
    );
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));

    const doc1 = { uri: VscodeUri.file("/work/a.pdb"), dispose: vi.fn() };
    const { panel: panel1, fireViewStateChange: fireVsc1 } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc1, panel1, {});

    const doc2 = { uri: VscodeUri.file("/work/b.pdb"), dispose: vi.fn() };
    const { panel: panel2, fireViewStateChange: fireVsc2 } = makeWebviewPanel();
    await provider.resolveCustomEditor(doc2, panel2, {});

    // panel2 was opened last and should be active
    panel1.webview.postMessage.mockClear();
    panel2.webview.postMessage.mockClear();

    // panel1 becomes focused
    fireVsc1(true);
    provider.seekFrame(7);
    expect(panel1.webview.postMessage).toHaveBeenCalledWith({ type: "seekFrame", frame: 7 });
    expect(panel2.webview.postMessage).not.toHaveBeenCalled();

    // panel2 becomes focused again
    panel1.webview.postMessage.mockClear();
    fireVsc2(true);
    provider.seekFrame(8);
    expect(panel2.webview.postMessage).toHaveBeenCalledWith({ type: "seekFrame", frame: 8 });
    expect(panel1.webview.postMessage).not.toHaveBeenCalled();
  });

  it("megane.seekFrame command is wired to the editor provider", () => {
    const ctx = makeContext();
    activate(ctx as unknown as Parameters<typeof activate>[0]);

    const cmd = mockState.registeredCommands.find((c) => c.command === "megane.seekFrame");
    expect(cmd).toBeDefined();
    // Command handler should not throw when no panel is open
    expect(() => cmd!.handler(0)).not.toThrow();
  });
});

describe("Megane Builder", () => {
  function command(name: string) {
    const cmd = mockState.registeredCommands.find((c) => c.command === name);
    if (!cmd) throw new Error(`command not registered: ${name}`);
    return cmd.handler;
  }

  beforeEach(() => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
  });

  it("registers the activity-bar view as an empty tree, so its welcome buttons show", () => {
    expect(mockState.treeProviders.map((t) => t.id)).toEqual(["megane.builderView"]);
    const tree = mockState.treeProviders[0].provider;
    expect(tree.getChildren()).toEqual([]);
    const item = { label: "x" };
    expect(tree.getTreeItem(item)).toBe(item);
    const names = mockState.registeredCommands.map((c) => c.command);
    expect(names).toEqual(
      expect.arrayContaining([
        "megane.builder.new",
        "megane.builder.open",
        "megane.builder.openFile",
      ]),
    );
  });

  it("New Structure opens an empty Builder tab with scripts and the media folder only", () => {
    command("megane.builder.new")();
    expect(mockState.createdPanels).toHaveLength(1);
    const created = mockState.createdPanels[0];
    expect(created.viewType).toBe("megane.builder");
    expect(created.title).toBe("Megane Builder");
    expect(created.options.enableScripts).toBe(true);
    expect(created.options.retainContextWhenHidden).toBe(true);
    expect(created.options.localResourceRoots!.map((u) => u.path)).toEqual(["/ext/media"]);
    expect(created.panel.webview.html).toContain("media/builder/builder.js");
    expect(created.panel.webview.html).toContain("media/builder/builder.css");
    expect((created.panel.iconPath as { path: string }).path).toBe(
      "/ext/resources/megane-color.svg",
    );
  });

  it("routes a tab's tool requests to its own bridge and disposes it with the tab", async () => {
    const bridges: { handle: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
    const tools = {
      bridgeFor: vi.fn(() => {
        const bridge = {
          handle: vi.fn((m: { type?: string }) => m.type?.startsWith("tools:") ?? false),
          dispose: vi.fn(),
        };
        bridges.push(bridge);
        return bridge;
      }),
      dispose: vi.fn(),
    };
    const panels = new MeganeBuilderPanels(
      makeContext("/ext") as unknown as ConstructorParameters<typeof MeganeBuilderPanels>[0],
      tools as unknown as ConstructorParameters<typeof MeganeBuilderPanels>[1],
    );
    panels.open();
    const { panel } = mockState.createdPanels[mockState.createdPanels.length - 1];
    expect(tools.bridgeFor).toHaveBeenCalledWith(panel.webview);
    await panel.fireMessage({ type: "tools:servers", requestId: 1 });
    expect(bridges[0].handle).toHaveBeenCalledWith({ type: "tools:servers", requestId: 1 });
    // Other messages still reach the tab's own handling.
    await panel.fireMessage({ type: "ready" });
    expect(bridges[0].handle).toHaveBeenCalledTimes(2);
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    panel.fireDispose();
    expect(bridges[0].dispose).toHaveBeenCalled();
  });

  it("an empty Builder posts nothing when ready", async () => {
    command("megane.builder.new")();
    const { panel } = mockState.createdPanels[0];
    await panel.fireMessage({ type: "ready" });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it("Open in Megane Builder sends the file's bytes once the webview is ready", async () => {
    mockState.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await command("megane.builder.openFile")(VscodeUri.file("/work/caffeine.sdf"));
    const { title, panel } = mockState.createdPanels[0];
    expect(title).toBe("caffeine.sdf — Builder");
    await panel.fireMessage({ type: "ready" });
    const posted = panel.webview.postMessage.mock.calls[0][0] as {
      type: string;
      filename: string;
      contentBytes: ArrayBuffer;
    };
    expect(posted.type).toBe("openFile");
    expect(posted.filename).toBe("caffeine.sdf");
    expect([...new Uint8Array(posted.contentBytes)]).toEqual([1, 2, 3]);
  });

  it("opening the same file again reveals its tab; a closed tab opens anew", async () => {
    const uri = VscodeUri.file("/work/water.pdb");
    await command("megane.builder.openFile")(uri);
    await command("megane.builder.openFile")(uri);
    expect(mockState.createdPanels).toHaveLength(1);
    expect(mockState.createdPanels[0].panel.reveal).toHaveBeenCalledTimes(1);
    mockState.createdPanels[0].panel.fireDispose();
    await command("megane.builder.openFile")(uri);
    expect(mockState.createdPanels).toHaveLength(2);
  });

  it("reports a file it cannot read", async () => {
    mockState.readFile.mockRejectedValue(new Error("EACCES"));
    await command("megane.builder.openFile")(VscodeUri.file("/work/locked.pdb"));
    await mockState.createdPanels[0].panel.fireMessage({ type: "ready" });
    expect(mockState.showErrorMessage).toHaveBeenCalledWith(
      "Megane Builder could not read locked.pdb: EACCES",
    );
  });

  it("without a file argument, opens the file in front, else asks for one", async () => {
    mockState.activeTabInput = { uri: VscodeUri.file("/work/front.xyz") };
    await command("megane.builder.openFile")();
    expect(mockState.createdPanels[0].title).toBe("front.xyz — Builder");

    mockState.activeTabInput = undefined;
    mockState.activeTextEditorUri = VscodeUri.file("/work/text.pdb");
    await command("megane.builder.openFile")();
    expect(mockState.createdPanels[1].title).toBe("text.pdb — Builder");

    mockState.activeTextEditorUri = undefined;
    mockState.showOpenDialog.mockResolvedValue([VscodeUri.file("/work/picked.cif")]);
    await command("megane.builder.openFile")();
    expect(mockState.createdPanels[2].title).toBe("picked.cif — Builder");
  });

  it("Open File in Builder… asks with the structure filters; cancelling opens nothing", async () => {
    mockState.showOpenDialog.mockResolvedValue(undefined);
    expect(await command("megane.builder.open")()).toBeUndefined();
    expect(mockState.createdPanels).toHaveLength(0);
    const options = mockState.showOpenDialog.mock.calls[0][0] as {
      filters: Record<string, string[]>;
    };
    expect(options.filters["Structure files"]).toEqual(BUILDER_EXTENSIONS);
  });

  it("Save asks where to write, beside the opened file, and answers the webview", async () => {
    await command("megane.builder.openFile")(VscodeUri.file("/work/water.pdb"));
    const { panel } = mockState.createdPanels[0];
    mockState.showSaveDialog.mockResolvedValue(VscodeUri.file("/work/out/water.xyz"));
    mockState.writeFile.mockResolvedValue();
    await panel.fireMessage({ type: "saveFile", id: 4, filename: "water.xyz", bytes: [65] });
    const options = mockState.showSaveDialog.mock.calls[0][0] as { defaultUri: FakeUri };
    expect(options.defaultUri.fsPath).toBe("/work/water.xyz");
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "saveResult",
      id: 4,
      path: "water.xyz",
    });

    mockState.showSaveDialog.mockResolvedValue(undefined);
    await panel.fireMessage({ type: "saveFile", id: 5, filename: "water.xyz", bytes: [65] });
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith({
      type: "saveResult",
      id: 5,
      path: null,
    });
  });

  it("builderSaveBase: the file, else the first workspace folder, else home", () => {
    const file = VscodeUri.file("/work/a.pdb");
    expect(builderSaveBase(file as never)).toBe(file);
    mockState.workspaceFolders = [{ uri: VscodeUri.file("/ws") }];
    expect(builderSaveBase(undefined).path).toBe("/ws/untitled");
    mockState.workspaceFolders = undefined;
    expect(builderSaveBase(undefined).path).toMatch(/untitled$/);
  });

  it("the Builder page admits the extension's chunks and blob: workers, with a nonce", () => {
    const html = getBuilderHtml(
      {
        cspSource: "https://res",
        asWebviewUri: (u: FakeUri) => `webview:${u.path}`,
      } as never,
      VscodeUri.file("/ext/media") as never,
    );
    expect(html).toMatch(
      /script-src 'nonce-[A-Za-z0-9]{32}' https:\/\/res 'wasm-unsafe-eval' 'unsafe-eval' blob:/,
    );
    expect(html).toContain("worker-src blob: https://res;");
    expect(html).not.toContain("__MEGANE_TEST__ = true");
    process.env.MEGANE_E2E_MODE = "1";
    expect(
      getBuilderHtml(
        { cspSource: "x", asWebviewUri: (u: FakeUri) => u.path } as never,
        VscodeUri.file("/m") as never,
      ),
    ).toContain("window.__MEGANE_TEST__ = true;");
  });
});

describe("Megane Builder manifest", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "../../../vscode-megane/package.json"), "utf8"),
  ) as {
    contributes: {
      viewsContainers: { activitybar: { id: string; icon: string }[] };
      views: Record<string, { id: string }[]>;
      viewsWelcome: { view: string; contents: string }[];
      commands: { command: string }[];
      menus: Record<string, { command: string; when: string }[]>;
    };
  };

  it("puts a megane container in the activity bar with the Builder view and its welcome buttons", () => {
    const c = manifest.contributes;
    expect(c.viewsContainers.activitybar).toEqual([
      expect.objectContaining({ id: "megane", icon: "resources/megane.svg" }),
    ]);
    for (const icon of ["megane.svg", "megane-color.svg"]) {
      expect(existsSync(resolve(__dirname, `../../../vscode-megane/resources/${icon}`))).toBe(true);
    }
    expect(c.views.megane.map((v) => v.id)).toEqual(["megane.builderView"]);
    const welcome = c.viewsWelcome.find((w) => w.view === "megane.builderView")!;
    expect(welcome.contents).toContain("command:megane.builder.new");
    expect(welcome.contents).toContain("command:megane.builder.open");
  });

  it("declares every Builder command it registers", () => {
    const declared = manifest.contributes.commands.map((c) => c.command);
    expect(declared).toEqual(
      expect.arrayContaining([
        "megane.builder.new",
        "megane.builder.open",
        "megane.builder.openFile",
      ]),
    );
  });

  it("the Explorer entry's when clause matches exactly the Builder's file types", () => {
    const entry = manifest.contributes.menus["explorer/context"].find(
      (m) => m.command === "megane.builder.openFile",
    )!;
    const ext = /resourceExtname =~ \/\^\\\.\(([^)]*)\)\$\/i/.exec(entry.when);
    expect(ext?.[1].split("|")).toEqual(BUILDER_EXTENSIONS);
    const names = /resourceFilename =~ \/\^\(([^)]*)\)\//.exec(entry.when);
    expect(names?.[1].split("|")).toEqual(BUILDER_FILENAME_PREFIXES);
  });
});

describe("Open from remote (pickFile)", () => {
  it("workspaceIsRemote is false for a local desktop window", () => {
    expect(workspaceIsRemote()).toBe(false);
  });

  it("workspaceIsRemote is true under VS Code Remote and in the browser", () => {
    mockState.remoteName = "ssh-remote";
    expect(workspaceIsRemote()).toBe(true);
    mockState.remoteName = undefined;
    mockState.uiKind = 2;
    expect(workspaceIsRemote()).toBe(true);
  });

  it("flags remote workspaces in the viewer page only when remote", async () => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
    const provider = getProvider("megane.structureViewer");
    mockState.readFile.mockResolvedValue(new Uint8Array([1]));
    const doc = { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() };

    const local = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, local.panel, {});
    expect(local.panel.webview.html).not.toContain("__MEGANE_REMOTE_FILES__");

    mockState.remoteName = "wsl";
    const remote = makeWebviewPanel();
    await provider.resolveCustomEditor(doc, remote.panel, {});
    expect(remote.panel.webview.html).toContain("window.__MEGANE_REMOTE_FILES__ = true;");
  });

  it("shows the open dialog beside the document and posts the file back", async () => {
    const picked = VscodeUri.file("/work/run/traj.xtc");
    mockState.showOpenDialog.mockResolvedValueOnce([picked]);
    mockState.readFile.mockResolvedValueOnce(new Uint8Array([9, 8, 7]));
    const webview = { postMessage: vi.fn() };

    await handlePickFileMessage(
      { id: 3, kind: "trajectory", extensions: [".xtc", ".dcd"] },
      VscodeUri.file("/work/sample.pdb") as never,
      webview as never,
    );

    const options = mockState.showOpenDialog.mock.calls[0][0] as {
      defaultUri: FakeUri;
      filters: Record<string, string[]>;
      canSelectMany: boolean;
    };
    expect(options.canSelectMany).toBe(false);
    expect(options.defaultUri.path).toBe("/work/sample.pdb/..");
    expect(options.filters).toEqual({ "Trajectory files": ["xtc", "dcd"], "All files": ["*"] });
    expect(mockState.readFile).toHaveBeenCalledWith(picked);
    const reply = webview.postMessage.mock.calls[0][0] as {
      type: string;
      id: number;
      filename: string;
      contentBytes: ArrayBuffer;
    };
    expect(reply).toMatchObject({ type: "pickFileResult", id: 3, filename: "traj.xtc" });
    expect(Array.from(new Uint8Array(reply.contentBytes))).toEqual([9, 8, 7]);
  });

  it("answers a cancelled dialog with no file", async () => {
    mockState.showOpenDialog.mockResolvedValueOnce(undefined);
    const webview = { postMessage: vi.fn() };
    await handlePickFileMessage({ id: 1 }, VscodeUri.file("/w/a.pdb") as never, webview as never);
    const options = mockState.showOpenDialog.mock.calls[0][0] as {
      filters: Record<string, string[]>;
    };
    expect(options.filters).toEqual({ "All files": ["*"] });
    expect(webview.postMessage).toHaveBeenCalledWith({ type: "pickFileResult", id: 1 });
  });

  it("reports a read failure", async () => {
    mockState.showOpenDialog.mockResolvedValueOnce([VscodeUri.file("/w/b.pdb")]);
    mockState.readFile.mockRejectedValueOnce(new Error("EACCES"));
    const webview = { postMessage: vi.fn() };
    await handlePickFileMessage(
      { id: 2, kind: "structure", extensions: [".pdb"] },
      VscodeUri.file("/w/a.pdb") as never,
      webview as never,
    );
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "pickFileResult",
      id: 2,
      error: "EACCES",
    });
  });

  it("reports a non-Error failure as text", async () => {
    mockState.showOpenDialog.mockRejectedValueOnce("boom");
    const webview = { postMessage: vi.fn() };
    await handlePickFileMessage({ id: 5 }, VscodeUri.file("/w/a.pdb") as never, webview as never);
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "pickFileResult",
      id: 5,
      error: "boom",
    });
  });

  it("both viewers route pickFile messages to the handler", async () => {
    activate(makeContext("/ext") as unknown as Parameters<typeof activate>[0]);
    mockState.showOpenDialog.mockResolvedValue(undefined);

    mockState.readFile.mockResolvedValueOnce(new Uint8Array([1]));
    const structure = makeWebviewPanel();
    await getProvider("megane.structureViewer").resolveCustomEditor(
      { uri: VscodeUri.file("/work/sample.pdb"), dispose: vi.fn() },
      structure.panel,
      {},
    );
    structure.fireMessage({ type: "pickFile", id: 11, kind: "structure", extensions: [] });
    await vi.waitFor(() =>
      expect(structure.panel.webview.postMessage).toHaveBeenCalledWith({
        type: "pickFileResult",
        id: 11,
      }),
    );

    mockState.readFile.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify({ version: 3, nodes: [], edges: [] })),
    );
    const pipeline = makeWebviewPanel();
    await getProvider("megane.pipelineViewer").resolveCustomEditor(
      { uri: VscodeUri.file("/work/pipe.megane.json"), dispose: vi.fn() },
      pipeline.panel,
      {},
    );
    pipeline.fireMessage({ type: "pickFile", id: 12, kind: "structure", extensions: [] });
    await vi.waitFor(() =>
      expect(pipeline.panel.webview.postMessage).toHaveBeenCalledWith({
        type: "pickFileResult",
        id: 12,
      }),
    );
  });
});
