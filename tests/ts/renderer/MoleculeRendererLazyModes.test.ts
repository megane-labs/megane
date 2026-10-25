/**
 * MoleculeRenderer keeps the representations that are switched off from
 * costing memory: the line geometry is only built while lines are drawn, and
 * the drawn positions are the snapshot's own array until a trajectory frame
 * needs a private copy.
 */

import { describe, it, expect, vi } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import { LineRenderer } from "@/renderer/LineRenderer";
import type { Snapshot, Frame } from "@/types";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 1,
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 9, 9, 9]),
    elements: new Uint8Array([6, 8, 11]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
  } as Snapshot;
}

function makeRenderer() {
  const renderer = new MoleculeRenderer();
  const snapshot = makeSnapshot();
  const atom = new ImpostorAtomMesh(64);
  atom.loadSnapshot(snapshot);
  const bond = new ImpostorBondMesh(64);
  bond.loadSnapshot(snapshot);
  const line = new LineRenderer();
  line.loadSnapshot(snapshot);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = renderer as any;
  internals.snapshot = snapshot;
  internals.currentPositions = snapshot.positions;
  internals.atomRenderer = atom;
  internals.bondRenderer = bond;
  internals.lineRenderer = line;
  internals.scene = { add: () => {}, remove: () => {} };
  return { renderer, snapshot, line, internals };
}

function frame(positions: number[]): Frame {
  return { frameId: 1, nAtoms: 3, positions: new Float32Array(positions) };
}

describe("MoleculeRenderer — representations built on demand", () => {
  it("does not build the line geometry while lines are off", () => {
    const { renderer, line } = makeRenderer();
    renderer.setRepresentationType("atoms");
    renderer.setRepresentationByAtom(null);
    expect(line.mesh.visible).toBe(false);
    expect(line.mesh.geometry.getAttribute("position")).toBeUndefined();
  });

  it("builds the lines at the current frame when line mode is turned on", () => {
    const { renderer, line } = makeRenderer();
    renderer.setRepresentationType("atoms");
    renderer.updateFrame(frame([0, 0, 0, 6, 0, 0, 9, 9, 9]));
    renderer.setBondsVisible(true);
    renderer.setRepresentationType("line");
    expect(line.mesh.visible).toBe(true);
    const arr = line.mesh.geometry.getAttribute("position").array as Float32Array;
    // Bond 0-1 is drawn at frame positions: midpoint x=3, atom B x=6.
    expect(Array.from(arr.slice(3, 6))).toEqual([3, 0, 0]);
    expect(Array.from(arr.slice(9, 12))).toEqual([6, 0, 0]);
  });

  it("does not rebuild the whole structure as lines when a line subset is cleared", () => {
    const { renderer, line } = makeRenderer();
    renderer.setRepresentationType("atoms");
    renderer.setRepresentationByAtom(["line", "line", "atoms"]);
    const subset = line.mesh.geometry.getAttribute("position");
    expect(subset.count).toBe(4); // bond 0-1 only
    renderer.setRepresentationByAtom(null);
    expect(line.mesh.visible).toBe(false);
    // Hidden before the reload, so the full structure was never built.
    expect(line.mesh.geometry.getAttribute("position")).toBe(subset);
  });

  it("loads the immersive view's code only when asked, ignoring a failed load", async () => {
    const { renderer, internals } = makeRenderer();
    const preload = vi.fn(() => Promise.reject(new Error("offline")));
    internals.xr = { preload };
    renderer.preloadXR();
    expect(preload).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // the rejection is swallowed, not unhandled
  });

  it("draws the snapshot's positions without copying them, and copies on the first frame", () => {
    const { renderer, snapshot, internals } = makeRenderer();
    expect(internals.currentPositions).toBe(snapshot.positions);
    renderer.updateFrame(frame([1, 1, 1, 2, 2, 2, 3, 3, 3]));
    // The frame went into a private buffer; the snapshot is untouched.
    expect(internals.currentPositions).not.toBe(snapshot.positions);
    expect(Array.from(snapshot.positions)).toEqual([0, 0, 0, 2, 0, 0, 9, 9, 9]);
    const owned = internals.currentPositions;
    renderer.updateFrame(frame([4, 4, 4, 5, 5, 5, 6, 6, 6]));
    expect(internals.currentPositions).toBe(owned);
    expect(Array.from(owned)).toEqual([4, 4, 4, 5, 5, 5, 6, 6, 6]);
  });
});
