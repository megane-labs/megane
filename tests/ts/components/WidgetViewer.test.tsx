import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { Frame, HoverInfo, Snapshot } from "@/types";

// Mock heavy components to avoid WebGL/canvas in jsdom
vi.mock("@/components/Viewport", () => ({
  Viewport: vi.fn(() => null),
}));
vi.mock("@/components/Tooltip", () => ({
  Tooltip: vi.fn(() => null),
}));
vi.mock("@/components/MeasurementPanel", () => ({
  MeasurementPanel: vi.fn(() => null),
}));

// Spy on bond inference so we can assert the per-frame effect fires.
vi.mock("@/parsers/inferBondsJS", () => ({
  inferBondsVdwJS: vi.fn(() => new Uint32Array(0)),
  DEFAULT_VDW_BOND_FACTOR: 0.6,
}));
// Stub PBC post-processing only — preserve other exports (executeAddBond etc.)
// that the pipeline store's execute() depends on.
vi.mock("@/pipeline/executors/addBond", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/executors/addBond")>();
  return {
    ...actual,
    processPbcBonds: vi.fn((bondIndices: Uint32Array, bondOrders: Uint8Array | null) => ({
      bondIndices,
      bondOrders,
      nBonds: bondIndices.length / 2,
      positions: null,
      elements: null,
      nAtoms: 0,
    })),
  };
});

import { WidgetViewer } from "@/components/WidgetViewer";
import { Viewport } from "@/components/Viewport";
import { Tooltip } from "@/components/Tooltip";
import { MeasurementPanel } from "@/components/MeasurementPanel";
import { inferBondsVdwJS } from "@/parsers/inferBondsJS";
import { createPipelineStore } from "@/pipeline/store";

const mockViewport = vi.mocked(Viewport);
const mockTooltip = vi.mocked(Tooltip);
const mockMeasurementPanel = vi.mocked(MeasurementPanel);
const mockInferBondsVdwJS = vi.mocked(inferBondsVdwJS);

const defaultProps = {
  snapshot: null,
  frame: null,
  currentFrame: 0,
  totalFrames: 1,
  onSeek: vi.fn(),
};

describe("WidgetViewer", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("passes non-noop handlers to Viewport", () => {
    render(<WidgetViewer {...defaultProps} />);
    const props = mockViewport.mock.calls[0][0];
    expect(props.onHover).toBeTypeOf("function");
    expect(props.onAtomRightClick).toBeTypeOf("function");
    expect(props.onFrameUpdated).toBeTypeOf("function");
  });

  it("renders Tooltip overlay", () => {
    render(<WidgetViewer {...defaultProps} />);
    expect(mockTooltip).toHaveBeenCalled();
  });

  it("renders MeasurementPanel overlay", () => {
    render(<WidgetViewer {...defaultProps} />);
    expect(mockMeasurementPanel).toHaveBeenCalled();
  });

  it("calling Viewport onHover updates Tooltip info", () => {
    render(<WidgetViewer {...defaultProps} />);
    const viewportProps = mockViewport.mock.calls[0][0];

    const atomInfo: HoverInfo = {
      kind: "atom",
      atomIndex: 3,
      elementSymbol: "N",
      atomicNumber: 7,
      position: [0, 0, 0],
      screenX: 100,
      screenY: 200,
    };

    act(() => {
      viewportProps.onHover(atomInfo);
    });

    const lastTooltipProps = mockTooltip.mock.lastCall?.[0];
    expect(lastTooltipProps?.info).toEqual(atomInfo);
  });

  it("Tooltip starts with null info before any hover", () => {
    render(<WidgetViewer {...defaultProps} />);
    const tooltipProps = mockTooltip.mock.calls[0][0];
    expect(tooltipProps.info).toBeNull();
  });

  it("renders the axis-alignment buttons and forwards clicks to the renderer", () => {
    const { getByTestId, queryByTestId } = render(<WidgetViewer {...defaultProps} />);
    // No snapshot → no cell → only the Cartesian row.
    expect(getByTestId("view-axis-controls")).toBeTruthy();
    expect(queryByTestId("view-axis-row-lattice")).toBeNull();

    const alignCameraToAxis = vi.fn();
    const renderer = new Proxy(
      {},
      { get: (_t, prop) => (prop === "alignCameraToAxis" ? alignCameraToAxis : vi.fn()) },
    );
    act(() => {
      mockViewport.mock.calls[0][0].onRendererReady?.(renderer as never);
    });
    fireEvent.click(getByTestId("view-axis-+y"));
    expect(alignCameraToAxis).toHaveBeenCalledWith("+y");
  });

  it("shows the crystal-axis row once a snapshot with a cell is loaded", () => {
    const snapshot: Snapshot = {
      nAtoms: 1,
      nBonds: 0,
      nFileBonds: 0,
      positions: new Float32Array([0, 0, 0]),
      elements: new Uint8Array([6]),
      bonds: new Uint32Array(0),
      bondOrders: null,
      box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
      boxOrigin: null,
    };
    const { getByTestId } = render(<WidgetViewer {...defaultProps} snapshot={snapshot} />);
    expect(getByTestId("view-axis-row-lattice")).toBeTruthy();
    expect(getByTestId("view-axis-+a")).toBeTruthy();
  });
});

