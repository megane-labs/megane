import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../jupyterlab-megane/src/testHook", () => ({
  exposeAppForTests: vi.fn(),
}));

vi.mock("../../../jupyterlab-megane/src/factory", () => {
  const MockFactory = class {
    widgetCreated = { connect: vi.fn() };
    constructor(_opts: unknown) {
      void _opts;
    }
  };
  return { MeganeDocFactory: MockFactory, MeganePipelineDocFactory: MockFactory };
});

vi.mock("../../../jupyterlab-megane/src/MeganeDocWidget", () => ({}));
vi.mock("../../../jupyterlab-megane/src/MeganePipelineDocWidget", () => ({}));

vi.mock("../../../jupyterlab-megane/src/frameStatusBar", () => ({
  setupFrameStatusBar: vi.fn(),
}));

vi.mock("@jupyterlab/apputils", () => ({
  ICommandPalette: {},
  WidgetTracker: class {
    constructor(_opts: unknown) {
      void _opts;
    }
    add = vi.fn().mockResolvedValue(undefined);
    save = vi.fn().mockResolvedValue(undefined);
    currentWidget = null;
  },
}));

import plugins, { plugin, builderPlugin } from "../../../jupyterlab-megane/src/index";
import { setupFrameStatusBar } from "../../../jupyterlab-megane/src/frameStatusBar";
import { getRemoteFileSource, setRemoteFileSource } from "@megane/remote/fileSource";

const mockApp = {
  docRegistry: {
    addFileType: vi.fn(),
    addWidgetFactory: vi.fn(),
    addModelFactory: vi.fn(),
  },
  serviceManager: {
    contents: { getDownloadUrl: vi.fn(async (path: string) => `/files/${path}`) },
    serverSettings: { baseUrl: "/" },
  },
};

const mockRestorer = {
  restore: vi.fn().mockResolvedValue(undefined),
};

describe("megane JupyterLab extension", () => {
  it("exports the viewer and Builder plugins", () => {
    expect(plugins).toEqual([plugin, builderPlugin]);
    expect(plugins.map((p) => p.id)).toEqual([
      "megane-jupyterlab:plugin",
      "megane-jupyterlab:builder",
    ]);
  });
});

describe("megane JupyterLab plugin – IStatusBar optional integration", () => {
  beforeEach(() => {
    vi.mocked(setupFrameStatusBar).mockClear();
    vi.mocked(mockApp.docRegistry.addFileType).mockClear();
    vi.mocked(mockApp.docRegistry.addWidgetFactory).mockClear();
    vi.mocked(mockRestorer.restore).mockClear();
  });

  it("calls setupFrameStatusBar when IStatusBar is provided", () => {
    const fakeStatusBar = { registerStatusItem: vi.fn() };
    plugin.activate(mockApp as never, mockRestorer as never, fakeStatusBar as never);

    expect(setupFrameStatusBar).toHaveBeenCalledTimes(1);
    expect(setupFrameStatusBar).toHaveBeenCalledWith(expect.anything(), fakeStatusBar);
  });

  it("skips setupFrameStatusBar when statusBar is null", () => {
    plugin.activate(mockApp as never, mockRestorer as never, null as never);
    expect(setupFrameStatusBar).not.toHaveBeenCalled();
  });

  it("always registers file types and factories regardless of statusBar", () => {
    plugin.activate(mockApp as never, mockRestorer as never, null as never);
    expect(mockApp.docRegistry.addFileType).toHaveBeenCalled();
    expect(mockApp.docRegistry.addWidgetFactory).toHaveBeenCalled();
  });

  it("registers the content-less model the structure viewers open their files with", () => {
    vi.mocked(mockApp.docRegistry.addModelFactory).mockClear();
    plugin.activate(mockApp as never, mockRestorer as never, null as never);
    expect(mockApp.docRegistry.addModelFactory).toHaveBeenCalledTimes(1);
    const factory = vi.mocked(mockApp.docRegistry.addModelFactory).mock.calls[0][0] as {
      name: string;
      fileFormat: unknown;
    };
    expect(factory.name).toBe("megane-raw");
    expect(factory.fileFormat).toBeNull();
  });
});

describe("megane JupyterLab plugin – Open from server", () => {
  afterEach(() => setRemoteFileSource(null));

  it("registers the Jupyter server's files, starting in the file browser's folder", () => {
    const browser = { model: { path: "work/run" } };
    plugin.activate(mockApp as never, mockRestorer as never, null as never, browser as never);
    const source = getRemoteFileSource();
    expect(source?.mode).toBe("browse");
    expect(source?.mode === "browse" && source.initialPath?.()).toBe("work/run");
  });

  it("downloads through ServerConnection with the app's server settings", async () => {
    const { ServerConnection } = await import("@jupyterlab/services");
    const makeRequest = vi
      .spyOn(ServerConnection, "makeRequest")
      .mockResolvedValue(new Response("ATOM"));
    plugin.activate(mockApp as never, mockRestorer as never, null as never);
    const source = getRemoteFileSource();
    if (source?.mode !== "browse") throw new Error("expected a browse source");
    const file = await source.read("a.pdb");
    expect(file.name).toBe("a.pdb");
    expect(makeRequest).toHaveBeenCalledWith(
      "/files/a.pdb",
      {},
      mockApp.serviceManager.serverSettings,
    );
    makeRequest.mockRestore();
  });

  it("starts at the root without a file browser", () => {
    plugin.activate(mockApp as never, mockRestorer as never, null as never);
    const source = getRemoteFileSource();
    expect(source?.mode === "browse" && source.initialPath?.()).toBe("");
  });
});
