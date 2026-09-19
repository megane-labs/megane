import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { screenToWorldOnPlane, screenDragToWorldDelta } from "@/renderer/Picking";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import type { Snapshot } from "@/types";

function mockContainer(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => "",
    }),
  } as unknown as HTMLElement;
}

/** Orthographic camera at z=10 looking at the origin, 10×10 world units in view. */
function ortho(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function persp(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

describe("screenToWorldOnPlane", () => {
  it("maps the container center to the anchor's x/y at its depth (ortho)", () => {
    const p = screenToWorldOnPlane(ortho(), mockContainer(100, 100), [0, 0, 2], 50, 50);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(2, 4);
  });

  it("scales pixels to world units through the ortho frustum", () => {
    // 100 px span 10 world units → 10 px per unit; +10 px right = +1 x, +10 px down = -1 y.
    const p = screenToWorldOnPlane(ortho(), mockContainer(100, 100), [0, 0, 0], 60, 60);
    expect(p[0]).toBeCloseTo(1, 5);
    expect(p[1]).toBeCloseTo(-1, 5);
  });

  it("keeps the anchor depth for a perspective camera", () => {
    const p = screenToWorldOnPlane(persp(), mockContainer(200, 200), [1, 1, 3], 100, 100);
    expect(p[2]).toBeCloseTo(3, 3);
    expect(p[0]).toBeCloseTo(0, 3);
  });
});

describe("screenDragToWorldDelta", () => {
  it("is the difference of the two unprojected points", () => {
    const d = screenDragToWorldDelta(ortho(), mockContainer(100, 100), [0, 0, 0], 10, 10, 40, 10);
    expect(d[0]).toBeCloseTo(3, 5);
    expect(d[1]).toBeCloseTo(0, 5);
    expect(d[2]).toBeCloseTo(0, 5);
  });
});

describe("MoleculeRenderer drag helpers", () => {
  function makeRenderer() {
    const renderer = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = renderer as any;
    internals.snapshot = {
      nAtoms: 2,
      nBonds: 0,
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      elements: new Uint8Array([6, 6]),
      bonds: new Uint32Array(0),
    } as Snapshot;
    return { renderer, internals };
  }

  it("returns null before mount or for an out-of-range atom", () => {
    const { renderer } = makeRenderer();
    expect(renderer.dragDeltaForAtom(0, 0, 0, 10, 10)).toBeNull();
    expect(renderer.screenToWorldAtPivot(0, 0)).toBeNull();
  });

  it("computes a drag delta in the plane of the atom and a pivot-plane point", () => {
    const { renderer, internals } = makeRenderer();
    internals.container = mockContainer(100, 100);
    internals.camera = ortho();
    internals.controls = { target: new THREE.Vector3(0, 0, 0) };
    expect(renderer.dragDeltaForAtom(9, 0, 0, 10, 10)).toBeNull();
    const d = renderer.dragDeltaForAtom(1, 10, 10, 20, 10)!;
    expect(d[0]).toBeCloseTo(1, 5);
    expect(d[1]).toBeCloseTo(0, 5);
    const p = renderer.screenToWorldAtPivot(50, 50)!;
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(0, 5);
  });
});
