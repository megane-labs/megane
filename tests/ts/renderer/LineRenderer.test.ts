import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LineRenderer } from "@/renderer/LineRenderer";
import { getColor } from "@/constants";
import type { Snapshot } from "@/types";

/** Two atoms (C, O) joined by one bond along the X axis. */
function makeBondedSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    nFileBonds: 1,
    positions: new Float32Array([0, 0, 0, 2, 0, 0]),
    elements: new Uint8Array([6, 8]), // C, O
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
    box: null,
  } as Snapshot;
}

/** A single atom with no bonds (drawn as a cross). */
function makeLoneAtomSnapshot(): Snapshot {
  return {
    nAtoms: 1,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([1, 2, 3]),
    elements: new Uint8Array([11]), // Na
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
  } as Snapshot;
}

/** A visible renderer, which builds its geometry as soon as it is loaded. */
function shownLineRenderer(): LineRenderer {
  const lr = new LineRenderer();
  lr.setVisible(true);
  return lr;
}

describe("LineRenderer", () => {
  it("constructs a hidden LineSegments with vertex colors", () => {
    const lr = new LineRenderer();
    expect(lr.mesh).toBeInstanceOf(THREE.LineSegments);
    expect(lr.mesh.visible).toBe(false);
    const mat = lr.mesh.material as THREE.LineBasicMaterial;
    expect(mat.vertexColors).toBe(true);
  });

  it("setVisible toggles visibility", () => {
    const lr = new LineRenderer();
    lr.setVisible(true);
    expect(lr.mesh.visible).toBe(true);
    lr.setVisible(false);
    expect(lr.mesh.visible).toBe(false);
  });

  it("splits a bond into two segments (4 vertices) at the midpoint", () => {
    const lr = shownLineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    const pos = lr.mesh.geometry.getAttribute("position");
    expect(pos.count).toBe(4); // 2 segments × 2 endpoints

    const arr = pos.array as Float32Array;
    // seg 1: atom A (0,0,0) → midpoint (1,0,0)
    expect(Array.from(arr.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(arr.slice(3, 6))).toEqual([1, 0, 0]);
    // seg 2: midpoint (1,0,0) → atom B (2,0,0)
    expect(Array.from(arr.slice(6, 9))).toEqual([1, 0, 0]);
    expect(Array.from(arr.slice(9, 12))).toEqual([2, 0, 0]);
  });

  it("colors each bond half with the color of its nearer atom (two-tone)", () => {
    const lr = shownLineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    const colors = lr.mesh.geometry.getAttribute("color").array as Float32Array;
    const cC = getColor(6);
    const cO = getColor(8);
    const expectColorAt = (vertex: number, rgb: [number, number, number]): void => {
      for (let c = 0; c < 3; c++) {
        expect(colors[vertex * 3 + c]).toBeCloseTo(rgb[c], 5);
      }
    };
    // First segment (both vertices) carries carbon color.
    expectColorAt(0, cC);
    expectColorAt(1, cC);
    // Second segment carries oxygen color.
    expectColorAt(2, cO);
    expectColorAt(3, cO);
  });

  it("draws a 3-axis cross (6 vertices) for a bondless atom", () => {
    const lr = shownLineRenderer();
    lr.loadSnapshot(makeLoneAtomSnapshot());
    const pos = lr.mesh.geometry.getAttribute("position");
    expect(pos.count).toBe(6); // 3 segments × 2 endpoints
    const arr = pos.array as Float32Array;
    // Each pair of vertices is symmetric about the atom center (1,2,3).
    for (let seg = 0; seg < 3; seg++) {
      const a = arr.slice(seg * 6, seg * 6 + 3);
      const b = arr.slice(seg * 6 + 3, seg * 6 + 6);
      expect((a[0] + b[0]) / 2).toBeCloseTo(1);
      expect((a[1] + b[1]) / 2).toBeCloseTo(2);
      expect((a[2] + b[2]) / 2).toBeCloseTo(3);
    }
  });

  it("updatePositions moves the bond vertices for a new frame", () => {
    const lr = shownLineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    // Move atom B from x=2 to x=4 → midpoint should become x=2.
    lr.updatePositions(new Float32Array([0, 0, 0, 4, 0, 0]));
    const arr = lr.mesh.geometry.getAttribute("position").array as Float32Array;
    expect(Array.from(arr.slice(3, 6))).toEqual([2, 0, 0]); // new midpoint
    expect(Array.from(arr.slice(9, 12))).toEqual([4, 0, 0]); // new atom B
  });

  it("updatePositions is a no-op before loadSnapshot", () => {
    const lr = new LineRenderer();
    expect(() => lr.updatePositions(new Float32Array([1, 2, 3]))).not.toThrow();
    expect(lr.mesh.geometry.getAttribute("position")).toBeUndefined();
  });

  it("lineMask draws only bonds whose both endpoints are flagged", () => {
    // Three atoms: bond 0-1 (both line), bond 1-2 (mixed) → only 0-1 drawn.
    const snapshot = {
      nAtoms: 3,
      nBonds: 2,
      nFileBonds: 2,
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 4, 0, 0]),
      elements: new Uint8Array([8, 1, 6]), // O, H, C
      bonds: new Uint32Array([0, 1, 1, 2]),
      bondOrders: null,
      box: null,
    } as Snapshot;
    const lr = shownLineRenderer();
    lr.loadSnapshot(snapshot, new Uint8Array([1, 1, 0]));
    // Only the 0-1 bond is fully inside the mask → 1 bond → 2 segments → 4 verts.
    expect(lr.mesh.geometry.getAttribute("position").count).toBe(4);
  });

  it("lineMask crosses only masked lone atoms", () => {
    // Two bondless atoms; mask flags just one → one cross (6 verts).
    const snapshot = {
      nAtoms: 2,
      nBonds: 0,
      nFileBonds: 0,
      positions: new Float32Array([0, 0, 0, 5, 0, 0]),
      elements: new Uint8Array([11, 11]),
      bonds: new Uint32Array(0),
      bondOrders: null,
      box: null,
    } as Snapshot;
    const lr = shownLineRenderer();
    lr.loadSnapshot(snapshot, new Uint8Array([1, 0]));
    expect(lr.mesh.geometry.getAttribute("position").count).toBe(6);
  });

  it("builds nothing while hidden and builds on show", () => {
    const lr = new LineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    expect(lr.mesh.geometry.getAttribute("position")).toBeUndefined();
    lr.setVisible(true);
    expect(lr.mesh.geometry.getAttribute("position").count).toBe(4);
  });

  it("builds from the latest frame when first shown mid-trajectory", () => {
    const lr = new LineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    lr.updatePositions(new Float32Array([0, 0, 0, 4, 0, 0]));
    lr.setVisible(true);
    const arr = lr.mesh.geometry.getAttribute("position").array as Float32Array;
    expect(Array.from(arr.slice(3, 6))).toEqual([2, 0, 0]);
    expect(Array.from(arr.slice(9, 12))).toEqual([4, 0, 0]);
  });

  it("catches up on frames that arrived while hidden", () => {
    const lr = shownLineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    lr.setVisible(false);
    lr.updatePositions(new Float32Array([0, 0, 0, 6, 0, 0]));
    const attr = lr.mesh.geometry.getAttribute("position");
    // Hidden: untouched.
    expect(Array.from((attr.array as Float32Array).slice(9, 12))).toEqual([2, 0, 0]);
    lr.setVisible(true);
    expect(Array.from((attr.array as Float32Array).slice(9, 12))).toEqual([6, 0, 0]);
    expect(Array.from((attr.array as Float32Array).slice(3, 6))).toEqual([3, 0, 0]);
  });

  it("starts from the new snapshot's positions after a reload", () => {
    const lr = new LineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    lr.updatePositions(new Float32Array([0, 0, 0, 8, 0, 0]));
    const next = makeBondedSnapshot();
    lr.loadSnapshot(next);
    lr.setVisible(true);
    const arr = lr.mesh.geometry.getAttribute("position").array as Float32Array;
    expect(Array.from(arr.slice(9, 12))).toEqual([2, 0, 0]);
  });

  it("dispose frees geometry and material", () => {
    const lr = shownLineRenderer();
    lr.loadSnapshot(makeBondedSnapshot());
    expect(() => lr.dispose()).not.toThrow();
  });
});
