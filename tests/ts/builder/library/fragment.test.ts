import { describe, it, expect } from "vitest";
import {
  autoPlacement,
  autoPlacementInfo,
  describePlacement,
  emptySpotInCell,
  moleculeRadius,
  bounds,
  centered,
  centroid,
  formulaOf,
  fragmentOp,
  geometryFromSnapshot,
  isPlanar,
  newFragmentId,
  scaleBondsToCovalent,
  PLACEMENT_MARGIN,
} from "@/builder/library/fragment";
import { applyEditOps } from "@/pipeline/executors/edit";
import { getCovalentRadius } from "@/constants";
import type { Snapshot } from "@/types";

function water(box: Float32Array | null = null): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([1, 1, 1, 1.757, 1.586, 1, 0.243, 1.586, 1]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: new Uint8Array([1, 2]),
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

describe("fragment geometry helpers", () => {
  it("centroid, centered and bounds", () => {
    expect(centroid([])).toEqual([0, 0, 0]);
    expect(centroid([0, 0, 0, 2, 4, 6])).toEqual([1, 2, 3]);
    const c = centered({ elements: [1, 1], positions: [0, 0, 0, 2, 4, 6], bonds: [] });
    expect(c.positions).toEqual([-1, -2, -3, 1, 2, 3]);
    expect(bounds([])).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    expect(bounds([1, 5, -2, -3, 2, 4])).toEqual({ min: [-3, 2, -2], max: [1, 5, 4] });
  });

  it("isPlanar is true only for a non-empty z = 0 geometry", () => {
    expect(isPlanar([])).toBe(false);
    expect(isPlanar([1, 2, 0, 3, 4, 0])).toBe(true);
    expect(isPlanar([1, 2, 0, 3, 4, 0.5])).toBe(false);
  });

  it("scales a unit-bond sketch to covalent bond lengths and leaves bondless ones alone", () => {
    const sketch = {
      elements: [6, 6],
      positions: [0, 0, 0, 1, 0, 0],
      bonds: [[0, 1]] as [number, number][],
    };
    const scaled = scaleBondsToCovalent(sketch);
    expect(scaled.positions[3]).toBeCloseTo(2 * getCovalentRadius(6));
    const lone = { elements: [6], positions: [0, 0, 0], bonds: [] };
    expect(scaleBondsToCovalent(lone)).toBe(lone);
    const degenerate = {
      elements: [6, 6],
      positions: [0, 0, 0, 0, 0, 0],
      bonds: [[0, 1]] as [number, number][],
    };
    expect(scaleBondsToCovalent(degenerate)).toBe(degenerate);
  });

  it("reads a whole snapshot or a subset with the bonds inside it", () => {
    const all = geometryFromSnapshot(water());
    expect(all.elements).toEqual([8, 1, 1]);
    expect(all.bonds).toEqual([
      [0, 1],
      [0, 2],
    ]);
    expect(all.bondOrders).toEqual([1, 2]);
    const sub = geometryFromSnapshot(water(), [2, 0, 2]);
    expect(sub.elements).toEqual([8, 1]);
    expect(sub.positions).toEqual([1, 1, 1, 0.243, 1.586, 1].map((v) => Math.fround(v)));
    expect(sub.bonds).toEqual([[0, 1]]);
    expect(sub.bondOrders).toEqual([2]);
    const single = geometryFromSnapshot(water(), [0, 1]);
    expect(single.bondOrders).toBeUndefined();
  });

  it("writes Hill-order formulas", () => {
    expect(formulaOf([])).toBe("");
    expect(formulaOf([8, 1, 1])).toBe("H2O");
    expect(formulaOf([6, 6, 8, 1, 1, 1, 1, 1, 1])).toBe("C2H6O");
    expect(formulaOf([6, 17, 17, 17, 17])).toBe("CCl4");
    expect(formulaOf([11, 17])).toBe("ClNa");
  });

  it("auto placement: beside atoms, at the cell centre, or at the origin", () => {
    const geometry = { elements: [6, 6], positions: [-1, 0, 0, 1, 0, 0], bonds: [] };
    expect(autoPlacement(null, geometry)).toEqual([0, 0, 0]);
    const beside = autoPlacement(water(), geometry);
    expect(beside[0]).toBeCloseTo(Math.fround(1.757) + PLACEMENT_MARGIN + 1);
    expect(beside[1]).toBeCloseTo((1 + Math.fround(1.586)) / 2);
    expect(beside[2]).toBeCloseTo(1);
    const empty: Snapshot = {
      ...water(new Float32Array([10, 0, 0, 0, 8, 0, 0, 0, 6])),
      nAtoms: 0,
      nBonds: 0,
      positions: new Float32Array(0),
      elements: new Uint8Array(0),
      bonds: new Uint32Array(0),
      boxOrigin: new Float32Array([1, 1, 1]),
    };
    expect(autoPlacement(empty, geometry)).toEqual([6, 5, 4]);
    expect(autoPlacement({ ...empty, box: null, boxOrigin: null }, geometry)).toEqual([0, 0, 0]);
  });

  it("in a cell with atoms, prefers the emptiest spot inside the cell when the molecule fits", () => {
    const geometry = { elements: [6, 6], positions: [-1, 0, 0, 1, 0, 0], bonds: [] };
    expect(moleculeRadius(geometry)).toBeCloseTo(1);
    expect(moleculeRadius({ elements: [], positions: [], bonds: [] })).toBe(0);
    const big = water(new Float32Array([12, 0, 0, 0, 12, 0, 0, 0, 12]));
    const info = autoPlacementInfo(big, geometry);
    expect(info.kind).toBe("in-cell");
    // Inside the cell and well clear of the water (minimum image).
    for (const v of info.at) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(12);
    }
    const nearest = Math.min(
      ...[0, 1, 2].map((a) => {
        const d = [0, 1, 2].map((k) => {
          let x = (info.at[k] - big.positions[a * 3 + k]) / 12;
          x -= Math.round(x);
          return x * 12;
        });
        return Math.hypot(...d);
      }),
    );
    expect(nearest).toBeGreaterThan(1 + 2);
    expect(autoPlacement(big, geometry)).toEqual(info.at);
    // A cell too small to hold it: beside the structure instead.
    const tiny = water(new Float32Array([3, 0, 0, 0, 3, 0, 0, 0, 3]));
    expect(autoPlacementInfo(tiny, geometry).kind).toBe("beside");
    expect(emptySpotInCell(tiny, 1)).toBeNull();
    // A degenerate cell or no cell has no inside.
    expect(emptySpotInCell(water(new Float32Array(9)), 0)).toBeNull();
    expect(emptySpotInCell(water(), 0)).toBeNull();
    // The origin shifts the grid with the cell.
    const shifted = { ...big, boxOrigin: new Float32Array([100, 0, 0]) };
    expect(emptySpotInCell(shifted, 0)![0]).toBeGreaterThan(100);
  });

  it("describes where a molecule went", () => {
    expect(describePlacement({ at: [1, 2.25, 3], kind: "in-cell" })).toBe(
      "in the emptiest part of the cell, at (1.0, 2.3, 3.0) Å",
    );
    expect(describePlacement({ at: [5, 0, 0], kind: "beside" })).toContain("beside the structure");
    expect(describePlacement({ at: [5, 5, 5], kind: "cell-centre" })).toBe(
      "at the cell centre, (5.0, 5.0, 5.0) Å",
    );
    expect(describePlacement({ at: [0, 0, 0], kind: "origin" })).toBe("at the origin");
    expect(autoPlacementInfo(null, { elements: [], positions: [], bonds: [] }).kind).toBe("origin");
  });

  it("fragment ids carry the name; the op translates the centred geometry", () => {
    const a = newFragmentId("Carbon dioxide");
    const b = newFragmentId("!!!");
    expect(a).toMatch(/^carbon-dioxide-\d+$/);
    expect(b).toMatch(/^fragment-\d+$/);
    expect(a).not.toBe(newFragmentId("Carbon dioxide"));
    const geometry = {
      elements: [6, 8],
      positions: [-0.5, 0, 0, 0.5, 0, 0],
      bonds: [[0, 1]] as [number, number][],
      bondOrders: [2],
    };
    const op = fragmentOp("co-1", geometry, [10, 0, 0]);
    expect(op).toEqual({
      op: "add_fragment",
      id: "co-1",
      elements: [6, 8],
      positions: [-0.5, 0, 0, 0.5, 0, 0],
      bonds: [[0, 1]],
      bondOrders: [2],
      translate: [10, 0, 0],
    });
    const { snapshot } = applyEditOps(water(), [op]);
    expect(snapshot.nAtoms).toBe(5);
    expect(snapshot.positions[9]).toBeCloseTo(9.5);
    expect(snapshot.bondOrders![2]).toBe(2);
    expect(fragmentOp("x", { ...geometry, bondOrders: undefined }, [0, 0, 0])).not.toHaveProperty(
      "bondOrders",
    );
  });
});
