/**
 * Unit tests for MoleculeRenderer's heterogeneous-trajectory slow path in
 * updateFrame: when a Frame carries per-frame elements/bonds/box, the atom mesh
 * is re-topologised (instanceCount follows the frame's atom count), the bond
 * mesh is rebuilt, and the unit cell is redrawn. A frame that carries only
 * positions must stay on the allocation-free fast path.
 */

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { SurfaceRenderer } from "@/renderer/SurfaceRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import type { Snapshot, Frame } from "@/types";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = renderer as any;
  internals.snapshot = snapshot;
  internals.atomRenderer = atom;
  internals.bondRenderer = bond;
  // The scene is normally created during canvas init; stub it so lazy
  // renderers (e.g. the per-frame cell) can attach without a WebGL context.
  internals.scene = { add: () => {}, remove: () => {} };
  return { renderer, atom, bond, internals };
}

function instanceCount(atom: ImpostorAtomMesh): number {
  // InstancedBufferGeometry.instanceCount, set by loadSnapshot/updateTopology.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (atom.mesh.geometry as any).instanceCount as number;
}

describe("MoleculeRenderer — heterogeneous frame slow path", () => {
  it("re-topologises the atom mesh when a frame grows the atom count", () => {
    const { renderer, atom } = makeRenderer();
    expect(instanceCount(atom)).toBe(2);

    const frame: Frame = {
      frameId: 1,
      nAtoms: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      elements: new Uint8Array([6, 7, 8]),
      bonds: new Uint32Array([0, 1, 1, 2]),
      nBonds: 2,
    };
    renderer.updateFrame(frame);

    // Atom mesh now renders 3 instances.
    expect(instanceCount(atom)).toBe(3);
  });

  it("redraws the unit cell for a per-frame box", () => {
    const { renderer, internals } = makeRenderer();
    expect(internals.cellRenderer).toBeFalsy();

    const frame: Frame = {
      frameId: 1,
      nAtoms: 2,
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      box: new Float32Array([12, 0, 0, 0, 12, 0, 0, 0, 12]),
    };
    renderer.updateFrame(frame);

    // A cell renderer was lazily created and given the per-frame box.
    expect(internals.cellRenderer).toBeTruthy();
  });

  it("anchors the per-frame cell at the frame's box origin", () => {
    const { renderer, internals } = makeRenderer();

    const frame: Frame = {
      frameId: 1,
      nAtoms: 2,
      positions: new Float32Array([165, 10, 605, 200, 75, 750]),
      box: new Float32Array([80, 0, 0, 0, 150, 0, 0, 0, 300]),
      boxOrigin: new Float32Array([160, 0, 600]),
    };
    renderer.updateFrame(frame);

    const buf = internals.cellRenderer.mesh.geometry.getAttribute("position").array as Float32Array;
    // The wireframe's origin corner sits at the frame's box origin.
    expect([buf[0], buf[1], buf[2]]).toEqual([160, 0, 600]);
    expect([buf[69], buf[70], buf[71]]).toEqual([240, 150, 900]);
  });

  it("keeps a positions-only frame on the fast path (no re-topology)", () => {
    const { renderer, atom } = makeRenderer();
    const before = instanceCount(atom);

    const frame: Frame = {
      frameId: 1,
      nAtoms: 2,
      positions: new Float32Array([0.5, 0, 0, 1.5, 0, 0]),
    };
    renderer.updateFrame(frame);

    // instanceCount unchanged; positions updated in place.
    expect(instanceCount(atom)).toBe(before);
  });
});

/**
 * Picking, box selection and the selection overlays must follow the topology
 * of the frame on screen, not frame 0's: a heterogeneous frame has its own
 * atom count and elements, and the renderer's position buffer only grows, so
 * reading it with frame 0's atom count either misses the frame's extra atoms
 * or keeps the tail of an earlier, larger frame pickable.
 */
