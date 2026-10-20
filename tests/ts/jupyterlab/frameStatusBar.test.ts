import { describe, it, expect, vi, beforeEach } from "vitest";

// @lumino/widgets is resolved via the stub alias in vitest.config.ts
import { setupFrameStatusBar } from "../../../jupyterlab-megane/src/frameStatusBar";

type CurrentChangedHandler = (
  tracker: unknown,
  widget: { content: { subscribeFrameChange: (cb: (f: number) => void) => () => void } } | null,
) => void;

function makeTracker(currentWidget: unknown = null) {
  let handler: CurrentChangedHandler | null = null;
  return {
    currentWidget,
    currentChanged: {
      connect: vi.fn((h: CurrentChangedHandler) => {
        handler = h;
      }),
    },
    fireCurrentChanged(
      widget: { content: { subscribeFrameChange: (cb: (f: number) => void) => () => void } } | null,
    ) {
      handler?.(this, widget);
    },
  };
}

function makeStatusBar() {
  return { registerStatusItem: vi.fn() };
}

function registeredItem(statusBar: ReturnType<typeof makeStatusBar>): {
  node: { textContent: string };
} {
  return statusBar.registerStatusItem.mock.calls[0][1].item as {
    node: { textContent: string };
  };
}

describe("setupFrameStatusBar", () => {
  let tracker: ReturnType<typeof makeTracker>;
  let statusBar: ReturnType<typeof makeStatusBar>;

  beforeEach(() => {
    tracker = makeTracker();
    statusBar = makeStatusBar();
  });

  it("registers a status item with the correct id and alignment", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);

    expect(statusBar.registerStatusItem).toHaveBeenCalledWith(
      "megane:frame-counter",
      expect.objectContaining({ align: "right", rank: 100 }),
    );
  });

  it("connects to tracker.currentChanged", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);
    expect(tracker.currentChanged.connect).toHaveBeenCalledTimes(1);
  });

  it("starts with empty status item text", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);
    const item = registeredItem(statusBar);
    expect(item.node.textContent).toBe("");
  });

  it("subscribes to the widget's frame changes when a widget becomes active", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);

    const unsub = vi.fn();
    const mockWidget = {
      content: {
        subscribeFrameChange: vi.fn(() => unsub),
      },
    };

    tracker.fireCurrentChanged(mockWidget);
    expect(mockWidget.content.subscribeFrameChange).toHaveBeenCalledTimes(1);
  });

  it("updates item text content when frame changes", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);

    let frameCb: ((f: number) => void) | null = null;
    const mockWidget = {
      content: {
        subscribeFrameChange: vi.fn((cb: (f: number) => void) => {
          frameCb = cb;
          return vi.fn();
        }),
      },
    };

    tracker.fireCurrentChanged(mockWidget);
    frameCb!(99);

    const item = registeredItem(statusBar);
    expect(item.node.textContent).toBe("Frame 99");
  });

  it("clears item text and unsubscribes when widget is deactivated", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);

    let frameCb: ((f: number) => void) | null = null;
    const unsub = vi.fn();
    const mockWidget = {
      content: {
        subscribeFrameChange: vi.fn((cb: (f: number) => void) => {
          frameCb = cb;
          return unsub;
        }),
      },
    };

    tracker.fireCurrentChanged(mockWidget);
    frameCb!(5);

    const item = registeredItem(statusBar);
    expect(item.node.textContent).toBe("Frame 5");

    tracker.fireCurrentChanged(null);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(item.node.textContent).toBe("");
  });

  it("unsubscribes from previous widget when a new widget becomes active", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);

    const unsub1 = vi.fn();
    const widget1 = {
      content: { subscribeFrameChange: vi.fn(() => unsub1) },
    };
    const unsub2 = vi.fn();
    const widget2 = {
      content: { subscribeFrameChange: vi.fn(() => unsub2) },
    };

    tracker.fireCurrentChanged(widget1);
    tracker.fireCurrentChanged(widget2);

    expect(unsub1).toHaveBeenCalledTimes(1);
    expect(unsub2).not.toHaveBeenCalled();
  });

  it("isActive returns true when tracker has a current widget", () => {
    const trackerWithWidget = makeTracker({ content: {} });
    setupFrameStatusBar([trackerWithWidget] as never, statusBar as never);

    const options = statusBar.registerStatusItem.mock.calls[0][1] as {
      isActive: () => boolean;
    };
    expect(options.isActive()).toBe(true);
  });

  it("isActive returns false when tracker has no current widget", () => {
    setupFrameStatusBar([tracker] as never, statusBar as never);

    const options = statusBar.registerStatusItem.mock.calls[0][1] as {
      isActive: () => boolean;
    };
    expect(options.isActive()).toBe(false);
  });
});

