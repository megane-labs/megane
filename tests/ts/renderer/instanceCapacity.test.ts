import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import {
  MIN_INSTANCE_CAPACITY,
  markInstancesDirty,
  nextInstanceCapacity,
  resetInstanceLimit,
  resizeTypedArray,
} from "@/renderer/instanceCapacity";
import { BOND_DOUBLE } from "@/constants";
import type { Snapshot } from "@/types";

/** A chain of `nAtoms` carbons with `nAtoms - 1` bonds (optionally all double). */
function chain(nAtoms: number, order?: number): Snapshot {
  const positions = new Float32Array(nAtoms * 3);
  for (let i = 0; i < nAtoms; i++) positions[i * 3] = i * 1.5;
  const nBonds = Math.max(0, nAtoms - 1);
  const bonds = new Uint32Array(nBonds * 2);
  for (let i = 0; i < nBonds; i++) {
    bonds[i * 2] = i;
    bonds[i * 2 + 1] = i + 1;
  }
  return {
    nAtoms,
    nBonds,
    positions,
    elements: new Uint8Array(nAtoms).fill(6),
    bonds,
    bondOrders: order === undefined ? null : new Uint8Array(nBonds).fill(order),
  } as Snapshot;
}

type Internals = {
  capacity: number;
  geo: THREE.InstancedBufferGeometry & { _maxInstanceCount?: number };
};
const internals = (m: ImpostorAtomMesh | ImpostorBondMesh) => m as unknown as Internals;
const attr = (m: ImpostorAtomMesh | ImpostorBondMesh, name: string) =>
  internals(m).geo.getAttribute(name) as THREE.InstancedBufferAttribute;

describe("nextInstanceCapacity", () => {
  it("keeps the capacity while the data fits", () => {
    expect(nextInstanceCapacity(1024, 0)).toBeNull();
    expect(nextInstanceCapacity(1024, 1024)).toBeNull();
    expect(nextInstanceCapacity(10_000, 9_000)).toBeNull();
  });

  it("grows with headroom, never below the minimum", () => {
    expect(nextInstanceCapacity(1024, 1025)).toBe(Math.ceil(1025 * 1.25));
    expect(nextInstanceCapacity(1024, 100_000)).toBe(125_000);
    expect(nextInstanceCapacity(1, 3)).toBe(MIN_INSTANCE_CAPACITY);
    expect(nextInstanceCapacity(1, 3, 1)).toBe(4);
  });

  it("shrinks only when the buffers are far larger than needed", () => {
    expect(nextInstanceCapacity(125_000, 40_000)).toBeNull();
    expect(nextInstanceCapacity(125_000, 30_000)).toBe(37_500);
    expect(nextInstanceCapacity(125_000, 10)).toBe(MIN_INSTANCE_CAPACITY);
    // Never shrinks a buffer that is already at (or under) the minimum.
    expect(nextInstanceCapacity(MIN_INSTANCE_CAPACITY, 0)).toBeNull();
    expect(nextInstanceCapacity(8, 1)).toBeNull();
  });
});

describe("resizeTypedArray", () => {
  it("copies what fits and fills the rest", () => {
    const grown = resizeTypedArray(new Float32Array([1, 2]), 4, 7);
    expect(Array.from(grown)).toEqual([1, 2, 7, 7]);
    const shrunk = resizeTypedArray(new Uint8Array([1, 2, 3, 4]), 2);
    expect(shrunk).toBeInstanceOf(Uint8Array);
    expect(Array.from(shrunk)).toEqual([1, 2]);
  });
});

describe("markInstancesDirty", () => {
  it("limits the upload to the drawn instances", () => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(30), 3);
    const before = a.version;
    markInstancesDirty(a, 4);
    expect(a.version).toBe(before + 1);
    expect(a.updateRanges).toEqual([{ start: 0, count: 12 }]);
    // A later mark replaces the range rather than accumulating ranges.
    markInstancesDirty(a, 2);
    expect(a.updateRanges).toEqual([{ start: 0, count: 6 }]);
  });

  it("skips the upload when nothing is drawn", () => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(3), 1);
    const before = a.version;
    markInstancesDirty(a, 0);
    expect(a.version).toBe(before);
    expect(a.updateRanges).toEqual([]);
  });
});

describe("resetInstanceLimit", () => {
  it("drops the instance limit Three.js cached on the geometry", () => {
    const geo = new THREE.InstancedBufferGeometry() as THREE.InstancedBufferGeometry & {
      _maxInstanceCount?: number;
    };
    geo._maxInstanceCount = 5;
    let disposed = false;
    geo.addEventListener("dispose", () => (disposed = true));
    resetInstanceLimit(geo);
    expect(geo._maxInstanceCount).toBeUndefined();
    expect(disposed).toBe(true);
  });
});

