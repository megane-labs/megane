import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy dependencies so MeganePipelineDocWidget.tsx imports without a
// JupyterLab runtime or a WASM build.
vi.mock("@megane/components/MeganeViewer", () => ({ MeganeViewer: vi.fn(() => null) }));
vi.mock("@megane/pipeline/store", () => ({
  usePipelineStore: { getState: vi.fn(() => ({ reset: vi.fn() })), setState: vi.fn() },
}));
vi.mock("@megane/pipeline/storeSnapshot", () => ({ capturePipelineStore: vi.fn(() => ({})) }));
vi.mock("@megane/tour/useTour", () => ({ useTour: vi.fn() }));
vi.mock("@megane/styles/megane.css", () => ({}));
vi.mock("@megane/parsers/structure", () => ({ prewarmParseWorker: vi.fn() }));
vi.mock("../../../jupyterlab-megane/src/wasmLoader", () => ({ ensureWasmUrl: vi.fn() }));

const mockSeekFrame = vi.fn();
vi.mock("@megane/stores/usePlaybackStore", () => ({
  usePlaybackStore: { getState: () => ({ seekFrame: mockSeekFrame }) },
}));

import { MeganePipelineReactView } from "../../../jupyterlab-megane/src/MeganePipelineDocWidget";

type DocBodyElement = {
  props: {
    children: {
      props: {
        onFrameChange: (frame: number) => void;
        onSelectionChange: (selection: { atoms: number[] }) => void;
        onMeasurementChange: (measurement: unknown) => void;
      };
    };
  };
};

function makeView(): MeganePipelineReactView {
  const context = {
    path: "/pipe.megane.json",
    model: { toString: () => "" },
    ready: Promise.resolve(),
  };
  return new MeganePipelineReactView(context as never, {} as never, (async () => {}) as never);
}

/** The DocBody element the view renders, whose callbacks feed the subscriptions. */
function docBody(view: MeganePipelineReactView) {
  const rendered = (view as unknown as { render(): DocBodyElement }).render();
  return rendered.props.children.props;
}

describe("MeganePipelineReactView events", () => {
  beforeEach(() => {
    mockSeekFrame.mockClear();
  });

  it("reports the viewer's frame, selection and measurement to subscribers", () => {
    const view = makeView();
    const frames: number[] = [];
    const selections: unknown[] = [];
    const measurements: unknown[] = [];
    const unsubscribe = view.subscribeFrameChange((f) => frames.push(f));
    view.subscribeSelectionChange((s) => selections.push(s));
    view.subscribeMeasurementChange((m) => measurements.push(m));

    const body = docBody(view);
    body.onFrameChange(4);
    body.onSelectionChange({ atoms: [1, 2] });
    body.onMeasurementChange(null);
    expect(frames).toEqual([4]);
    expect(selections).toEqual([{ atoms: [1, 2] }]);
    expect(measurements).toEqual([null]);

    unsubscribe();
    body.onFrameChange(5);
    expect(frames).toEqual([4]);
  });

  it("seekFrame delegates to the playback store", () => {
    makeView().seekFrame(12);
    expect(mockSeekFrame).toHaveBeenCalledWith(12);
  });
});
