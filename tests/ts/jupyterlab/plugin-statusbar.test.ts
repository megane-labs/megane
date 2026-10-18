import { describe, it, expect, vi, beforeEach } from "vitest";

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

const mockApp = {
  docRegistry: {
    addFileType: vi.fn(),
    addWidgetFactory: vi.fn(),
  },
  serviceManager: { contents: {} },
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
});
