/**
 * WidgetViewer on the shared useViewportStateSync / useControlledPlayback:
 * primary-structure routing, camera restore order, render cost of pipeline
 * edits, and the Timeline transport.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Profiler } from "react";
import { render, act, cleanup } from "@testing-library/react";
import type { Snapshot } from "@/types";

vi.mock("@/components/Viewport", () => ({ Viewport: vi.fn(() => null) }));
vi.mock("@/components/Timeline", () => ({ Timeline: vi.fn(() => null) }));
vi.mock("@/components/Tooltip", () => ({ Tooltip: vi.fn(() => null) }));
vi.mock("@/components/MeasurementPanel", () => ({ MeasurementPanel: vi.fn(() => null) }));

import { WidgetViewer } from "@/components/WidgetViewer";
import { Viewport } from "@/components/Viewport";
import { Timeline } from "@/components/Timeline";
import { createPipelineStore } from "@/pipeline/store";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";

const mockViewport = vi.mocked(Viewport);
const mockTimeline = vi.mocked(Timeline);

function makeSnapshot(nAtoms: number): Snapshot {
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms).fill(6),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
  };
}

/** A renderer whose every method is a spy; layer ids are recorded. */
function makeRenderer() {
  const layers: string[] = [];
  const calls: string[] = [];
  const applyCameraState = vi.fn(() => calls.push("applyCameraState"));
  const renderer = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "getOrCreateLayer") {
          return (id: string) => {
            layers.push(id);
            return new Proxy({}, { get: () => vi.fn() });
          };
        }
        if (prop === "applyCameraState") return applyCameraState;
        if (prop === "getLayerIds") return () => [];
        return vi.fn();
      },
    },
  ) as unknown as MoleculeRenderer;
  return { renderer, layers, calls, applyCameraState };
}

const loader = (id: string) => ({
  type: "load_structure",
  id,
  position: { x: 0, y: 0 },
  fileName: null,
  hasTrajectory: false,
  hasCell: false,
  enabled: true,
});

/** Two structures whose viewport edges list the *higher* id first. */
const TWO_STRUCTURES = {
  version: 3,
  nodes: [
    loader("load_structure-1"),
    loader("load_structure-2"),
    {
      type: "viewport",
      id: "viewport-1",
      position: { x: 0, y: 0 },
      perspective: false,
      cellAxesVisible: true,
      enabled: true,
    },
  ],
  edges: [
    {
      source: "load_structure-2",
      target: "viewport-1",
      sourceHandle: "particle",
      targetHandle: "particle",
    },
    {
      source: "load_structure-1",
      target: "viewport-1",
      sourceHandle: "particle",
      targetHandle: "particle",
    },
  ],
};

/** Binary snapshot message as `_node_snapshots_data` carries it (no bonds / box). */
function encodeSnapshot(snap: Snapshot): DataView {
  const header = 8;
  const positionsBytes = snap.nAtoms * 12;
  const elementsBytes = snap.nAtoms + ((4 - (snap.nAtoms % 4)) % 4);
  const buffer = new ArrayBuffer(header + 8 + positionsBytes + elementsBytes);
  const view = new DataView(buffer);
  view.setUint32(0, 0x4e47454d, true); // "MEGN"
  view.setUint8(4, 0); // MSG_SNAPSHOT
  view.setUint8(5, 0); // flags
  view.setUint32(header, snap.nAtoms, true);
  view.setUint32(header + 4, 0, true);
  new Float32Array(buffer, header + 8, snap.nAtoms * 3).set(snap.positions);
  new Uint8Array(buffer, header + 8 + positionsBytes, snap.nAtoms).set(snap.elements);
  return new DataView(buffer);
}

