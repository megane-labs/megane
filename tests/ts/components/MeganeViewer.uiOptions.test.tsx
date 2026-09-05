import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

// The renderer is stubbed so we can assert the frustum insets MeganeViewer
// reserves for the pipeline panel — they must collapse to 0 when the panel is
// switched off, not just when it is collapsed.
const {
  rendererStub,
  pipelineEditorProps,
  measurementProps,
  measurementListProps,
  viewportProps,
  tooltipProps,
} = vi.hoisted(() => ({
  rendererStub: {
    setBackgroundColor: vi.fn(),
    setViewInsets: vi.fn(),
    setCameraChangeCallback: vi.fn<(cb: () => void) => void>(),
    applyCameraState: vi.fn(),
    resetCamera: vi.fn(),
    alignCameraToAxis: vi.fn(),
    updateBondsExt: vi.fn(),
    getStats: vi.fn(() => ({ fps: 60, drawCalls: 3 })),
    getCameraState: vi.fn<() => unknown>(() => null),
    toggleAtomSelection: vi.fn<(i: number) => { atoms: number[] }>(() => ({ atoms: [0] })),
    clearSelection: vi.fn(),
    getMeasurement: vi.fn<() => unknown>(() => null),
  },
  /** Last props the stubbed PipelineEditor received, for callback round-trips. */
  pipelineEditorProps: { current: null as Record<string, unknown> | null },
  /** Last props the stubbed measurement panels received, for layout assertions. */
  measurementProps: { current: null as Record<string, unknown> | null },
  measurementListProps: { current: null as Record<string, unknown> | null },
  /** Last props the stubbed Viewport received, for wiring assertions. */
  viewportProps: { current: null as Record<string, unknown> | null },
  /** Last props the stubbed Tooltip received, for stale-hover assertions. */
  tooltipProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/components/Viewport", async () => {
  const { useEffect } = await import("react");
  return {
    Viewport: (props: Record<string, unknown>) => {
      viewportProps.current = props;
      const onRendererReady = props.onRendererReady as ((r: unknown) => void) | undefined;
      useEffect(() => {
        onRendererReady?.(rendererStub);
      }, [onRendererReady]);
      return <div data-testid="mock-viewport" />;
    },
  };
});

// Tooltip / MeasurementPanel / MeasurementListPanel all render null when they
// have no data, so stub them with always-visible markers to tell "switched
// off" apart from "nothing to show".
vi.mock("@/components/Tooltip", () => ({
  Tooltip: (props: Record<string, unknown>) => {
    tooltipProps.current = props;
    return <div data-testid="mock-tooltip" />;
  },
}));
vi.mock("@/components/MeasurementPanel", () => ({
  MeasurementPanel: (props: Record<string, unknown>) => {
    measurementProps.current = props;
    return <div data-testid="mock-measurement-panel" />;
  },
}));
vi.mock("@/components/MeasurementListPanel", () => ({
  MeasurementListPanel: (props: Record<string, unknown>) => {
    measurementListProps.current = props;
    return <div data-testid="mock-measurement-list" />;
  },
}));
vi.mock("@/components/Timeline", () => ({
  Timeline: () => <div data-testid="mock-timeline" />,
}));
vi.mock("@/components/PipelineEditor", () => ({
  PipelineEditor: (props: Record<string, unknown>) => {
    pipelineEditorProps.current = props;
    return <div data-testid="mock-pipeline-editor" />;
  },
}));
vi.mock("@/pipeline/apply", () => ({
  applyViewportState: vi.fn(),
  applyVectorsForFrame: vi.fn(),
}));

import { MeganeViewer, DEFAULT_MEGANE_VIEWER_UI } from "@/components/MeganeViewer";
import type { MeganeViewerUiOptions } from "@/components/MeganeViewer";
import { useViewStateStore } from "@/stores/useViewStateStore";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { usePlaybackStore } from "@/stores/usePlaybackStore";
import type { MeganeCameraState } from "@/renderer/MoleculeRenderer";

/** testid rendered by each switchable tool, keyed by its `ui` option. */
const TOOL_TESTIDS: Record<keyof MeganeViewerUiOptions, string[]> = {
  pipelineEditor: ["mock-pipeline-editor"],
  resetView: ["reset-view-btn"],
  viewAxes: ["view-axis-controls"],
  perfHud: ["perf-hud"],
  timeline: ["mock-timeline"],
  tooltip: ["mock-tooltip"],
  measurement: ["mock-measurement-panel", "mock-measurement-list"],
};

const TOOL_KEYS = Object.keys(TOOL_TESTIDS) as (keyof MeganeViewerUiOptions)[];

// The Timeline (and therefore the overlay offsets keyed on it) only renders for
// multi-frame data, so every suite here starts from a trajectory.
beforeEach(() => {
  usePlaybackStore.setState({ totalFrames: 100 });
});

afterEach(() => {
  usePlaybackStore.setState({ totalFrames: 0 });
  usePipelineUIStore.setState({ mode: "chat" });
  viewportProps.current = null;
  tooltipProps.current = null;
});

describe("MeganeViewer ui options", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    rendererStub.getCameraState.mockReturnValue(null);
    pipelineEditorProps.current = null;
    measurementProps.current = null;
    measurementListProps.current = null;
    viewportProps.current = null;
    rendererStub.toggleAtomSelection.mockReturnValue({ atoms: [0] });
    rendererStub.getMeasurement.mockReturnValue(null);
    usePipelineUIStore.setState({ mode: "chat" });
  });

  // Public API read on every render as the fallback for each unset key: a
  // stray assignment must not be able to retune every viewer in the process.
  it("exposes frozen defaults", () => {
    expect(Object.isFrozen(DEFAULT_MEGANE_VIEWER_UI)).toBe(true);
  });

  it("defaults every tool to visible", () => {
    expect(DEFAULT_MEGANE_VIEWER_UI).toEqual({
      pipelineEditor: true,
      resetView: true,
      viewAxes: true,
      perfHud: true,
      timeline: true,
      tooltip: true,
      measurement: true,
    });
  });

  it("renders all tools when no ui prop is given", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    for (const testid of TOOL_KEYS.flatMap((k) => TOOL_TESTIDS[k])) {
      expect(screen.getByTestId(testid)).toBeTruthy();
    }
  });

  // `ui` is Partial<…> and the project does not enable
  // exactOptionalPropertyTypes, so `ui={{ timeline: someMaybeUndefined }}`
  // typechecks. Present-but-undefined must read as "not specified", not "off".
  it.each(TOOL_KEYS)("treats an explicitly undefined %s as not specified", (key) => {
    render(<MeganeViewer onUploadStructure={() => {}} ui={{ [key]: undefined }} />);
    for (const testid of TOOL_KEYS.flatMap((k) => TOOL_TESTIDS[k])) {
      expect(screen.getByTestId(testid)).toBeTruthy();
    }
  });

  it("renders all tools when ui is an empty object", () => {
    render(<MeganeViewer onUploadStructure={() => {}} ui={{}} />);
    for (const testid of TOOL_KEYS.flatMap((k) => TOOL_TESTIDS[k])) {
      expect(screen.getByTestId(testid)).toBeTruthy();
    }
  });

  it.each(TOOL_KEYS)("hides only %s when that key is false", (key) => {
    render(<MeganeViewer onUploadStructure={() => {}} ui={{ [key]: false }} />);

    for (const testid of TOOL_TESTIDS[key]) {
      expect(screen.queryByTestId(testid)).toBeNull();
    }
    for (const other of TOOL_KEYS.filter((k) => k !== key)) {
      for (const testid of TOOL_TESTIDS[other]) {
        expect(screen.getByTestId(testid)).toBeTruthy();
      }
    }
  });

  it("keeps the Viewport when every tool is switched off", () => {
    const allOff = Object.fromEntries(TOOL_KEYS.map((k) => [k, false])) as MeganeViewerUiOptions;
    render(<MeganeViewer onUploadStructure={() => {}} ui={allOff} />);

    expect(screen.getByTestId("mock-viewport")).toBeTruthy();
    expect(screen.getByTestId("megane-viewer")).toBeTruthy();
    for (const testid of TOOL_KEYS.flatMap((k) => TOOL_TESTIDS[k])) {
      expect(screen.queryByTestId(testid)).toBeNull();
    }
  });

  it("shifts the perf HUD into the Reset View slot when that button is hidden", () => {
    render(<MeganeViewer onUploadStructure={() => {}} ui={{ resetView: false }} />);
    expect(screen.getByTestId("perf-hud")).toHaveStyle({ left: "12px" });
  });

  it("leaves the perf HUD clear of the Reset View button by default", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    expect(screen.getByTestId("perf-hud")).toHaveStyle({ left: "92px" });
  });

  it("reserves a right inset for the pipeline panel by default", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    // Default panel width 480 + 12px gutter.
    expect(rendererStub.setViewInsets).toHaveBeenCalledWith(0, 492);
    expect(rendererStub.setViewInsets).not.toHaveBeenCalledWith(0, 0);
  });

  it("reserves no right inset when the pipeline panel is switched off", () => {
    render(<MeganeViewer onUploadStructure={() => {}} ui={{ pipelineEditor: false }} />);
    expect(rendererStub.setViewInsets).toHaveBeenCalledWith(0, 0);
    expect(rendererStub.setViewInsets).not.toHaveBeenCalledWith(0, 492);
  });

  it("stretches the tour anchor across the full width without the pipeline panel", () => {
    const { container } = render(
      <MeganeViewer onUploadStructure={() => {}} ui={{ pipelineEditor: false, timeline: false }} />,
    );
    const anchor = container.querySelector<HTMLElement>('[data-tour-anchor="viewport"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.style.right).toBe("24px");
    expect(anchor!.style.bottom).toBe("24px");
  });

  it("keeps the tour anchor clear of the pipeline panel and timeline by default", () => {
    const { container } = render(<MeganeViewer onUploadStructure={() => {}} />);
    const anchor = container.querySelector<HTMLElement>('[data-tour-anchor="viewport"]');
    expect(anchor!.style.right).toBe("504px");
    expect(anchor!.style.bottom).toBe("80px");
  });

  it("keeps the measurement panels clear of the timeline by default", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    expect(measurementProps.current?.bottom).toBe(60);
    expect(measurementListProps.current?.bottom).toBe(60);
  });

  // Timeline self-guards on `totalFrames > 1`, so a static structure has no
  // strip to clear even though `ui.timeline` is on.
  it("drops the measurement panels to the corner inset for a single-frame structure", () => {
    act(() => {
      usePlaybackStore.setState({ totalFrames: 1 });
    });
    render(<MeganeViewer onUploadStructure={() => {}} />);

    expect(screen.queryByTestId("mock-timeline")).toBeNull();
    expect(measurementProps.current?.bottom).toBe(12);
    expect(measurementListProps.current?.bottom).toBe(12);
  });

  it("pulls the tour anchor down when no timeline strip is on screen", () => {
    act(() => {
      usePlaybackStore.setState({ totalFrames: 1 });
    });
    const { container } = render(<MeganeViewer onUploadStructure={() => {}} />);
    const anchor = container.querySelector<HTMLElement>('[data-tour-anchor="viewport"]');
    expect(anchor!.style.bottom).toBe("24px");
  });

  it("drops the measurement panels to the corner inset when the timeline is hidden", () => {
    render(<MeganeViewer onUploadStructure={() => {}} ui={{ timeline: false }} />);
    expect(measurementProps.current?.bottom).toBe(12);
    expect(measurementListProps.current?.bottom).toBe(12);
  });

  // The hover pipeline costs a viewer-wide re-render per mousemove; with no
  // Tooltip in the tree that work has no consumer.
  it("wires the hover callback by default and drops it with tooltip off", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    expect(typeof viewportProps.current?.onHover).toBe("function");

    cleanup();
    render(<MeganeViewer onUploadStructure={() => {}} ui={{ tooltip: false }} />);
    expect(viewportProps.current?.onHover).toBeUndefined();
  });

  // `mode` is restored from sessionStorage, so a viewer mounted without the
  // panel must not inherit a stale inspector mode it cannot exit.
  it("keeps inspector mode active while the pipeline panel is shown", () => {
    usePipelineUIStore.setState({ mode: "inspector" });
    render(<MeganeViewer onUploadStructure={() => {}} />);
    expect(viewportProps.current?.inspectorActive).toBe(true);
  });

  it("forces inspector mode off when the pipeline panel is hidden", () => {
    usePipelineUIStore.setState({ mode: "inspector" });
    render(<MeganeViewer onUploadStructure={() => {}} ui={{ pipelineEditor: false }} />);
    expect(viewportProps.current?.inspectorActive).toBe(false);
    expect(viewportProps.current?.boxSelectActive).toBe(false);
    expect(viewportProps.current?.previewIndices).toBeNull();
  });

  // `rightInset` takes `showPipelineEditor` as a real dependency, so a runtime
  // toggle has to move the frustum inset in both directions.
  it("re-applies the inset when the pipeline panel is toggled at runtime", () => {
    const { rerender } = render(<MeganeViewer onUploadStructure={() => {}} />);
    expect(rendererStub.setViewInsets).toHaveBeenCalledWith(0, 492);

    rendererStub.setViewInsets.mockClear();
    rerender(<MeganeViewer onUploadStructure={() => {}} ui={{ pipelineEditor: false }} />);
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 0);

    rendererStub.setViewInsets.mockClear();
    rerender(<MeganeViewer onUploadStructure={() => {}} ui={{ pipelineEditor: true }} />);
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 492);
  });

  // Hover state freezes once onHover is dropped; re-enabling must not flash the
  // last label at coordinates the cursor left long ago.
  it("clears stale hover state when the tooltip is switched off", () => {
    const { rerender } = render(<MeganeViewer onUploadStructure={() => {}} />);
    act(() => {
      (viewportProps.current?.onHover as (i: unknown) => void)({
        kind: "atom",
        atomIndex: 42,
        screenX: 10,
        screenY: 20,
      });
    });
    expect(tooltipProps.current?.info).toMatchObject({ atomIndex: 42 });

    rerender(<MeganeViewer onUploadStructure={() => {}} ui={{ tooltip: false }} />);
    rerender(<MeganeViewer onUploadStructure={() => {}} ui={{ tooltip: true }} />);
    expect(tooltipProps.current?.info).toBeNull();
  });

  // Collapsing keeps the panel mounted but shrinks it to its rail, which is a
  // third geometry alongside "shown" and "switched off".
  // The button `ui.resetView` hides is the only entry point to this handler,
  // so its behaviour is worth pinning before anyone reaches for the flag.
  it("resets the camera and drops the persisted view state from the Reset View button", () => {
    useViewStateStore.setState({ camera: { position: [9, 9, 9] } as never });
    render(<MeganeViewer onUploadStructure={() => {}} />);

    fireEvent.click(screen.getByTestId("reset-view-btn"));

    expect(rendererStub.resetCamera).toHaveBeenCalledTimes(1);
    expect(useViewStateStore.getState().camera).toBeNull();
  });

  it("aligns the camera from the axis buttons without touching the persisted view state", () => {
    const saved = { position: [9, 9, 9] } as never;
    useViewStateStore.setState({ camera: saved });
    render(<MeganeViewer onUploadStructure={() => {}} />);

    fireEvent.click(screen.getByTestId("view-axis-+z"));
    expect(rendererStub.alignCameraToAxis).toHaveBeenLastCalledWith("+z");
    fireEvent.click(screen.getByTestId("view-axis--x"));
    expect(rendererStub.alignCameraToAxis).toHaveBeenLastCalledWith("-x");
    expect(rendererStub.alignCameraToAxis).toHaveBeenCalledTimes(2);
    // Persistence is the renderer's camera-change callback's job, not the
    // click handler's — nothing is cleared here.
    expect(useViewStateStore.getState().camera).toBe(saved);
    useViewStateStore.setState({ camera: null });
  });

  // No structure is loaded in this suite, so there is no cell: the crystal
  // axes would only duplicate x/y/z and stay hidden.
  it("shows only the Cartesian axis row while no cell is loaded", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    expect(screen.getByTestId("view-axis-row-cartesian")).toBeTruthy();
    expect(screen.queryByTestId("view-axis-row-lattice")).toBeNull();
  });

  it("stacks the axis buttons under the Reset View button in one corner block", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    const block = screen.getByTestId("view-controls");
    expect(block).toHaveStyle({ top: "12px", left: "12px" });
    expect(block.contains(screen.getByTestId("reset-view-btn"))).toBe(true);
    expect(block.contains(screen.getByTestId("view-axis-controls"))).toBe(true);
  });

  it("drops the corner block entirely when both its tools are hidden", () => {
    render(
      <MeganeViewer onUploadStructure={() => {}} ui={{ resetView: false, viewAxes: false }} />,
    );
    expect(screen.queryByTestId("view-controls")).toBeNull();
  });

  it("reclaims the inset and pulls the tour anchor in when the panel is collapsed", () => {
    const { container } = render(<MeganeViewer onUploadStructure={() => {}} />);
    const anchor = container.querySelector<HTMLElement>('[data-tour-anchor="viewport"]');
    expect(anchor!.style.right).toBe("504px");
    expect(pipelineEditorProps.current?.collapsed).toBe(false);

    rendererStub.setViewInsets.mockClear();
    act(() => {
      (pipelineEditorProps.current?.onToggleCollapse as () => void)();
    });

    expect(pipelineEditorProps.current?.collapsed).toBe(true);
    expect(anchor!.style.right).toBe("60px");
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 0);

    rendererStub.setViewInsets.mockClear();
    act(() => {
      (pipelineEditorProps.current?.onToggleCollapse as () => void)();
    });

    expect(pipelineEditorProps.current?.collapsed).toBe(false);
    expect(anchor!.style.right).toBe("504px");
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 492);
  });

  it("re-applies the inset when the pipeline panel is resized", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    const onWidthChange = pipelineEditorProps.current?.onWidthChange as (w: number) => void;
    rendererStub.setViewInsets.mockClear();

    onWidthChange(300);
    expect(rendererStub.setViewInsets).toHaveBeenCalledWith(0, 312);
  });
});

