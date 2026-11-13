import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import {
  distanceBondVdwScale,
  hasDistanceBondNode,
  useFrameDistanceBonds,
  type FrameBondRenderer,
} from "@/hooks/useFrameDistanceBonds";
import type { PipelineNodeData } from "@/pipeline/execute";
import type { Frame, Snapshot } from "@/types";

const snapshot: Snapshot = {
  nAtoms: 3,
  nBonds: 0,
  nFileBonds: 0,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 10, 0, 0]),
  elements: new Uint8Array([8, 1, 1]),
  bonds: new Uint32Array(0),
  bondOrders: null,
  box: null,
  boxOrigin: null,
  atomChainIds: null,
  atomBFactors: null,
};

// Frame 1 moves the far hydrogen next to the oxygen: O bonds both hydrogens,
// and the two hydrogens (√2 Å apart) also fall inside the default VDW cutoff.
const frame: Frame = {
  frameId: 1,
  nAtoms: 3,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
};

function makeRenderer(): FrameBondRenderer {
  return { updateBondsExt: vi.fn() };
}

function bondNode(params: Record<string, unknown>): Node<PipelineNodeData> {
  return {
    id: "b1",
    type: "add_bond",
    position: { x: 0, y: 0 },
    data: { params: { type: "add_bond", ...params } },
  } as Node<PipelineNodeData>;
}

describe("useFrameDistanceBonds", () => {
  it("recomputes bonds through the executor and updates the renderer", () => {
    const renderer = makeRenderer();
    const rendererRef = { current: renderer };
    const onBondCount = vi.fn();

    renderHook(() =>
      useFrameDistanceBonds({
        rendererRef,
        snapshot,
        frame,
        enabled: true,
        vdwScale: undefined,
        onBondCount,
      }),
    );

    expect(renderer.updateBondsExt).toHaveBeenCalledTimes(1);
    const [bondIndices] = vi.mocked(renderer.updateBondsExt).mock.calls[0];
    expect(Array.from(bondIndices)).toEqual([0, 1, 0, 2, 1, 2]);
    expect(onBondCount).toHaveBeenCalledWith(3);
  });

  it("does nothing when no distance-bond node is enabled", () => {
    const renderer = makeRenderer();
    renderHook(() =>
      useFrameDistanceBonds({
        rendererRef: { current: renderer },
        snapshot,
        frame,
        enabled: false,
        vdwScale: undefined,
      }),
    );
    expect(renderer.updateBondsExt).not.toHaveBeenCalled();
  });

  it("does nothing before the renderer is ready", () => {
    const onBondCount = vi.fn();
    renderHook(() =>
      useFrameDistanceBonds({
        rendererRef: { current: null },
        snapshot,
        frame,
        enabled: true,
        vdwScale: undefined,
        onBondCount,
      }),
    );
    expect(onBondCount).not.toHaveBeenCalled();
  });
});

