import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for src/widget.ts — the anywidget render entry point.
 *
 * Focus: the camera-state plumbing added in PR #392 (handleCameraStateChange,
 * getInitialCameraState, plus its propagation as WidgetViewer props).
 *
 * The full render() closure is exercised by mocking the React layer so the
 * callbacks remain reachable without a real WebGL/canvas mount.
 */

// Capture the props that widget.ts passes into <WidgetViewer/> on each render.
const widgetViewerCalls: Array<Record<string, unknown>> = [];

vi.mock("@/components/WidgetViewer", () => ({
  WidgetViewer: vi.fn((props: Record<string, unknown>) => {
    widgetViewerCalls.push(props);
    return null;
  }),
}));

// react-dom/client.createRoot — return a stub Root that captures the rendered
// element (we only care about the props passed into createElement). widget.ts
// wraps the viewer in an <ErrorBoundary>, so unwrap to the inner WidgetViewer
// element here and keep these tests asserting on the viewer props directly.
const renderedElements: Array<{ type: unknown; props: Record<string, unknown> }> = [];
vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn((el: { type: unknown; props: Record<string, unknown> }) => {
      const inner =
        el && el.type === ErrorBoundary
          ? (el.props.children as { type: unknown; props: Record<string, unknown> })
          : el;
      renderedElements.push(inner);
    }),
    unmount: vi.fn(),
  })),
}));

// Avoid pulling in the real perf hook (no-op is fine).
vi.mock("@/perf", () => ({
  perfMark: vi.fn(),
  perfMeasure: vi.fn(),
}));

// Stub the snapshot/frame decoders so parseSnapshot/parseFrame return null in
// tests (we don't need real binary decoding for the camera-state tests). The
// header and embedded-trajectory decoders stay real.
vi.mock("@/protocol/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/protocol/protocol")>()),
  decodeSnapshot: vi.fn(() => null),
  decodeFrame: vi.fn(() => null),
}));

import widgetEntry from "@/widget";
import { WidgetViewer } from "@/components/WidgetViewer";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { decodeFrame } from "@/protocol/protocol";
import type { Frame } from "@/types";
import { frameMessage, trajectoryMessage } from "./protocol/trajectoryMessage";

const mockedWidgetViewer = vi.mocked(WidgetViewer);

interface MockModel {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  save_changes: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  // expose the registered change-event callbacks for tests to invoke
  listeners: Map<string, () => void>;
  // mutable backing store for get()
  state: Record<string, unknown>;
}

function makeMockModel(initial: Record<string, unknown> = {}): MockModel {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, () => void>();
  return {
    state,
    listeners,
    get: vi.fn((key: string) => state[key]),
    set: vi.fn((key: string, value: unknown) => {
      state[key] = value;
    }),
    save_changes: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      listeners.set(event, cb);
    }),
  };
}

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

// jsdom does not implement layout, so HTMLElement#clientWidth/Height are 0.
// widget.ts's initApp() bails on 0×0 containers, so we override the
// prototype with non-zero values during these tests.
let clientWidthDescriptor: PropertyDescriptor | undefined;
let clientHeightDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  widgetViewerCalls.length = 0;
  renderedElements.length = 0;
  mockedWidgetViewer.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  };

  clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  if (clientWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
  }
  if (clientHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
  }
});

