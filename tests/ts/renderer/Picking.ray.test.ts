import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { pickAtomOnRay } from "@/renderer/Picking";
import type { Snapshot } from "@/types";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "@/pipeline/types";
import { BALL_STICK_ATOM_SCALE, getRadius } from "@/constants";

function snapshot(positions: number[], elements: number[]): Snapshot {
  return {
    nAtoms: elements.length,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(positions),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
  };
}

/** A ray from (x, y, 10) straight down −z. */
const down = (x = 0, y = 0) =>
  new THREE.Ray(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1));

const C = 6;
const rC = getRadius(C) * BALL_STICK_ATOM_SCALE;

function images(positions: number[], sources: number[]): PeriodicAtomImageData {
  return {
    positions: new Float32Array(positions),
    elements: new Uint8Array(sources.map(() => C)),
    sourceIndices: new Uint32Array(sources),
    latticeShifts: new Int32Array(sources.length * 3),
  };
}

describe("pickAtomOnRay", () => {
  it("hits the nearest atom the ray passes through", () => {
    const snap = snapshot([0, 0, 0, 0, 0, 5, 3, 0, 0], [C, C, C]);
    const hit = pickAtomOnRay(down(), snap, snap.positions, 1, 0)!;
    expect(hit.atomIndex).toBe(1);
    expect(hit.distance).toBeCloseTo(5 - rC, 5);
    expect(hit.position).toEqual([0, 0, 5]);
  });

  it("misses atoms beside or behind the ray", () => {
    const snap = snapshot([5, 0, 0, 0, 0, 20], [C, C]);
    expect(pickAtomOnRay(down(), snap, snap.positions, 1, 0)).toBeNull();
  });

  it("widens small atoms to the minimum radius, preferring real hits", () => {
    // Atom 0 sits just beside the ray; atom 1 is far behind it, on the ray.
    const snap = snapshot([rC + 0.2, 0, 5, 0, 0, -5], [C, C]);
    const margin = pickAtomOnRay(down(), snap, snap.positions, 1, rC + 0.5)!;
    // The real hit wins over the nearer margin hit.
    expect(margin.atomIndex).toBe(1);
    const only = snapshot([rC + 0.2, 0, 5], [C]);
    const widened = pickAtomOnRay(down(), only, only.positions, 1, rC + 0.5)!;
    expect(widened.atomIndex).toBe(0);
    expect(pickAtomOnRay(down(), only, only.positions, 1, 0)).toBeNull();
    // Among margin hits, the one closest to the ray wins.
    const two = snapshot([rC + 0.4, 0, 8, rC + 0.1, 0, 0], [C, C]);
    expect(pickAtomOnRay(down(), two, two.positions, 1, rC + 0.5)!.atomIndex).toBe(1);
  });

  it("scales the pick radius like the drawn atoms and skips hidden ones", () => {
    const snap = snapshot([rC * 1.5, 0, 0], [C]);
    expect(pickAtomOnRay(down(), snap, snap.positions, 1, 0)).toBeNull();
    expect(pickAtomOnRay(down(), snap, snap.positions, 2, 0)?.atomIndex).toBe(0);
    const visibility = { globalOpacity: 1, opacity: new Float32Array([0]), scale: null };
    const centred = snapshot([0, 0, 0], [C]);
    expect(
      pickAtomOnRay(
        down(),
        centred,
        centred.positions,
        1,
        0,
        null,
        null,
        BALL_STICK_ATOM_SCALE,
        visibility,
      ),
    ).toBeNull();
  });

  it("picks periodic images as their source atom", () => {
    const snap = snapshot([10, 10, 0], [C]);
    const periodic = images([0, 0, 0], [0]);
    const hit = pickAtomOnRay(down(), snap, snap.positions, 1, 0, null, periodic)!;
    expect(hit.atomIndex).toBe(0);
    expect(hit.position).toEqual([0, 0, 0]);
  });

  it("skips atoms a Drawing Boundary hides but hits its images", () => {
    const snap = snapshot([0, 0, 0, 0, 0, 4], [C, C]);
    const boundary: DrawingBoundaryData = {
      min: [0, 0, 0],
      max: [1, 1, 1],
      sourceVisibleMask: new Uint8Array([1, 0]),
      images: images([0, 0, 2], [1]),
    };
    const hit = pickAtomOnRay(down(), snap, snap.positions, 1, 0, boundary)!;
    expect(hit.atomIndex).toBe(1);
    expect(hit.position).toEqual([0, 0, 2]);
  });
});
