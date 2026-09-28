import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all heavy dependencies so MeganeDocWidget.tsx can be imported without
// a real JupyterLab runtime or WASM build.
vi.mock("@megane/components/MeganeViewer", () => ({ MeganeViewer: vi.fn(() => null) }));
vi.mock("@megane/hooks/useMeganeLocal", () => ({ useMeganeLocal: vi.fn(() => ({})) }));
vi.mock("@megane/pipeline/store", () => ({
  usePipelineStore: { getState: vi.fn(() => ({ reset: vi.fn() })), setState: vi.fn() },
}));
vi.mock("@megane/pipeline/storeSnapshot", () => ({ capturePipelineStore: vi.fn(() => ({})) }));
vi.mock("@megane/tour/useTour", () => ({ useTour: vi.fn() }));
vi.mock("@megane/components/ThemeSync", () => ({ ThemeSync: vi.fn(() => null) }));
vi.mock("@megane/styles/megane.css", () => ({}));
vi.mock("../../../jupyterlab-megane/src/wasmLoader", () => ({ ensureWasmUrl: vi.fn() }));
vi.mock("../../../jupyterlab-megane/src/filetypes", () => ({
  STRUCTURE_FILETYPES_BINARY: [],
}));
vi.mock("../../../jupyterlab-megane/src/trajectoryUtils", () => ({
  TRAJECTORY_ONLY_EXTENSIONS: new Set<string>(),
}));
vi.mock("../../../jupyterlab-megane/src/frameSubscription", () => {
  const factory = () => {
    const listeners = new Set<(value: unknown) => void>();
    return {
      subscribe(cb: (value: unknown) => void) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      emit(value: unknown) {
        for (const cb of listeners) cb(value);
      },
    };
  };
  return { createFrameSubscription: factory, createSubscription: factory };
});

const mockSeekFrame = vi.fn();
vi.mock("@megane/stores/usePlaybackStore", () => ({
  usePlaybackStore: {
    getState: () => ({ seekFrame: mockSeekFrame }),
  },
}));

import { MeganeReactView } from "../../../jupyterlab-megane/src/MeganeDocWidget";

function makeContext() {
  return {
    path: "/test.pdb",
    model: { toString: () => "" },
    ready: Promise.resolve(),
    contentsModel: null,
  } as Parameters<typeof MeganeReactView>[0];
}

describe("MeganeReactView.seekFrame", () => {
  beforeEach(() => {
    mockSeekFrame.mockClear();
  });

  it("delegates to usePlaybackStore.getState().seekFrame", () => {
    const view = new MeganeReactView(makeContext());
    view.seekFrame(42);
    expect(mockSeekFrame).toHaveBeenCalledWith(42);
  });

  it("passes frame index 0 correctly", () => {
    const view = new MeganeReactView(makeContext());
    view.seekFrame(0);
    expect(mockSeekFrame).toHaveBeenCalledWith(0);
  });

  it("passes large frame indices correctly", () => {
    const view = new MeganeReactView(makeContext());
    view.seekFrame(9999);
    expect(mockSeekFrame).toHaveBeenCalledWith(9999);
  });

  it("calls seekFrame exactly once per invocation", () => {
    const view = new MeganeReactView(makeContext());
    view.seekFrame(5);
    view.seekFrame(10);
    expect(mockSeekFrame).toHaveBeenCalledTimes(2);
    expect(mockSeekFrame).toHaveBeenNthCalledWith(1, 5);
    expect(mockSeekFrame).toHaveBeenNthCalledWith(2, 10);
  });
});

describe("MeganeReactView.subscribeSelectionChange / subscribeMeasurementChange", () => {
  it("forwards selection state to subscribers when the viewer reports a change", () => {
    const view = new MeganeReactView(makeContext()) as unknown as {
      subscribeSelectionChange: (cb: (s: { atoms: number[] }) => void) => () => void;
      _handleSelectionChange: (s: { atoms: number[] }) => void;
    };
    const received: Array<{ atoms: number[] }> = [];
    view.subscribeSelectionChange((s) => received.push(s));
    view._handleSelectionChange({ atoms: [1, 2, 3] });
    expect(received).toEqual([{ atoms: [1, 2, 3] }]);
  });

  it("forwards measurement (and null) to subscribers", () => {
    const view = new MeganeReactView(makeContext()) as unknown as {
      subscribeMeasurementChange: (cb: (m: { label: string } | null) => void) => () => void;
      _handleMeasurementChange: (m: { label: string } | null) => void;
    };
    const received: Array<{ label: string } | null> = [];
    view.subscribeMeasurementChange((m) => received.push(m));
    view._handleMeasurementChange({ label: "1.23 Å" });
    view._handleMeasurementChange(null);
    expect(received).toEqual([{ label: "1.23 Å" }, null]);
  });

  it("render() wires the new selection/measurement handlers onto DocBody", () => {
    const view = new MeganeReactView(makeContext()) as unknown as {
      render: () => { props: { children: { props: Record<string, unknown> } } };
    };
    // render() wraps DocBody in an <ErrorBoundary>; the DocBody element (with
    // the wired callbacks) is the boundary's single child.
    const docBody = view.render().props.children;
    expect(typeof docBody.props.onSelectionChange).toBe("function");
    expect(typeof docBody.props.onMeasurementChange).toBe("function");
  });

  it("returns an unsubscribe function from subscribeSelectionChange", () => {
    const view = new MeganeReactView(makeContext()) as unknown as {
      subscribeSelectionChange: (cb: (s: { atoms: number[] }) => void) => () => void;
      _handleSelectionChange: (s: { atoms: number[] }) => void;
    };
    const received: Array<{ atoms: number[] }> = [];
    const unsub = view.subscribeSelectionChange((s) => received.push(s));
    view._handleSelectionChange({ atoms: [42] });
    unsub();
    view._handleSelectionChange({ atoms: [99] });
    expect(received).toEqual([{ atoms: [42] }]);
  });
});