describe("MoleculeRenderer — picking on a heterogeneous frame", () => {
  // 100×100 viewport; the orthographic camera maps x ∈ [-10, 10] to [0, 100] px.
  const container = {
    clientWidth: 100,
    clientHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  /** Screen x (px) of a world x on the y = 0 line. */
  const sx = (x: number) => (x + 10) * 5;

  function makePickRenderer() {
    const renderer = new MoleculeRenderer();
    // Frame 0: four carbons along x.
    const snapshot = {
      nAtoms: 4,
      nBonds: 0,
      positions: new Float32Array([-6, 0, 0, -2, 0, 0, 2, 0, 0, 6, 0, 0]),
      elements: new Uint8Array([6, 6, 6, 6]),
      bonds: new Uint32Array(0),
      bondOrders: null,
    } as Snapshot;
    const atom = new ImpostorAtomMesh(64);
    atom.loadSnapshot(snapshot);
    const bond = new ImpostorBondMesh(64);
    bond.loadSnapshot(snapshot);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = renderer as any;
    internals.snapshot = snapshot;
    internals.currentPositions = snapshot.positions;
    internals.atomRenderer = atom;
    internals.bondRenderer = bond;
    internals.scene = { add: () => {}, remove: () => {} };
    internals.container = container;
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
    camera.position.set(0, 0, 50);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    internals.cameraController.camera = camera;
    return { renderer, internals, snapshot };
  }

  function heteroFrame(xs: number[], elements: number[]): Frame {
    return {
      frameId: 1,
      nAtoms: xs.length,
      positions: new Float32Array(xs.flatMap((x) => [x, 0, 0])),
      elements: new Uint8Array(elements),
      bonds: new Uint32Array(0),
      nBonds: 0,
    };
  }

  it("does not pick or box-select the leftover tail of a larger earlier frame", () => {
    const { renderer } = makePickRenderer();
    renderer.updateFrame(heteroFrame([-6, -2, 2, 6], [6, 6, 6, 6]));
    // The next frame has two atoms; the buffer still holds atoms 2 and 3.
    renderer.updateFrame(heteroFrame([-6, -2], [8, 8]));

    expect(renderer.raycastAtPixel(sx(6), 50)).toBeNull();
    expect(renderer.selectAtomsInRect({ x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([0, 1]);
    expect(renderer.testGetProjectedAtomPositions().map((a) => a.index)).toEqual([0, 1]);
  });

  it("picks the extra atoms of a frame larger than frame 0", () => {
    const { renderer } = makePickRenderer();
    renderer.updateFrame(heteroFrame([-6, -2, 2, 6, 8], [6, 6, 6, 6, 16]));

    const hit = renderer.raycastAtPixel(sx(8), 50);
    expect(hit).toMatchObject({ kind: "atom", atomIndex: 4, elementSymbol: "S" });
    expect(renderer.selectAtomsInRect({ x0: sx(7), y0: 0, x1: 100, y1: 100 })).toEqual([4]);
  });

  it("reports the frame's element in the tooltip and projection", () => {
    const { renderer } = makePickRenderer();
    renderer.updateFrame(heteroFrame([-6, -2, 2, 6], [8, 7, 6, 6]));

    expect(renderer.raycastAtPixel(sx(-6), 50)).toMatchObject({
      kind: "atom",
      atomIndex: 0,
      elementSymbol: "O",
      atomicNumber: 8,
    });
    expect(renderer.testGetProjectedAtomPositions().map((a) => a.element)).toEqual([8, 7, 6, 6]);
  });

  it("drops the highlight of a selected atom the frame does not have", () => {
    const { renderer, internals } = makePickRenderer();
    renderer.setSelection([1, 3]);
    expect(internals.selection.selectionGroup.children.length).toBe(3); // 2 spheres + line

    renderer.updateFrame(heteroFrame([-6, -2], [6, 6]));
    const spheres = internals.selection.selectionGroup.children.filter(
      (c: THREE.Object3D) => c instanceof THREE.Mesh,
    );
    expect(spheres.length).toBe(1);
    expect(spheres[0].position.toArray()).toEqual([-2, 0, 0]);
  });

  it("returns to frame 0's topology on a positions-only frame and on a new snapshot", () => {
    const { renderer, internals, snapshot } = makePickRenderer();
    renderer.updateFrame(heteroFrame([-6, -2], [8, 8]));
    expect(renderer.testGetProjectedAtomPositions()).toHaveLength(2);

    renderer.updateFrame({
      frameId: 2,
      nAtoms: 4,
      positions: new Float32Array([-6, 0, 0, -2, 0, 0, 2, 0, 0, 6, 0, 0]),
    });
    expect(renderer.testGetProjectedAtomPositions().map((a) => a.element)).toEqual([6, 6, 6, 6]);

    renderer.updateFrame(heteroFrame([-6, -2], [8, 8]));
    internals.cameraController.syncExtent = () => {};
    renderer.loadSnapshot(snapshot, { fit: false });
    expect(renderer.testGetProjectedAtomPositions()).toHaveLength(4);
  });
});

/**
 * The surface must be built from the topology of the frame on screen: a
 * heterogeneous frame carries its own atom count and elements, and pairing its
 * positions with frame 0's atom count either drops the frame's extra atoms,
 * reads past the end of a smaller frame's positions, or keeps the leftover
 * tail of an earlier, larger frame in the surface.
 */
describe("MoleculeRenderer — surface on a heterogeneous frame", () => {
  function heteroFrame(xs: number[], elements: number[]): Frame {
    return {
      frameId: 1,
      nAtoms: xs.length,
      positions: new Float32Array(xs.flatMap((x) => [x, 0, 0])),
      elements: new Uint8Array(elements),
      bonds: new Uint32Array(0),
      nBonds: 0,
    };
  }

  function makeSurfaceRenderer() {
    const { renderer, internals } = makeRenderer();
    internals.currentPositions = internals.snapshot.positions;
    const surface = new SurfaceRenderer();
    internals.surfaceRenderer = surface;
    const load = vi.spyOn(surface, "loadSnapshot");
    return { renderer, surface, load };
  }

  function surfaceBounds(surface: SurfaceRenderer): THREE.Box3 {
    const geometry = (surface.mesh.children[0] as THREE.Mesh).geometry;
    geometry.computeBoundingBox();
    return geometry.boundingBox!;
  }

  it("covers a grown frame's extra atoms with that frame's elements", () => {
    const { renderer, surface, load } = makeSurfaceRenderer();
    renderer.setRepresentationType("atoms");
    renderer.updateFrame(heteroFrame([0, 1, 20], [6, 7, 16]));
    renderer.setRepresentationType("surface");

    const built = load.mock.lastCall![0];
    expect(built.nAtoms).toBe(3);
    expect(Array.from(built.elements)).toEqual([6, 7, 16]);
    expect(Array.from(built.positions.subarray(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 20, 0, 0]);
    // The sulfur at x = 20 is inside the surface.
    expect(surfaceBounds(surface).max.x).toBeGreaterThan(20);
  });

  it("builds a shrunk frame's surface from that frame's atoms only", () => {
    const { renderer, surface, load } = makeSurfaceRenderer();
    renderer.setRepresentationType("atoms");
    renderer.updateFrame(heteroFrame([0, 1, 20], [6, 7, 16]));
    // The next frame has one atom; the position buffer still holds the tail.
    renderer.updateFrame(heteroFrame([0], [8]));
    renderer.setRepresentationType("surface");

    const built = load.mock.lastCall![0];
    expect(built.nAtoms).toBe(1);
    expect(Array.from(built.elements)).toEqual([8]);
    const box = surfaceBounds(surface);
    expect(Number.isFinite(box.max.x)).toBe(true);
    // Neither the leftover nitrogen at x = 1 nor the sulfur at x = 20.
    expect(box.max.x).toBeLessThan(5);
  });

  it("rebuilds a shown surface with each heterogeneous frame's topology", () => {
    const { renderer, surface, load } = makeSurfaceRenderer();
    renderer.setRepresentationType("surface");
    renderer.updateFrame(heteroFrame([0, 1, 20], [6, 7, 16]));

    const built = load.mock.lastCall![0];
    expect(built.nAtoms).toBe(3);
    expect(Array.from(built.elements)).toEqual([6, 7, 16]);
    expect(surfaceBounds(surface).max.x).toBeGreaterThan(20);

    renderer.updateFrame(heteroFrame([0], [8]));
    expect(load.mock.lastCall![0].nAtoms).toBe(1);
    expect(surfaceBounds(surface).max.x).toBeLessThan(5);
  });

  it("returns to the snapshot's topology on a positions-only frame", () => {
    const { renderer, surface, load } = makeSurfaceRenderer();
    renderer.setRepresentationType("surface");
    renderer.updateFrame(heteroFrame([0, 1, 20], [6, 7, 16]));
    renderer.updateFrame({
      frameId: 2,
      nAtoms: 2,
      positions: new Float32Array([30, 0, 0, 31, 0, 0]),
    });

    const built = load.mock.lastCall![0];
    expect(built.nAtoms).toBe(2);
    expect(Array.from(built.elements)).toEqual([6, 8]);
    expect(Array.from(built.positions)).toEqual([30, 0, 0, 31, 0, 0]);
    expect(surfaceBounds(surface).min.x).toBeGreaterThan(25);
  });
});
