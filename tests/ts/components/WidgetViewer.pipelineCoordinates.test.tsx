/**
 * WidgetViewer draws what the pipeline produces: the structure as it reaches
 * the viewport, and the frames Python delivers mapped by every node between
 * the trajectory and the viewport.
 *
 * Before, the Viewport was given the file's own snapshot and the frame as
 * delivered, so a `Wrap` (or `Symmetry`, `Replicate`) node had no effect in
 * the Jupyter widget: atoms the pipeline had wrapped were drawn outside the
 * cell.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import type { Frame, Snapshot } from "@/types";

vi.mock("@/components/Viewport", () => ({ Viewport: vi.fn(() => null) }));
vi.mock("@/components/Timeline", () => ({ Timeline: vi.fn(() => null) }));
vi.mock("@/components/Tooltip", () => ({ Tooltip: vi.fn(() => null) }));
vi.mock("@/components/MeasurementPanel", () => ({ MeasurementPanel: vi.fn(() => null) }));

import { WidgetViewer } from "@/components/WidgetViewer";
import { Viewport } from "@/components/Viewport";
import { createPipelineStore } from "@/pipeline/store";
import { HostFrameProvider } from "@/stream/HostFrameProvider";

const mockViewport = vi.mocked(Viewport);
const viewportProps = () => mockViewport.mock.lastCall![0];

const CUBIC = () => new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

/** Two argon atoms in a 10 Å cell; atom 0 sits outside it. */
function makeSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([15, 5, 5, 2, 2, 2]),
    elements: new Uint8Array([18, 18]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: CUBIC(),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const frame = (frameId: number, x: number, extra: Partial<Frame> = {}): Frame => ({
  frameId,
  nAtoms: 2,
  positions: new Float32Array([x, 5, 5, 2, 2, 2]),
  ...extra,
});

const at = { position: { x: 0, y: 0 }, enabled: true };
const edge = (source: string, target: string, handle: string) => ({
  source,
  target,
  sourceHandle: handle,
  targetHandle: handle,
});

/**
 * load_structure → [middle node] → viewport, as the Python `Pipeline` builder
 * writes it. With `routeTrajectory` the trajectory goes through the middle
 * node too; without it there is no trajectory edge into the viewport at all.
 */
function pipeline(middle: Record<string, unknown>, routeTrajectory = true) {
  return {
    version: 3,
    nodes: [
      {
        type: "load_structure",
        id: "load_structure-1",
        fileName: null,
        hasTrajectory: true,
        hasCell: true,
        ...at,
      },
      { type: "load_trajectory", id: "load_trajectory-1", fileName: null, ...at },
      { id: "middle-1", ...middle, ...at },
      {
        type: "viewport",
        id: "viewport-1",
        perspective: false,
        cellAxesVisible: true,
        ...at,
      },
    ],
    edges: [
      edge("load_structure-1", "load_trajectory-1", "particle"),
      edge("load_structure-1", "middle-1", "particle"),
      edge("middle-1", "viewport-1", "particle"),
      ...(routeTrajectory
        ? [
            edge("load_trajectory-1", "middle-1", "trajectory"),
            edge("middle-1", "viewport-1", "trajectory"),
          ]
        : []),
    ],
  };
}

const WRAP = { type: "wrap", mode: "wrap" };

const baseProps = {
  snapshot: null,
  frame: null,
  currentFrame: 0,
  totalFrames: 0,
  onSeek: vi.fn(),
};

/** The structure as `_node_snapshots_data` carries it: a snapshot message with a box. */
function encodeSnapshot(snap: Snapshot): DataView {
  const header = 8;
  const positionsBytes = snap.nAtoms * 12;
  const elementsBytes = snap.nAtoms + ((4 - (snap.nAtoms % 4)) % 4);
  const buffer = new ArrayBuffer(header + 8 + positionsBytes + elementsBytes + 36);
  const view = new DataView(buffer);
  view.setUint32(0, 0x4e47454d, true); // "MEGN"
  view.setUint8(4, 0); // MSG_SNAPSHOT
  view.setUint8(5, 0x02); // HAS_BOX
  view.setUint32(header, snap.nAtoms, true);
  view.setUint32(header + 4, 0, true);
  new Float32Array(buffer, header + 8, snap.nAtoms * 3).set(snap.positions);
  new Uint8Array(buffer, header + 8 + positionsBytes, snap.nAtoms).set(snap.elements);
  new Float32Array(buffer, header + 8 + positionsBytes + elementsBytes, 9).set(snap.box!);
  return new DataView(buffer);
}

type Props = Parameters<typeof WidgetViewer>[0];

/** Mount a viewer the way `set_pipeline` feeds it: pipeline JSON + per-node snapshots. */
function mount(config: object, props: Partial<Props> = {}) {
  const store = createPipelineStore();
  const all: Props = {
    ...baseProps,
    pipelineJson: JSON.stringify(config),
    nodeSnapshotsData: { "load_structure-1": encodeSnapshot(makeSnapshot()) },
    pipelineStore: store,
    ...props,
  };
  const view = render(<WidgetViewer {...all} />);
  const update = (next: Partial<Props>) => view.rerender(<WidgetViewer {...all} {...next} />);
  return { store, update };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WidgetViewer pipeline coordinates", () => {
  it("draws the structure as the Wrap node leaves it, not as the file has it", () => {
    const { store } = mount(pipeline(WRAP));
    const drawn = viewportProps().snapshot!;
    expect(drawn).not.toBe(store.getState().snapshot);
    expect(Array.from(drawn.positions)).toEqual([5, 5, 5, 2, 2, 2]);
  });

  it("draws the file's own snapshot when no node changes it", () => {
    const { store } = mount(pipeline({ type: "wrap", mode: "none" }));
    expect(store.getState().snapshot).not.toBeNull();
    expect(viewportProps().snapshot).toBe(store.getState().snapshot);
  });

  it("maps every frame Python delivers through the Wrap node", () => {
    const { update } = mount(pipeline(WRAP), { totalFrames: 3 });
    // No frame delivered yet (the kernel sends one when frame_index changes).
    expect(viewportProps().frame).toBeNull();

    update({ totalFrames: 3, currentFrame: 1, frame: frame(1, 16) });
    expect(Array.from(viewportProps().frame!.positions)).toEqual([6, 5, 5, 2, 2, 2]);
    expect(viewportProps().frame!.frameId).toBe(1);

    update({ totalFrames: 3, currentFrame: 2, frame: frame(2, -3) });
    expect(Array.from(viewportProps().frame!.positions)).toEqual([7, 5, 5, 2, 2, 2]);
  });

  it("wraps a frame in the cell it carries (variable-cell run)", () => {
    const { update } = mount(pipeline(WRAP), { totalFrames: 3 });
    const box = new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20]);
    update({ totalFrames: 3, currentFrame: 1, frame: frame(1, 26, { box }) });
    const drawn = viewportProps().frame!;
    expect(Array.from(drawn.positions)).toEqual([6, 5, 5, 2, 2, 2]);
    expect(drawn.box).toBe(box);
  });

  it("replicates the delivered frame like the structure it is drawn over", () => {
    const { update } = mount(pipeline({ type: "replicate", nx: 2, ny: 1, nz: 1 }), {
      totalFrames: 3,
    });
    expect(viewportProps().snapshot!.nAtoms).toBe(4);
    update({ totalFrames: 3, currentFrame: 1, frame: frame(1, 1) });
    const drawn = viewportProps().frame!;
    expect(drawn.nAtoms).toBe(4);
    expect(Array.from(drawn.positions)).toEqual([1, 5, 5, 2, 2, 2, 11, 5, 5, 12, 2, 2]);
  });

  it("draws the frame as delivered when no trajectory is routed to the viewport", () => {
    const { update } = mount(pipeline(WRAP, false), { totalFrames: 3 });
    const delivered = frame(1, 16);
    update({ totalFrames: 3, currentFrame: 1, frame: delivered });
    expect(viewportProps().frame).toBe(delivered);
  });

  it("gives the pipeline a trajectory source only while there are frames", () => {
    const { store, update } = mount(pipeline(WRAP));
    expect(store.getState().fileProvider).toBeNull();
    expect(store.getState().viewportState.trajectories).toHaveLength(0);

    update({ totalFrames: 3 });
    const provider = store.getState().fileProvider;
    expect(provider).toBeInstanceOf(HostFrameProvider);
    expect(provider!.meta).toEqual({ nFrames: 3, timestepPs: 0, nAtoms: 2 });
    expect(store.getState().viewportState.trajectories).toHaveLength(1);

    // The same trajectory keeps its source; another length is another one.
    update({ totalFrames: 3, currentFrame: 1 });
    expect(store.getState().fileProvider).toBe(provider);
    update({ totalFrames: 5 });
    expect(store.getState().fileProvider).not.toBe(provider);
    expect(store.getState().fileProvider!.meta.nFrames).toBe(5);

    update({ totalFrames: 0 });
    expect(store.getState().fileProvider).toBeNull();
  });

  it("puts the trajectory source back after a new pipeline replaced the graph", () => {
    // `loadPipeline` clears the store's file channels (set_pipeline again).
    const { store, update } = mount(pipeline(WRAP), { totalFrames: 3 });
    const next = pipeline({ type: "wrap", mode: "unwrap" });
    update({ totalFrames: 3, pipelineJson: JSON.stringify(next) });
    expect(store.getState().fileProvider).toBeInstanceOf(HostFrameProvider);
    expect(store.getState().viewportState.trajectories).toHaveLength(1);
  });

  it("does not reload the structure for a pipeline edit that leaves it unchanged", () => {
    // Quick Style edits re-execute the pipeline. The wrapped structure and
    // frame are the same objects afterwards, so the Viewport reloads nothing.
    const { store, update } = mount(pipeline(WRAP), { totalFrames: 3 });
    update({ totalFrames: 3, currentFrame: 1, frame: frame(1, 16) });
    const before = viewportProps();
    const renders = mockViewport.mock.calls.length;
    act(() => {
      store.getState().updateNodeParams("viewport-1", { perspective: true });
    });
    expect(mockViewport.mock.calls.length).toBe(renders);
    expect(viewportProps().snapshot).toBe(before.snapshot);
    expect(viewportProps().frame).toBe(before.frame);
  });

  it("draws the legacy .load() structure and frame through the default pipeline", () => {
    // No pipeline JSON and no per-node snapshots: `snapshot` + `frame` props.
    const store = createPipelineStore();
    const snapshot = makeSnapshot();
    const delivered = frame(1, 16);
    render(
      <WidgetViewer
        {...baseProps}
        snapshot={snapshot}
        frame={delivered}
        currentFrame={1}
        totalFrames={3}
        pipelineStore={store}
      />,
    );
    // The default graph's Wrap node is off: both arrive as they were given.
    expect(Array.from(viewportProps().snapshot!.positions)).toEqual([15, 5, 5, 2, 2, 2]);
    expect(Array.from(viewportProps().frame!.positions)).toEqual([16, 5, 5, 2, 2, 2]);
    expect(store.getState().fileProvider).toBeInstanceOf(HostFrameProvider);
  });
});