describe("MeganeViewer selection clearing", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    rendererStub.toggleAtomSelection.mockReturnValue({ atoms: [0] });
    rendererStub.getMeasurement.mockReturnValue(null);
  });

  const pressEscape = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

  const selectAnAtom = () =>
    act(() => {
      (viewportProps.current?.onAtomRightClick as (i: number) => void)(0);
    });

  // Right-click selection stays wired when `measurement` is off, so Escape is
  // the only remaining way to drop the highlights.
  it("clears a selection on Escape even with the measurement panel hidden", () => {
    const onSelectionChange = vi.fn();
    render(
      <MeganeViewer
        onUploadStructure={() => {}}
        ui={{ measurement: false }}
        onSelectionChange={onSelectionChange}
      />,
    );

    selectAnAtom();
    expect(onSelectionChange).toHaveBeenLastCalledWith({ atoms: [0] });

    pressEscape();
    expect(rendererStub.clearSelection).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenLastCalledWith({ atoms: [] });
  });

  it("ignores Escape when nothing is selected", () => {
    const onSelectionChange = vi.fn();
    render(<MeganeViewer onUploadStructure={() => {}} onSelectionChange={onSelectionChange} />);

    pressEscape();
    expect(rendererStub.clearSelection).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("ignores Escape typed into a text field", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    selectAnAtom();

    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(rendererStub.clearSelection).not.toHaveBeenCalled();
    input.remove();
  });

  // A page can host several viewers, and the host's own dialogs answer to
  // Escape too — so the viewer only claims the key when it holds focus (or
  // nothing does).
  it("takes focus when an atom is selected", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    selectAnAtom();
    expect(document.activeElement).toBe(screen.getByTestId("megane-viewer"));
  });

  it("ignores Escape while focus sits outside the viewer", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    selectAnAtom();

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    pressEscape();
    expect(rendererStub.clearSelection).not.toHaveBeenCalled();
    outside.remove();
  });

  it("still answers Escape when nothing on the page holds focus", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    selectAnAtom();
    (document.activeElement as HTMLElement | null)?.blur();

    pressEscape();
    expect(rendererStub.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape typed into a contenteditable region", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    selectAnAtom();

    const editable = document.createElement("div");
    // jsdom does not derive `isContentEditable` from the attribute, so set it
    // directly — the handler reads that property, not the attribute.
    editable.setAttribute("contenteditable", "true");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.appendChild(editable);

    act(() => {
      editable.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(rendererStub.clearSelection).not.toHaveBeenCalled();
    editable.remove();
  });

  it("ignores an Escape another handler already consumed", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    selectAnAtom();

    act(() => {
      const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      ev.preventDefault();
      window.dispatchEvent(ev);
    });
    expect(rendererStub.clearSelection).not.toHaveBeenCalled();
  });
});