describe("ImpostorAtomMesh capacity", () => {
  it("starts small instead of preallocating for a million atoms", () => {
    const mesh = new ImpostorAtomMesh();
    expect(internals(mesh).capacity).toBe(MIN_INSTANCE_CAPACITY);
    expect(attr(mesh, "instanceCenter").count).toBe(MIN_INSTANCE_CAPACITY);
  });

  it("grows to fit, then shrinks back for a small structure", () => {
    const mesh = new ImpostorAtomMesh();
    mesh.loadSnapshot(chain(5000));
    expect(internals(mesh).capacity).toBe(6250);
    expect(attr(mesh, "instanceCenter").count).toBe(6250);
    expect(internals(mesh).geo.instanceCount).toBe(5000);
    expect(mesh.getBaseRadii()).toHaveLength(5000);

    mesh.loadSnapshot(chain(3));
    // The scratch radius buffer is released along with the big instance buffers.
    const scratch = (mesh as unknown as { baseRadiusBuf: Float32Array }).baseRadiusBuf;
    expect(scratch.length).toBeLessThanOrEqual(MIN_INSTANCE_CAPACITY);
    expect(mesh.getBaseRadii()).toHaveLength(3);
    expect(internals(mesh).capacity).toBe(MIN_INSTANCE_CAPACITY);
    expect(internals(mesh).geo.instanceCount).toBe(3);
    const center = attr(mesh, "instanceCenter").array as Float32Array;
    expect(Array.from(center.subarray(0, 9))).toEqual([0, 0, 0, 1.5, 0, 0, 3, 0, 0]);
    expect(attr(mesh, "instanceScaleOverride").array[2]).toBe(1);
  });

  it("forgets the cached instance limit when the buffers are reallocated", () => {
    const mesh = new ImpostorAtomMesh();
    internals(mesh).geo._maxInstanceCount = MIN_INSTANCE_CAPACITY;
    mesh.loadSnapshot(chain(2000));
    expect(internals(mesh).geo._maxInstanceCount).toBeUndefined();
  });

  it("uploads only the loaded atoms on updates", () => {
    const mesh = new ImpostorAtomMesh();
    mesh.loadSnapshot(chain(10));
    const positions = chain(10).positions;
    mesh.updatePositions(positions);
    expect(attr(mesh, "instanceCenter").updateRanges).toEqual([{ start: 0, count: 30 }]);
    mesh.setOpacityOverrides(new Float32Array(10).fill(0.5));
    expect(attr(mesh, "instanceOpacityOverride").updateRanges).toEqual([{ start: 0, count: 10 }]);
    mesh.applyColorOverrides(new Float32Array(30).fill(NaN));
    expect(attr(mesh, "instanceColor").updateRanges).toEqual([{ start: 0, count: 30 }]);
    mesh.clearOverrides();
    expect(attr(mesh, "instanceScaleOverride").updateRanges).toEqual([{ start: 0, count: 10 }]);
  });
});

describe("ImpostorBondMesh capacity", () => {
  it("starts small instead of preallocating for three million bonds", () => {
    const mesh = new ImpostorBondMesh();
    expect(internals(mesh).capacity).toBe(MIN_INSTANCE_CAPACITY);
    expect(attr(mesh, "instanceAtomA").count).toBe(MIN_INSTANCE_CAPACITY);
  });

  it("grows past the cached instance limit so every bond is drawn", () => {
    const mesh = new ImpostorBondMesh();
    // Simulate a first render at the initial capacity.
    internals(mesh).geo._maxInstanceCount = MIN_INSTANCE_CAPACITY;
    // 1500 double bonds fan out to 3000 visual instances.
    mesh.loadSnapshot(chain(1501, BOND_DOUBLE));
    expect(internals(mesh).geo.instanceCount).toBe(3000);
    expect(internals(mesh).geo._maxInstanceCount).toBeUndefined();
    expect(attr(mesh, "instanceAtomA").count).toBe(3750);
    // Topology written past the old capacity survives: last instance is bond 1499.
    expect(attr(mesh, "instanceAtomA").array[2999]).toBe(1499);
    expect(attr(mesh, "instanceAtomB").array[2999]).toBe(1500);
  });

  it("shrinks back for a small structure", () => {
    const mesh = new ImpostorBondMesh();
    mesh.loadSnapshot(chain(5000));
    expect(internals(mesh).capacity).toBe(Math.ceil(4999 * 1.25));
    mesh.loadSnapshot(chain(4));
    expect(internals(mesh).capacity).toBe(MIN_INSTANCE_CAPACITY);
    expect(internals(mesh).geo.instanceCount).toBe(3);
    expect(Array.from((attr(mesh, "instanceAtomB").array as Float32Array).subarray(0, 3))).toEqual([
      1, 2, 3,
    ]);
  });

  it("uploads only the drawn instances on updates", () => {
    const mesh = new ImpostorBondMesh();
    mesh.loadSnapshot(chain(6));
    expect(attr(mesh, "instanceColorA").updateRanges).toEqual([{ start: 0, count: 15 }]);
    expect(attr(mesh, "instanceRadius").updateRanges).toEqual([{ start: 0, count: 5 }]);

    mesh.setBondOpacityOverrides(new Float32Array(5).fill(0.25));
    expect(attr(mesh, "instanceBondOpacity").updateRanges).toEqual([{ start: 0, count: 5 }]);
    expect(attr(mesh, "instanceBondOpacity").array[4]).toBeCloseTo(0.25);

    mesh.clearBondOpacityOverrides();
    expect(attr(mesh, "instanceBondOpacity").array[4]).toBe(1);
    expect(attr(mesh, "instanceBondOpacity").updateRanges).toEqual([{ start: 0, count: 5 }]);

    mesh.recomputeColorsFromAtomBuffer(new Float32Array(18).fill(0.5), chain(6));
    expect(attr(mesh, "instanceColorB").updateRanges).toEqual([{ start: 0, count: 15 }]);
  });
});
