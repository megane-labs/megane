import { describe, it, expect } from "vitest";
import { builderViewportState, BUILDER_SOURCE_ID } from "@/builder/view";
import type { Snapshot } from "@/types";

function water(box: Float32Array | null = null, nFileBonds = 2): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds,
    positions: new Float32Array([1, 1, 1, 1.757, 1.586, 1, 0.243, 1.586, 1]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

describe("builderViewportState", () => {
  const box = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

  it("is the empty default without a structure", () => {
    const view = builderViewportState(null);
    expect(view.particles).toEqual([]);
    expect(view.bonds).toEqual([]);
    expect(view.cells).toEqual([]);
  });

  it("draws every atom, the structure's own bonds and its cell as ball-and-stick", () => {
    const view = builderViewportState(water(box));
    expect(view.particles).toHaveLength(1);
    expect(view.particles[0].source.nAtoms).toBe(3);
    expect(view.particles[0].indices).toBeNull();
    expect(view.particles[0].sourceNodeId).toBe(BUILDER_SOURCE_ID);
    expect(view.bonds).toHaveLength(1);
    expect(view.bonds[0].nBonds).toBe(2);
    expect(view.bonds[0].sourceNodeId).toBe(BUILDER_SOURCE_ID);
    expect(view.cells).toHaveLength(1);
    expect(view.cells[0].box).toBe(box);
    expect(view.trajectories).toEqual([]);
    expect(view.representationMode).toBe("atoms");
    expect(view.representationByAtom).toBeNull();
    expect(view.cellAxesVisible).toBe(true);
    expect(view.pivotMarkerVisible).toBe(true);
  });

  it("draws parser-inferred bonds too (nFileBonds 0) and no cell for a zero box", () => {
    const view = builderViewportState(water(new Float32Array(9), 0));
    expect(view.bonds[0].nBonds).toBe(2);
    expect(view.cells).toEqual([]);
  });

  it("completes a bond across the cell boundary with a ghost atom", () => {
    const wrapped: Snapshot = {
      ...water(box),
      positions: new Float32Array([0.1, 1, 1, 9.9, 1, 1, 0.243, 1.586, 1]),
    };
    const view = builderViewportState(wrapped);
    expect(view.bonds[0].positions).not.toBeNull();
    expect(view.bonds[0].nAtoms).toBeGreaterThan(3);
  });

  it("has no bond stream for a structure without bonds", () => {
    const lonely: Snapshot = { ...water(), nBonds: 0, nFileBonds: 0, bonds: new Uint32Array(0) };
    expect(builderViewportState(lonely).bonds).toEqual([]);
  });
});
