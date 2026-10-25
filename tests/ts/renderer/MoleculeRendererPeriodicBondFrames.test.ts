/**
 * Half-bonds across the cell during trajectory playback.
 *
 * A bond that crosses the periodic cell is drawn as two half-bonds, each ending
 * at a ghost copy of the far atom appended after the real atoms in the bond
 * mesh's position texture. A positions-only trajectory frame carries just the
 * real atoms, so the ghosts must be re-derived from their source atom and
 * lattice shift; writing the frame straight into the texture read past its end
 * and turned every ghost texel into NaN, which made all boundary-crossing
 * half-bonds vanish from the first frame on.
 */

import { describe, it, expect } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import { executeAddBond } from "@/pipeline/executors/addBond";
import { applyViewportState } from "@/pipeline/apply";
import {
  DEFAULT_VIEWPORT_STATE,
  type BondData,
  type ParticleData,
  type PipelineData,
} from "@/pipeline/types";
import type { Frame, Snapshot } from "@/types";

/** Two carbons bonded across the x face of a 4 Å cubic cell. */
function crossingSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    nFileBonds: 1,
    positions: new Float32Array([0.3, 1, 1, 3.7, 1, 1]),
    elements: new Uint8Array([6, 6]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
    box: new Float32Array([4, 0, 0, 0, 4, 0, 0, 0, 4]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function particle(snapshot: Snapshot): ParticleData {
  return {
    type: "particle",
    source: snapshot,
    sourceNodeId: "load",
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
  };
}

function structureBonds(snapshot: Snapshot): BondData {
  return executeAddBond(
    { type: "add_bond", bondSource: "structure" },
    new Map<string, PipelineData[]>([["particle", [particle(snapshot)]]]),
  ).get("bond") as BondData;
}

function setup() {
  const renderer = new MoleculeRenderer();
  const snapshot = crossingSnapshot();
  const atom = new ImpostorAtomMesh(8);
  const bond = new ImpostorBondMesh(16);
  atom.loadSnapshot(snapshot);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = renderer as any;
  internals.atomRenderer = atom;
  internals.bondRenderer = bond;
  internals.snapshot = snapshot;
  // A frame with its own cell redraws the cell outline and axes inset.
  internals.cellRenderer = { loadBox: () => undefined };
  internals.cellAxesRenderer = { loadBox: () => undefined };
  return { renderer, snapshot, bond, internals };
}

/** RGB of texel `i` in the bond mesh's position texture. */
function texel(bond: ImpostorBondMesh, i: number): number[] {
  const data = (bond as unknown as { positionTexData: Float32Array }).positionTexData;
  return [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]].map((v) => Math.round(v * 1e5) / 1e5);
}

function frame(positions: number[], box?: number[]): Frame {
  return {
    frameId: 1,
    nAtoms: 2,
    positions: new Float32Array(positions),
    ...(box ? { box: new Float32Array(box) } : {}),
  } as Frame;
}

function load(renderer: MoleculeRenderer, b: BondData): void {
  renderer.updateBondsExt(
    b.bondIndices,
    b.bondOrders,
    b.positions,
    b.elements,
    b.nAtoms,
    b.imageMap,
  );
}

describe("MoleculeRenderer — periodic half-bonds during playback", () => {
  it("moves the ghost endpoints with their atoms on a positions-only frame", () => {
    const { renderer, bond } = setup();
    const b = structureBonds(crossingSnapshot());
    // Two half-bonds, each to a ghost appended after the two real atoms.
    expect(b.nAtoms).toBe(4);
    load(renderer, b);
    expect(texel(bond, 2)).toEqual([-0.3, 1, 1]); // atom 1 shifted by −a
    expect(texel(bond, 3)).toEqual([4.3, 1, 1]); // atom 0 shifted by +a

    renderer.updateFrame(frame([0.4, 1.5, 1, 3.6, 1.5, 1]));
    expect(texel(bond, 0)).toEqual([0.4, 1.5, 1]);
    expect(texel(bond, 1)).toEqual([3.6, 1.5, 1]);
    expect(texel(bond, 2)).toEqual([-0.4, 1.5, 1]);
    expect(texel(bond, 3)).toEqual([4.4, 1.5, 1]);
  });

  it("uses the frame's own cell when the frame carries one", () => {
    const { renderer, bond } = setup();
    load(renderer, structureBonds(crossingSnapshot()));
    renderer.updateFrame(frame([0.3, 1, 1, 4.7, 1, 1], [5, 0, 0, 0, 5, 0, 0, 0, 5]));
    expect(texel(bond, 2)).toEqual([-0.3, 1, 1]);
    expect(texel(bond, 3)).toEqual([5.3, 1, 1]);
  });

  it("never writes NaN into ghost texels it cannot re-derive", () => {
    const { renderer, bond } = setup();
    const b = structureBonds(crossingSnapshot());
    // Per-frame distance bonds hand over ghosts without a map: the next frame
    // has nothing to move them with, so they keep their last position.
    renderer.updateBondsExt(b.bondIndices, b.bondOrders, b.positions, b.elements, b.nAtoms);
    renderer.updateFrame(frame([0.4, 1, 1, 3.6, 1, 1]));
    expect(texel(bond, 0)).toEqual([0.4, 1, 1]);
    expect(texel(bond, 2)).toEqual([-0.3, 1, 1]);
    expect(texel(bond, 3)).toEqual([4.3, 1, 1]);
  });

  it("drops the map when the bonds are replaced without ghosts", () => {
    const { renderer, internals } = setup();
    const b = structureBonds(crossingSnapshot());
    load(renderer, b);
    expect(internals.bondImageMap).toBe(b.imageMap);
    renderer.updateBonds(new Uint32Array([0, 1]), null);
    expect(internals.bondImageMap).toBeNull();
    load(renderer, b);
    // A map that does not describe the appended atoms is not trusted.
    renderer.updateBondsExt(b.bondIndices, b.bondOrders, b.positions, b.elements, 3, b.imageMap);
    expect(internals.bondImageMap).toBeNull();
  });

  it("keeps the map through the pending-bonds replay", () => {
    const renderer = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = renderer as any;
    const bond = new ImpostorBondMesh(16);
    internals.atomRenderer = new ImpostorAtomMesh(8);
    internals.bondRenderer = bond;
    const b = structureBonds(crossingSnapshot());
    load(renderer, b); // no snapshot yet → stashed
    expect(internals.pendingBonds.imageMap).toBe(b.imageMap);
    internals.snapshot = crossingSnapshot();
    internals.flushPendingBonds();
    renderer.updateFrame(frame([0.4, 1, 1, 3.6, 1, 1]));
    expect(texel(bond, 3)).toEqual([4.4, 1, 1]);
  });

  it("is handed the map by applyViewportState", () => {
    const { renderer, bond } = setup();
    const snapshot = crossingSnapshot();
    // Only the bond upload is real; the rest of the viewport state needs a scene.
    const stub = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "updateBondsExt" ? renderer.updateBondsExt.bind(renderer) : () => undefined,
      },
    ) as MoleculeRenderer;
    applyViewportState(
      stub,
      {
        ...DEFAULT_VIEWPORT_STATE,
        particles: [particle(snapshot)],
        bonds: [structureBonds(snapshot)],
      },
      null,
    );
    renderer.updateFrame(frame([0.4, 1, 1, 3.6, 1, 1]));
    expect(texel(bond, 2)).toEqual([-0.4, 1, 1]);
  });
});