describe("widget.ts — render", () => {
  it("registers change listeners for all expected model keys", () => {
    const model = makeMockModel();
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    const expected = [
      "change:_snapshot_data",
      "change:_frame_data",
      "change:_trajectory_data",
      "change:frame_index",
      "change:total_frames",
      "change:selected_atoms",
      "change:_node_snapshots_data",
      "change:_pipeline_json",
    ];
    for (const ev of expected) {
      expect(model.listeners.has(ev), `listener ${ev}`).toBe(true);
    }
  });

  it("passes initialCameraState=null when model has no camera_state", () => {
    const model = makeMockModel();
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    const last = renderedElements[renderedElements.length - 1];
    expect(last.props.initialCameraState).toBeNull();
    expect(last.props.onCameraStateChange).toBeTypeOf("function");
  });

  it("returns the persisted camera state when model.camera_state is well-formed", () => {
    const cam = {
      mode: "perspective",
      position: [1, 2, 3],
      target: [0, 0, 0],
      zoom: 1.5,
    };
    const model = makeMockModel({ camera_state: cam });
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    const last = renderedElements[renderedElements.length - 1];
    expect(last.props.initialCameraState).toEqual(cam);
  });

  it("rejects malformed camera_state shapes (returns null)", () => {
    const cases = [
      { mode: 42, position: [0, 0, 0], target: [0, 0, 0], zoom: 1 }, // bad mode
      { mode: "orthographic", position: "nope", target: [0, 0, 0], zoom: 1 }, // bad position
      { mode: "orthographic", position: [0, 0, 0], target: "nope", zoom: 1 }, // bad target
      { mode: "orthographic", position: [0, 0, 0], target: [0, 0, 0], zoom: "x" }, // bad zoom
      null,
    ];
    for (const cam of cases) {
      renderedElements.length = 0;
      const model = makeMockModel({ camera_state: cam });
      const el = makeContainer();
      widgetEntry.render({ model: model as never, el });
      const last = renderedElements[renderedElements.length - 1];
      expect(last.props.initialCameraState).toBeNull();
    }
  });

  it("onCameraStateChange writes back to model and triggers save_changes", () => {
    const model = makeMockModel();
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    const last = renderedElements[renderedElements.length - 1];
    const onCameraStateChange = last.props.onCameraStateChange as (
      s: Record<string, unknown>,
    ) => void;

    const newState = {
      mode: "orthographic",
      position: [10, 20, 30],
      target: [1, 1, 1],
      zoom: 2,
    };
    onCameraStateChange(newState);

    expect(model.set).toHaveBeenCalledWith("camera_state", newState);
    expect(model.save_changes).toHaveBeenCalled();
  });

  it("re-renders propagate updated camera_state through getInitialCameraState", () => {
    const model = makeMockModel();
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    // Update model state and trigger a re-render via one of the change listeners.
    const cam = {
      mode: "orthographic",
      position: [4, 5, 6],
      target: [0, 0, 0],
      zoom: 1,
    };
    model.state.camera_state = cam;
    model.listeners.get("change:frame_index")?.();

    const last = renderedElements[renderedElements.length - 1];
    expect(last.props.initialCameraState).toEqual(cam);
  });

  it("handlePipelineChange writes _pipeline_json", () => {
    const model = makeMockModel();
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    const last = renderedElements[renderedElements.length - 1];
    const onPipelineChange = last.props.onPipelineChange as (j: string) => void;
    onPipelineChange("{}");

    expect(model.set).toHaveBeenCalledWith("_pipeline_json", "{}");
    expect(model.save_changes).toHaveBeenCalled();
  });

  it("handleSeek writes the requested frame index", () => {
    const model = makeMockModel({ total_frames: 5 });
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    const last = renderedElements[renderedElements.length - 1];
    const onSeek = last.props.onSeek as (frame: number) => void;
    onSeek(3);

    expect(model.set).toHaveBeenCalledWith("frame_index", 3);
  });

  it("handleSeek with -1 advances to the next frame (wrap-around)", () => {
    const model = makeMockModel({ total_frames: 4, frame_index: 3 });
    const el = makeContainer();
    widgetEntry.render({ model: model as never, el });

    const last = renderedElements[renderedElements.length - 1];
    const onSeek = last.props.onSeek as (frame: number) => void;
    onSeek(-1);

    expect(model.set).toHaveBeenCalledWith("frame_index", 0);
  });

  it("cleanup function unmounts and disconnects without errors", () => {
    const model = makeMockModel();
    const el = makeContainer();
    const cleanup = widgetEntry.render({ model: model as never, el }) as () => void;
    expect(() => cleanup()).not.toThrow();
  });
});

describe("widget.ts — embedded trajectory", () => {
  const embedded = () =>
    new DataView(
      trajectoryMessage([
        frameMessage(0, [0, 0, 0]),
        frameMessage(1, [1, 1, 1]),
        frameMessage(2, [2, 2, 2]),
      ]),
    );
  const lastFrame = () => renderedElements[renderedElements.length - 1].props.frame as Frame | null;

  it("shows the embedded frame at frame_index on mount", () => {
    const model = makeMockModel({ _trajectory_data: embedded(), frame_index: 1, total_frames: 3 });
    widgetEntry.render({ model: model as never, el: makeContainer() });

    expect(lastFrame()?.frameId).toBe(1);
    expect(Array.from(lastFrame()!.positions)).toEqual([1, 1, 1]);
  });

  it("follows frame_index changes without kernel frame data", () => {
    const model = makeMockModel({ _trajectory_data: embedded(), frame_index: 0, total_frames: 3 });
    widgetEntry.render({ model: model as never, el: makeContainer() });

    const onSeek = renderedElements[renderedElements.length - 1].props.onSeek as (
      f: number,
    ) => void;
    onSeek(2);
    model.listeners.get("change:frame_index")?.();
    expect(lastFrame()?.frameId).toBe(2);

    // Kernel frame data is ignored while the trajectory is embedded.
    const rendersBefore = renderedElements.length;
    model.listeners.get("change:_frame_data")?.();
    expect(renderedElements.length).toBe(rendersBefore);
  });

  it("picks up a trajectory embedded after mount", () => {
    const model = makeMockModel({ frame_index: 2, total_frames: 3 });
    widgetEntry.render({ model: model as never, el: makeContainer() });
    expect(lastFrame()).toBeNull();

    model.state._trajectory_data = embedded();
    model.listeners.get("change:_trajectory_data")?.();
    expect(lastFrame()?.frameId).toBe(2);
  });

  it("falls back to kernel frames when the data is not a trajectory message", () => {
    const notTrajectory = new DataView(frameMessage(0, [0, 0, 0]).buffer);
    const model = makeMockModel({ _trajectory_data: notTrajectory, _frame_data: notTrajectory });
    vi.mocked(decodeFrame).mockClear();
    widgetEntry.render({ model: model as never, el: makeContainer() });

    // parseFrame() ran on _frame_data (decodeFrame is stubbed to null here).
    expect(decodeFrame).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toBeNull();
  });

  it("keeps playing when save_changes throws for lack of a kernel", () => {
    const model = makeMockModel({ _trajectory_data: embedded(), frame_index: 0, total_frames: 3 });
    model.save_changes.mockImplementation(() => {
      throw new Error("Syncing error: no comm channel defined");
    });
    widgetEntry.render({ model: model as never, el: makeContainer() });

    const onSeek = renderedElements[renderedElements.length - 1].props.onSeek as (
      f: number,
    ) => void;
    expect(() => onSeek(-1)).not.toThrow();
    expect(model.state.frame_index).toBe(1);
  });
});