const baseProps = {
  snapshot: null,
  frame: null,
  currentFrame: 0,
  totalFrames: 1,
  onSeek: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WidgetViewer viewport sync", () => {
  it("draws every other structure as a layer, not the one the Viewport shows (behaviour change)", () => {
    const store = createPipelineStore();
    const json = JSON.stringify(TWO_STRUCTURES);
    render(<WidgetViewer {...baseProps} pipelineJson={json} pipelineStore={store} />);
    const a = makeSnapshot(2);
    const b = makeSnapshot(3);
    act(() => {
      store.getState().loadPipeline(JSON.parse(json), {
        "load_structure-1": { snapshot: a, frames: null, meta: null, labels: null },
        "load_structure-2": { snapshot: b, frames: null, meta: null, labels: null },
      });
    });
    // The Viewport loads the lowest-id node's snapshot into the built-in meshes…
    expect(mockViewport.mock.lastCall?.[0].snapshot).toBe(a);
    // …while the first particle stream comes from the other node.
    expect(store.getState().viewportState.particles[0].sourceNodeId).toBe("load_structure-2");

    const { renderer, layers } = makeRenderer();
    act(() => mockViewport.mock.lastCall![0].onRendererReady!(renderer));
    // Before the fix, load_structure-1 (already in the built-in meshes) was
    // drawn again as a layer and load_structure-2 was never drawn.
    expect(layers.length).toBeGreaterThan(0);
    expect(new Set(layers)).toEqual(new Set(["load_structure-2"]));
  });

  it("restores the saved camera only after the Viewport received the pipeline snapshot", () => {
    // set_pipeline path: the snapshot arrives through nodeSnapshotsData, so the
    // Viewport first renders with none and fits to the pipeline snapshot on the
    // next commit. Restoring the camera before that fit lets it overwrite the
    // saved camera (the old in-effect restore did exactly that).
    const store = createPipelineStore();
    const saved = { mode: "orthographic", position: [1, 2, 3], target: [0, 0, 0], zoom: 2 };
    const { renderer, applyCameraState } = makeRenderer();
    const viewportSnapshots: (Snapshot | null)[] = [];
    mockViewport.mockImplementation((props) => {
      viewportSnapshots.push(props.snapshot);
      return null;
    });
    const viewportHadSnapshotAtRestore: boolean[] = [];
    applyCameraState.mockImplementation(() =>
      viewportHadSnapshotAtRestore.push(viewportSnapshots.at(-1) != null),
    );

    const json = JSON.stringify({ ...TWO_STRUCTURES, nodes: [TWO_STRUCTURES.nodes[0]], edges: [] });
    const props = { ...baseProps, initialCameraState: saved as never, pipelineStore: store };
    const { rerender } = render(<WidgetViewer {...props} />);
    act(() => mockViewport.mock.lastCall![0].onRendererReady!(renderer));
    expect(applyCameraState).not.toHaveBeenCalled();

    act(() => {
      rerender(
        <WidgetViewer
          {...props}
          pipelineJson={json}
          nodeSnapshotsData={{ "load_structure-1": encodeSnapshot(makeSnapshot(2)) }}
        />,
      );
    });
    expect(viewportSnapshots.at(-1)?.nAtoms).toBe(2);
    expect(applyCameraState).toHaveBeenCalledTimes(1);
    expect(applyCameraState).toHaveBeenCalledWith(saved);
    expect(viewportHadSnapshotAtRestore).toEqual([true]);
  });

  it("does not re-render on pipeline edits that only change the viewport state", () => {
    const store = createPipelineStore();
    let commits = 0;
    render(
      <Profiler id="w" onRender={() => commits++}>
        <WidgetViewer {...baseProps} snapshot={makeSnapshot(2)} pipelineStore={store} />
      </Profiler>,
    );
    const viewport = store.getState().nodes.find((n) => n.type === "viewport")!;
    const before = commits;
    const vsBefore = store.getState().viewportState;
    for (let i = 0; i < 20; i++) {
      act(() =>
        store.getState().updateNodeParams(viewport.id, { perspective: i % 2 === 0 } as never),
      );
    }
    expect(store.getState().viewportState).not.toBe(vsBefore);
    // Was 2 commits per edit with the render-path `viewportState` selector.
    expect(commits - before).toBeLessThanOrEqual(1);
  });
});

describe("WidgetViewer playback", () => {
  it("drives the host through onSeek and pauses on scrub", () => {
    vi.useFakeTimers();
    try {
      const onSeek = vi.fn();
      render(<WidgetViewer {...baseProps} totalFrames={4} currentFrame={3} onSeek={onSeek} />);
      const props = () => mockTimeline.mock.lastCall![0];
      expect(props().totalFrames).toBe(4);
      expect(props().loopEnd).toBe(3);

      act(() => props().onPlayPause());
      expect(props().playing).toBe(true);
      act(() => vi.advanceTimersByTime(1000 / 30 + 1));
      // Frame 3 is the last one: the tick wraps to the loop start.
      expect(onSeek).toHaveBeenLastCalledWith(0);

      act(() => props().onSeek(2));
      expect(props().playing).toBe(false);
      expect(onSeek).toHaveBeenLastCalledWith(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