describe("setupFrameStatusBar with the structure and Pipeline Viewer trackers", () => {
  type FrameWidget = {
    content: { subscribeFrameChange: ReturnType<typeof vi.fn> };
    emit: (frame: number) => void;
  };

  function makeWidget(): FrameWidget {
    let cb: ((f: number) => void) | null = null;
    return {
      content: {
        subscribeFrameChange: vi.fn((listener: (f: number) => void) => {
          cb = listener;
          return () => {
            cb = null;
          };
        }),
      },
      emit: (frame) => cb?.(frame),
    };
  }

  function makeKindTracker(widgets: FrameWidget[]) {
    const tracker = makeTracker(null);
    return Object.assign(tracker, {
      has: (w: unknown) => widgets.includes(w as FrameWidget),
      setCurrent(widget: FrameWidget | null) {
        tracker.currentWidget = widget;
        tracker.fireCurrentChanged(widget);
      },
    });
  }

  function makeShell() {
    let handler: ((shell: unknown, args: { newValue: unknown }) => void) | null = null;
    return {
      currentChanged: {
        connect: vi.fn((h: typeof handler) => {
          handler = h;
        }),
      },
      focus(widget: unknown) {
        handler?.(this, { newValue: widget });
      },
    };
  }

  it("follows the shell's focus between a structure tab and a pipeline tab", () => {
    const structureTab = makeWidget();
    const pipelineTab = makeWidget();
    const structures = makeKindTracker([structureTab]);
    const pipelines = makeKindTracker([pipelineTab]);
    const shell = makeShell();
    const statusBar = makeStatusBar();
    setupFrameStatusBar([structures, pipelines] as never, statusBar as never, shell as never);
    const item = registeredItem(statusBar);

    structures.setCurrent(structureTab);
    structureTab.emit(3);
    expect(item.node.textContent).toBe("Frame 3");

    pipelines.setCurrent(pipelineTab);
    pipelineTab.emit(7);
    expect(item.node.textContent).toBe("Frame 7");
    // The structure tab is no longer listened to.
    structureTab.emit(4);
    expect(item.node.textContent).toBe("Frame 7");

    // Refocusing the structure tab does not change its tracker's current
    // widget, so only the shell reports it.
    shell.focus(structureTab);
    expect(item.node.textContent).toBe("");
    structureTab.emit(5);
    expect(item.node.textContent).toBe("Frame 5");

    // Focus on something that is not a Megane tab keeps the last one.
    shell.focus({});
    shell.focus(null);
    expect(item.node.textContent).toBe("Frame 5");
    // Refocusing the shown tab does not resubscribe.
    shell.focus(structureTab);
    expect(structureTab.content.subscribeFrameChange).toHaveBeenCalledTimes(2);
  });

  it("hands over to the other kind's tab when the last tab of one kind closes", () => {
    const structureTab = makeWidget();
    const pipelineTab = makeWidget();
    const structures = makeKindTracker([structureTab]);
    const pipelines = makeKindTracker([pipelineTab]);
    const statusBar = makeStatusBar();
    setupFrameStatusBar([structures, pipelines] as never, statusBar as never);
    const item = registeredItem(statusBar);

    structures.setCurrent(structureTab);
    pipelines.setCurrent(pipelineTab);
    pipelines.setCurrent(null);
    structureTab.emit(8);
    expect(item.node.textContent).toBe("Frame 8");

    const options = statusBar.registerStatusItem.mock.calls[0][1] as { isActive: () => boolean };
    expect(options.isActive()).toBe(true);
    structures.setCurrent(null);
    expect(item.node.textContent).toBe("");
    expect(options.isActive()).toBe(false);
  });
});
