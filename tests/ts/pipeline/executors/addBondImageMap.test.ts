/**
 * Every bond stream whose `positions` append periodic ghost atoms says where
 * each ghost comes from (`imageMap`), and re-deriving the ghosts from that map
 * reproduces the executor's own positions exactly. The renderer relies on this
 * to move the ghosts with their atoms during trajectory playback.
 */

import { describe, expect, it } from "vitest";
import { generateDrawingBoundaryImages } from "@/logic/cellBoundaryImages";
import { positionsWithPeriodicImages } from "@/logic/periodicImages";
import { bondDataFromSnapshotBonds, executeAddBond } from "@/pipeline/executors/addBond";
import { executeBoundaryCompletion } from "@/pipeline/executors/boundaryCompletion";
import type { AddBondParams, BondData, ParticleData, PipelineData } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function snapshot(box: number[] | null): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    // 0–1 crosses the x face; 1–2 is an ordinary bond inside the cell.
    positions: new Float32Array([0.3, 1, 1, 3.7, 1, 1, 3.7, 2.2, 1]),
    elements: new Uint8Array([6, 6, 1]),
    bonds: new Uint32Array([0, 1, 1, 2]),
    bondOrders: new Uint8Array([1, 2]),
    box: box ? new Float32Array(box) : null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const CUBE = [4, 0, 0, 0, 4, 0, 0, 0, 4];

function particle(s: Snapshot, boundary = false): ParticleData {
  return {
    type: "particle",
    source: s,
    sourceNodeId: "load",
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
    ...(boundary ? { drawingBoundary: generateDrawingBoundaryImages(s) } : {}),
  };
}

function addBond(p: ParticleData, params: Partial<AddBondParams> = {}): BondData {
  return executeAddBond(
    { type: "add_bond", bondSource: "structure", ...params } as AddBondParams,
    new Map<string, PipelineData[]>([["particle", [p]]]),
  ).get("bond") as BondData;
}

/** The executor's positions match the map re-applied to the structure's atoms. */
function expectMapReproducesPositions(bond: BondData, s: Snapshot, box: number[]): void {
  expect(bond.imageMap).toBeTruthy();
  expect(bond.imageMap!.sourceIndices.length).toBe(bond.nAtoms - s.nAtoms);
  expect(bond.imageMap!.latticeShifts.length).toBe((bond.nAtoms - s.nAtoms) * 3);
  const rebuilt = positionsWithPeriodicImages(s.positions, s.nAtoms, bond.imageMap!, box);
  expect(Array.from(rebuilt)).toEqual(Array.from(bond.positions!));
}

describe("add_bond periodic image maps", () => {
  it("maps the two ghosts of a cell-crossing structure bond", () => {
    const s = snapshot(CUBE);
    const bond = addBond(particle(s));
    expect(bond.nAtoms).toBe(5);
    expect(Array.from(bond.imageMap!.sourceIndices)).toEqual([1, 0]);
    expect(Array.from(bond.imageMap!.latticeShifts)).toEqual([-1, 0, 0, 1, 0, 0]);
    const ghosts = Array.from(bond.positions!.subarray(9), (v) => Math.round(v * 1e5) / 1e5);
    expect(ghosts).toEqual([-0.3, 1, 1, 4.3, 1, 1]);
    expectMapReproducesPositions(bond, s, CUBE);
  });

  it("maps distance-inferred ghosts too", () => {
    const s = snapshot(CUBE);
    const bond = addBond(particle(s), { bondSource: "distance" });
    expectMapReproducesPositions(bond, s, CUBE);
  });

  it("maps the Drawing Boundary copies the bonds end on", () => {
    const s = snapshot(CUBE);
    const p = particle(s, true);
    const bond = addBond(p);
    expect(bond.imageMap!.sourceIndices).toBe(p.drawingBoundary!.images.sourceIndices);
    expectMapReproducesPositions(bond, s, CUBE);
  });

  it("maps the Builder's snapshot-bond stream", () => {
    const s = snapshot(CUBE);
    const bond = bondDataFromSnapshotBonds(particle(s))!;
    expectMapReproducesPositions(bond, s, CUBE);
  });

  it("has no map without ghosts", () => {
    expect(addBond(particle(snapshot(null))).imageMap).toBeNull();
    const inside = { ...snapshot(CUBE), nBonds: 1, bonds: new Uint32Array([1, 2]) };
    const bond = addBond(particle(inside));
    expect(bond.positions).toBeNull();
    expect(bond.imageMap).toBeNull();
  });

  it("maps Boundary Completion's completed copies", () => {
    const s = snapshot(CUBE);
    const p: ParticleData = {
      ...particle(s),
      drawingBoundary: generateDrawingBoundaryImages(s, [0, -0.1, -0.1], [0.5, 1, 1]),
    };
    const result = executeBoundaryCompletion(
      { type: "boundary_completion", mode: "components" },
      new Map<string, PipelineData[]>([
        ["particle", [p]],
        ["bond", [addBond(p)]],
      ]),
    );
    const completed = result.get("particle") as ParticleData;
    const bond = result.get("bond") as BondData;
    expect(bond.imageMap!.sourceIndices).toBe(completed.drawingBoundary!.images.sourceIndices);
    expectMapReproducesPositions(bond, s, CUBE);
  });
});