// Heterogeneous trajectories: frames that add or remove atoms mid-run (an Ar
// atom implanted into a periodic Si slab every few hundred steps) carry their
// own elements, atom count, and possibly cell.
describe("useFrameDistanceBonds with a heterogeneous frame", () => {
  const BOX = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

  /** Two Si atoms 2.3 Å apart across the x face of the 10 Å box. */
  const siPair: Snapshot = {
    ...snapshot,
    nAtoms: 2,
    positions: new Float32Array([0.5, 5, 5, 8.2, 5, 5]),
    elements: new Uint8Array([14, 14]),
    box: BOX,
  };

  function bondCall(renderer: FrameBondRenderer) {
    expect(renderer.updateBondsExt).toHaveBeenCalledTimes(1);
    const [bonds, , positions, elements, nAtoms] = vi.mocked(renderer.updateBondsExt).mock.calls[0];
    return { bonds: Array.from(bonds), positions, elements, nAtoms };
  }

  function run(snap: Snapshot, f: Frame): FrameBondRenderer {
    const renderer = makeRenderer();
    renderHook(() =>
      useFrameDistanceBonds({
        rendererRef: { current: renderer },
        snapshot: snap,
        frame: f,
        enabled: true,
        vdwScale: undefined,
      }),
    );
    return renderer;
  }

  it("keeps half-bonds on their ghost images when atoms were appended", () => {
    // Frame: the same Si pair plus an Ar atom 6 Å away from both, high in the box.
    const grown: Frame = {
      frameId: 5,
      nAtoms: 3,
      positions: new Float32Array([0.5, 5, 5, 8.2, 5, 5, 5, 5, 9]),
      elements: new Uint8Array([14, 14, 18]),
    };

    const { bonds, positions, elements, nAtoms } = bondCall(run(siPair, grown));

    // Ghosts are numbered after all three real atoms…
    expect(bonds).toEqual([0, 3, 1, 4]);
    expect(nAtoms).toBe(5);
    expect(Array.from(elements!)).toEqual([14, 14, 18, 14, 14]);
    // …and every half-bond is as long as the 2.3 Å bond, none reaches the Ar.
    for (let b = 0; b < bonds.length; b += 2) {
      const [i, j] = [bonds[b], bonds[b + 1]];
      const d = Math.hypot(
        positions![j * 3] - positions![i * 3],
        positions![j * 3 + 1] - positions![i * 3 + 1],
        positions![j * 3 + 2] - positions![i * 3 + 2],
      );
      expect(d).toBeCloseTo(2.3, 4);
    }
  });

  it("bonds an appended atom by its own element", () => {
    // No cell: a free Si-O pair, then an O atom added 1.6 Å from the Si.
    const free: Snapshot = { ...siPair, box: null };
    const grown: Frame = {
      frameId: 1,
      nAtoms: 3,
      positions: new Float32Array([0, 0, 0, 6, 0, 0, 1.6, 0, 0]),
      elements: new Uint8Array([14, 14, 8]),
    };

    const { bonds, positions, elements, nAtoms } = bondCall(run(free, grown));

    expect(bonds).toEqual([0, 2]);
    // No ghosts, so the renderer is handed the frame's own atoms, not frame 0's.
    expect(positions).toBe(grown.positions);
    expect(elements).toBe(grown.elements);
    expect(nAtoms).toBe(3);
  });

  it("reads no atom past a frame that lost atoms", () => {
    const shrunk: Frame = {
      frameId: 2,
      nAtoms: 1,
      positions: new Float32Array([0.5, 5, 5]),
      elements: new Uint8Array([14]),
    };

    const { bonds, nAtoms } = bondCall(run(siPair, shrunk));

    expect(bonds).toEqual([]);
    expect(nAtoms).toBe(1);
  });

  it("uses the frame's own cell when it carries one", () => {
    // Frame 0 has no cell; this frame's cell puts the pair across a face.
    const withCell: Frame = {
      frameId: 3,
      nAtoms: 2,
      positions: new Float32Array([0.5, 5, 5, 8.2, 5, 5]),
      box: BOX,
    };

    const { bonds, nAtoms } = bondCall(run({ ...siPair, box: null }, withCell));

    expect(bonds).toEqual([0, 2, 1, 3]);
    expect(nAtoms).toBe(4);
  });
});

describe("distance-bond node selectors", () => {
  const distance = bondNode({ bondSource: "distance", vdwScale: 0.8 });
  const structure = bondNode({ bondSource: "structure" });

  it("detects a distance-mode add_bond node", () => {
    expect(hasDistanceBondNode([structure, distance])).toBe(true);
    expect(hasDistanceBondNode([structure])).toBe(false);
    expect(hasDistanceBondNode([])).toBe(false);
  });

  it("reads the active node's VDW scale, undefined otherwise", () => {
    expect(distanceBondVdwScale([structure, distance])).toBe(0.8);
    expect(distanceBondVdwScale([bondNode({ bondSource: "distance" })])).toBeUndefined();
    expect(distanceBondVdwScale([structure])).toBeUndefined();
  });
});