describe("MeganeViewer camera persistence", () => {
  const CAMERA = { position: [1, 2, 3], target: [0, 0, 0] } as unknown as MeganeCameraState;

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    rendererStub.getCameraState.mockReturnValue(null);
    useViewStateStore.setState({ camera: null });
  });

  /** Invokes the callback MeganeViewer registered on the renderer. */
  const fireCameraChange = () => {
    const cb = rendererStub.setCameraChangeCallback.mock.calls[0]?.[0];
    expect(cb).toBeTypeOf("function");
    cb!();
  };

  it("forwards camera changes to the onCameraStateChange prop when supplied", () => {
    const onCameraStateChange = vi.fn();
    render(<MeganeViewer onUploadStructure={() => {}} onCameraStateChange={onCameraStateChange} />);
    rendererStub.getCameraState.mockReturnValue(CAMERA);

    fireCameraChange();
    expect(onCameraStateChange).toHaveBeenCalledWith(CAMERA);
    expect(useViewStateStore.getState().camera).toBeNull();
  });

  it("falls back to the view-state store when no callback is supplied", () => {
    render(<MeganeViewer onUploadStructure={() => {}} />);
    rendererStub.getCameraState.mockReturnValue(CAMERA);

    fireCameraChange();
    expect(useViewStateStore.getState().camera).toBe(CAMERA);
  });

  it("ignores camera changes while the renderer has no camera state yet", () => {
    const onCameraStateChange = vi.fn();
    render(<MeganeViewer onUploadStructure={() => {}} onCameraStateChange={onCameraStateChange} />);
    rendererStub.getCameraState.mockReturnValue(null);

    fireCameraChange();
    expect(onCameraStateChange).not.toHaveBeenCalled();
    expect(useViewStateStore.getState().camera).toBeNull();
  });
});