describe("WidgetViewer — per-frame bond recalc", () => {
  // Build a minimal O–H snapshot (no bonds yet — distance mode infers them).
  function makeSnapshot(): Snapshot {
    return {
      nAtoms: 2,
      nBonds: 0,
      nFileBonds: 0,
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      elements: new Uint8Array([8, 1]),
      bonds: new Uint32Array(0),
      bondOrders: null,
      box: null,
    };
  }

  function seedDistanceBondPipeline(
    store: ReturnType<typeof createPipelineStore>,
    snapshot: Snapshot | null,
  ) {
    // Replace the default pipeline with a single add_bond(distance) node.
    store.setState({
      nodes: [
        {
          id: "bond-test",
          type: "add_bond",
          position: { x: 0, y: 0 },
          data: {
            params: { type: "add_bond", bondSource: "distance" },
            enabled: true,
          },
        },
      ],
      edges: [],
      snapshot,
      atomLabels: null,
      structureFrames: null,
      structureMeta: null,
      fileFrames: null,
      fileMeta: null,
      fileVectors: null,
      nodeSnapshots: {},
      nodeParseErrors: {},
      nodeStreamingData: {},
      nodeErrors: {},
    });
  }

  /**
   * MoleculeRenderer has many methods (setAtomsVisible, setCellVisible, ...).
   * Return a Proxy whose properties are all no-op spies so any call succeeds.
   * The bond-recalc effect only needs `updateBondsExt` to be spyable.
   */
  function makeFakeRenderer(): { renderer: unknown; updateBondsExt: ReturnType<typeof vi.fn> } {
    const updateBondsExt = vi.fn();
    const renderer = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "updateBondsExt") return updateBondsExt;
          return vi.fn();
        },
      },
    );
    return { renderer, updateBondsExt };
  }

  beforeEach(() => {
    mockInferBondsVdwJS.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("recomputes bonds per frame when store snapshot is set and prop snapshot is null", () => {
    // Reproduce the bug: in pipeline mode `snapshot` prop is null,
    // but the store snapshot is populated from `_node_snapshots_data`.
    const store = createPipelineStore();
    seedDistanceBondPipeline(store, null);

    const frame1: Frame = {
      frameId: 0,
      nAtoms: 2,
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    };

    const { rerender } = render(
      <WidgetViewer
        {...defaultProps}
        snapshot={null}
        frame={frame1}
        currentFrame={0}
        totalFrames={6}
        pipelineStore={store}
      />,
    );

    // Wire up a fake renderer — the effect bails if rendererRef.current is null.
    const viewportProps = mockViewport.mock.calls[0][0];
    const { renderer, updateBondsExt } = makeFakeRenderer();
    act(() => {
      viewportProps.onRendererReady?.(renderer as any);
    });

    // Now populate the store snapshot as `nodeSnapshotsData` would in prod.
    // This must happen AFTER the initial mount effect — otherwise the
    // legacy-fallback effect resets store.snapshot to the (null) prop.
    const storeSnap = makeSnapshot();
    act(() => {
      store.getState().setSnapshot(storeSnap);
    });

    // Advance to a new frame where the O–H distance has grown past the cutoff.
    const frame2: Frame = {
      frameId: 1,
      nAtoms: 2,
      positions: new Float32Array([0, 0, 0, 5, 0, 0]),
    };
    act(() => {
      rerender(
        <WidgetViewer
          {...defaultProps}
          snapshot={null}
          frame={frame2}
          currentFrame={1}
          totalFrames={6}
          pipelineStore={store}
        />,
      );
    });

    // The effect must reach inferBondsVdwJS (not early-return on null prop).
    expect(mockInferBondsVdwJS).toHaveBeenCalled();
    const calls = mockInferBondsVdwJS.mock.calls;
    // The most recent call must use the advanced frame positions and the
    // store snapshot's elements (not the null prop).
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(frame2.positions);
    expect(last[1]).toBe(storeSnap.elements);
    expect(last[2]).toBe(storeSnap.nAtoms);
    // And updateBondsExt must be invoked so stick geometry refreshes.
    expect(updateBondsExt).toHaveBeenCalled();
  });

  /**
   * Encode a Snapshot into the binary protocol that `decodeNodeSnapshot`
   * expects. Mirrors python/megane/protocol.py write_snapshot but only
   * supports the no-bond-orders / no-box subset we need here.
   */
  function encodeSnapshot(snap: Snapshot): DataView {
    const HEADER = 8;
    const positionsBytes = snap.nAtoms * 3 * 4;
    let elementsBytes = snap.nAtoms;
    elementsBytes += (4 - (elementsBytes % 4)) % 4; // pad to 4
    const bondsBytes = snap.nBonds * 2 * 4;
    const total = HEADER + 4 + 4 + positionsBytes + elementsBytes + bondsBytes;

    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    view.setUint32(0, 0x4e47454d, true); // "MEGN"
    view.setUint8(4, 0); // MSG_SNAPSHOT
    view.setUint8(5, 0); // flags: no bond orders, no box
    let offset = HEADER;
    view.setUint32(offset, snap.nAtoms, true);
    offset += 4;
    view.setUint32(offset, snap.nBonds, true);
    offset += 4;
    new Float32Array(buffer, offset, snap.nAtoms * 3).set(snap.positions);
    offset += positionsBytes;
    new Uint8Array(buffer, offset, snap.nAtoms).set(snap.elements);
    offset += elementsBytes;
    if (snap.nBonds > 0) {
      new Uint32Array(buffer, offset, snap.nBonds * 2).set(snap.bonds);
    }
    return new DataView(buffer);
  }

  it("renders particles when AddLabels + AddPolyhedra pipeline + nodeSnapshotsData arrive together (blank-ipywidget regression)", () => {
    // Repro of the user's bug: set_pipeline pushes both _pipeline_json and
    // _node_snapshots_data; the WidgetViewer must populate per-node
    // snapshots in the same store transaction as the deserialize, otherwise
    // executeLoadStructure runs with a null snapshot and the canvas stays
    // blank (only the pivot crosshair shows).
    const store = createPipelineStore();

    const snapshot = makeSnapshot();
    const pipelineJson = JSON.stringify({
      version: 3,
      nodes: [
        {
          type: "load_structure",
          id: "loader-w",
          position: { x: 0, y: 0 },
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
          enabled: true,
        },
        {
          type: "label_generator",
          id: "labels-w",
          position: { x: 200, y: 0 },
          source: "element",
          enabled: true,
        },
        {
          type: "polyhedron_generator",
          id: "poly-w",
          position: { x: 200, y: 200 },
          excludedCenters: [],
          excludedLigands: [],
          cutoffTolerance: 1.15,
          opacity: 0.6,
          showEdges: true,
          enabled: true,
        },
        {
          type: "viewport",
          id: "viewport-w",
          position: { x: 400, y: 100 },
          perspective: false,
          cellAxesVisible: true,
          enabled: true,
        },
      ],
      edges: [
        {
          source: "loader-w",
          target: "labels-w",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
        {
          source: "loader-w",
          target: "poly-w",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
        {
          source: "loader-w",
          target: "viewport-w",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
        {
          source: "labels-w",
          target: "viewport-w",
          sourceHandle: "label",
          targetHandle: "label",
        },
        {
          source: "poly-w",
          target: "viewport-w",
          sourceHandle: "mesh",
          targetHandle: "mesh",
        },
      ],
    });
    const nodeSnapshotsData = { "loader-w": encodeSnapshot(snapshot) };

    render(
      <WidgetViewer
        {...defaultProps}
        snapshot={null}
        pipelineJson={pipelineJson}
        nodeSnapshotsData={nodeSnapshotsData}
        pipelineStore={store}
      />,
    );

    const state = store.getState();
    expect(state.viewportState.particles.length).toBeGreaterThan(0);
    expect(state.viewportState.particles[0].source.nAtoms).toBe(snapshot.nAtoms);
    // The legacy global snapshot must also be set so Viewport.loadSnapshot
    // has data to feed to the renderer.
    expect(state.snapshot).not.toBeNull();
    expect(state.snapshot?.nAtoms).toBe(snapshot.nAtoms);
  });

  it("does not call inferBondsVdwJS when both prop and store snapshot are null", () => {
    // Guards must still work: no snapshot from either source → no bond recalc.
    const store = createPipelineStore();
    seedDistanceBondPipeline(store, null);

    const frame1: Frame = {
      frameId: 0,
      nAtoms: 2,
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    };
    const { rerender } = render(
      <WidgetViewer
        {...defaultProps}
        snapshot={null}
        frame={frame1}
        currentFrame={0}
        totalFrames={6}
        pipelineStore={store}
      />,
    );

    const viewportProps = mockViewport.mock.calls[0][0];
    const { renderer } = makeFakeRenderer();
    act(() => {
      viewportProps.onRendererReady?.(renderer as any);
    });

    const frame2: Frame = {
      frameId: 1,
      nAtoms: 2,
      positions: new Float32Array([0, 0, 0, 5, 0, 0]),
    };
    act(() => {
      rerender(
        <WidgetViewer
          {...defaultProps}
          snapshot={null}
          frame={frame2}
          currentFrame={1}
          totalFrames={6}
          pipelineStore={store}
        />,
      );
    });

    expect(mockInferBondsVdwJS).not.toHaveBeenCalled();
  });

  it("two WidgetViewers with separate stores do not stomp on each other (multi-viewport regression)", () => {
    // Repro of the multi-viewport bug: rendering two MolecularViewers in the
    // same notebook used to share a singleton pipeline store, so the second
    // viewer's loadPipeline() would clobber the first viewer's pipeline and
    // leave the first canvas blank. With per-instance stores, each viewer
    // keeps its own pipeline.
    const storeA = createPipelineStore();
    const storeB = createPipelineStore();

    const snapshotA = makeSnapshot();
    const snapshotB = makeSnapshot();

    const pipelineJsonA = JSON.stringify({
      version: 3,
      nodes: [
        {
          type: "load_structure",
          id: "loader-a",
          position: { x: 0, y: 0 },
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
          enabled: true,
        },
        {
          type: "viewport",
          id: "viewport-a",
          position: { x: 200, y: 0 },
          perspective: false,
          cellAxesVisible: true,
          enabled: true,
        },
      ],
      edges: [
        {
          source: "loader-a",
          target: "viewport-a",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    });
    const pipelineJsonB = JSON.stringify({
      version: 3,
      nodes: [
        {
          type: "load_structure",
          id: "loader-b",
          position: { x: 0, y: 0 },
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
          enabled: true,
        },
        {
          type: "viewport",
          id: "viewport-b",
          position: { x: 200, y: 0 },
          perspective: false,
          cellAxesVisible: true,
          enabled: true,
        },
      ],
      edges: [
        {
          source: "loader-b",
          target: "viewport-b",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    });

    render(
      <WidgetViewer
        {...defaultProps}
        snapshot={null}
        pipelineJson={pipelineJsonA}
        nodeSnapshotsData={{ "loader-a": encodeSnapshot(snapshotA) }}
        pipelineStore={storeA}
      />,
    );
    render(
      <WidgetViewer
        {...defaultProps}
        snapshot={null}
        pipelineJson={pipelineJsonB}
        nodeSnapshotsData={{ "loader-b": encodeSnapshot(snapshotB) }}
        pipelineStore={storeB}
      />,
    );

    const stateA = storeA.getState();
    const stateB = storeB.getState();
    expect(stateA.nodes.find((n) => n.id === "loader-a")).toBeDefined();
    expect(stateA.nodes.find((n) => n.id === "loader-b")).toBeUndefined();
    expect(stateB.nodes.find((n) => n.id === "loader-b")).toBeDefined();
    expect(stateB.nodes.find((n) => n.id === "loader-a")).toBeUndefined();
    expect(stateA.viewportState.particles.length).toBeGreaterThan(0);
    expect(stateB.viewportState.particles.length).toBeGreaterThan(0);
  });
});
