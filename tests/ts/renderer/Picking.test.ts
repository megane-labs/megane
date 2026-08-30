import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { projectToScreen, screenRadius, pickAtPixel } from "@/renderer/Picking";
import type { Snapshot } from "@/types";
import { SPACEFILL_ATOM_SCALE } from "@/constants";

/** Create a mock container that reports a fixed bounding rect. */
function mockContainer(left: number, top: number, width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => "",
    }),
  } as unknown as HTMLElement;
}

/** OrthographicCamera looking down -z toward origin from (0, 0, 10). */
function makeOrthoCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** PerspectiveCamera at (0, 0, 10) looking at origin. */
function makePerspCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function makeSnapshot(opts: {
  positions: number[];
  elements: number[];
  bonds?: number[];
  bondOrders?: number[] | null;
}): Snapshot {
  const positions = new Float32Array(opts.positions);
  const elements = new Uint8Array(opts.elements);
  const bonds = new Uint32Array(opts.bonds ?? []);
  const bondOrders =
    opts.bondOrders === null ? null : opts.bondOrders ? new Uint8Array(opts.bondOrders) : null;
  return {
    nAtoms: opts.elements.length,
    nBonds: (opts.bonds?.length ?? 0) / 2,
    nFileBonds: 0,
    positions,
    elements,
    bonds,
    bondOrders,
    box: null,
  };
}

describe("projectToScreen", () => {
  let camera: THREE.OrthographicCamera;
  beforeEach(() => {
    camera = makeOrthoCamera();
  });

  it("projects origin to screen center", () => {
    const { sx, sy, depth } = projectToScreen(camera, 0, 0, 0, 100, 100);
    expect(sx).toBeCloseTo(50, 5);
    expect(sy).toBeCloseTo(50, 5);
    expect(depth).toBeCloseTo(10, 5);
  });

  it("flips y so positive world-y maps to smaller screen-y (top)", () => {
    const top = projectToScreen(camera, 0, 1, 0, 100, 100);
    const bot = projectToScreen(camera, 0, -1, 0, 100, 100);
    expect(top.sy).toBeLessThan(50);
    expect(bot.sy).toBeGreaterThan(50);
  });

  it("reports positive depth for points in front of camera", () => {
    const inFront = projectToScreen(camera, 0, 0, 0, 100, 100);
    const behind = projectToScreen(camera, 0, 0, 20, 100, 100);
    expect(inFront.depth).toBeGreaterThan(0);
    expect(behind.depth).toBeLessThan(0);
  });
});

describe("screenRadius", () => {
  it("orthographic: scales with viewport height / frustum height", () => {
    const cam = makeOrthoCamera(); // top - bottom = 10
    const r = screenRadius(cam, 1.0, 10, 100); // viewport h = 100 → 10 px / unit
    expect(r).toBeCloseTo(10, 5);
  });

  it("orthographic: independent of depth", () => {
    const cam = makeOrthoCamera();
    expect(screenRadius(cam, 1.0, 5, 100)).toBeCloseTo(screenRadius(cam, 1.0, 50, 100), 5);
  });

  it("orthographic: scales with zoom", () => {
    const cam = makeOrthoCamera();
    const baseline = screenRadius(cam, 1.0, 10, 100);
    cam.zoom = 2;
    cam.updateProjectionMatrix();
    expect(screenRadius(cam, 1.0, 10, 100)).toBeCloseTo(baseline * 2, 5);
  });

  it("perspective: scales inversely with depth", () => {
    const cam = makePerspCamera();
    const near = screenRadius(cam, 1.0, 5, 100);
    const far = screenRadius(cam, 1.0, 10, 100);
    expect(near).toBeGreaterThan(far);
    expect(near / far).toBeCloseTo(2, 4);
  });
});

describe("pickAtPixel", () => {
  it("picks atom whose screen footprint contains the cursor", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    // Carbon at origin → projects to (50, 50). vdW = 1.7 Å × 0.3 scale = 0.51 Å
    // → screen radius ≈ 5.1 px in this 100×100 ortho frustum.
    const snap = makeSnapshot({ positions: [0, 0, 0], elements: [6] });
    const hit = pickAtPixel(cam, container, snap, snap.positions, 1, 50, 50);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("atom");
    if (hit && hit.kind === "atom") {
      expect(hit.atomIndex).toBe(0);
      expect(hit.atomicNumber).toBe(6);
      expect(hit.elementSymbol).toBe("C");
      expect(hit.position).toEqual([0, 0, 0]);
      expect(hit.screenX).toBe(50);
      expect(hit.screenY).toBe(50);
    }
  });

  it("returns null when mouse is far outside any atom", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    const snap = makeSnapshot({ positions: [0, 0, 0], elements: [6] });
    const hit = pickAtPixel(cam, container, snap, snap.positions, 1, 95, 95);
    expect(hit).toBeNull();
  });

  it("subtracts container offset before testing", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(200, 100, 100, 100);
    const snap = makeSnapshot({ positions: [0, 0, 0], elements: [6] });
    // Mouse client coords (250, 150) → relative (50, 50) → atom hit
    const hit = pickAtPixel(cam, container, snap, snap.positions, 1, 250, 150);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("atom");
  });

  it("respects atomScale multiplier when sizing the hit zone", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    const snap = makeSnapshot({ positions: [0, 0, 0], elements: [6] });
    // (54, 50) is ~4 px from atom center; default scale (5.1 px radius) → hit;
    // tiny scale (0.1 → 0.51 px radius) → miss.
    const hitDefault = pickAtPixel(cam, container, snap, snap.positions, 1, 54, 50);
    const hitTiny = pickAtPixel(cam, container, snap, snap.positions, 0.1, 54, 50);
    expect(hitDefault).not.toBeNull();
    expect(hitTiny).toBeNull();
  });

  it("widens the hit zone to the spacefill radius under the illustrative mode", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    const snap = makeSnapshot({ positions: [0, 0, 0], elements: [6] });
    // (60, 50) is 10 px from the center: outside the 5.1 px ball-and-stick
    // footprint, inside the 17 px full-vdW one the illustrative mode draws.
    const ballAndStick = pickAtPixel(cam, container, snap, snap.positions, 1, 60, 50);
    const spacefill = pickAtPixel(
      cam,
      container,
      snap,
      snap.positions,
      1,
      60,
      50,
      null,
      null,
      SPACEFILL_ATOM_SCALE,
    );
    expect(ballAndStick).toBeNull();
    expect(spacefill).not.toBeNull();
    expect(spacefill!.kind).toBe("atom");
  });

  it("picks a periodic image at the representation's radius, reporting its source atom", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    // One real carbon far off screen-center plus a periodic image of it at the
    // origin, so only the image can be under the cursor.
    const snap = makeSnapshot({ positions: [4, 4, 0], elements: [6] });
    const images = {
      positions: new Float32Array([0, 0, 0]),
      elements: new Uint8Array([6]),
      sourceIndices: new Uint32Array([0]),
      latticeShifts: new Int32Array([1, 0, 0]),
    };
    // 10 px out: outside the ball-and-stick footprint, inside the spacefill one.
    const ballAndStick = pickAtPixel(cam, container, snap, snap.positions, 1, 60, 50, null, images);
    const spacefill = pickAtPixel(
      cam,
      container,
      snap,
      snap.positions,
      1,
      60,
      50,
      null,
      images,
      SPACEFILL_ATOM_SCALE,
    );
    expect(ballAndStick).toBeNull();
    expect(spacefill).not.toBeNull();
    if (spacefill && spacefill.kind === "atom") {
      // Images report the structural atom they came from, not their own index.
      expect(spacefill.atomIndex).toBe(0);
      expect(spacefill.position).toEqual([0, 0, 0]);
    }
  });

  it("picks the closer atom when two atom footprints overlap on screen", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    // Both at screen (50, 50); atom 0 at z=5 (depth 5), atom 1 at z=-5 (depth 15).
    // Closer atom (depth 5) is index 0.
    const snap = makeSnapshot({
      positions: [0, 0, 5, 0, 0, -5],
      elements: [6, 6],
    });
    const hit = pickAtPixel(cam, container, snap, snap.positions, 1, 50, 50);
    expect(hit).not.toBeNull();
    if (hit && hit.kind === "atom") {
      expect(hit.atomIndex).toBe(0);
    }
  });

  it("falls through to bond pick when mouse is on bond midpoint, not on an atom", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    // Two carbons separated along x by 4 Å → midpoint (0, 0, 0) → screen (50, 50).
    // Atom radii ≈ 5.1 px each, atom centers at sx=30 and sx=70 (4 Å × 10 px/Å offset).
    // Mouse at (50,50) is 20 px from each atom (miss atoms) but on bond midpoint.
    const snap = makeSnapshot({
      positions: [-2, 0, 0, 2, 0, 0],
      elements: [6, 6],
      bonds: [0, 1],
      bondOrders: [2],
    });
    const hit = pickAtPixel(cam, container, snap, snap.positions, 1, 50, 50);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("bond");
    if (hit && hit.kind === "bond") {
      expect(hit.atomA).toBe(0);
      expect(hit.atomB).toBe(1);
      expect(hit.bondOrder).toBe(2);
      expect(hit.bondLength).toBeCloseTo(4, 5);
    }
  });

  it("defaults bondOrder to 1 when bondOrders is null", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    const snap = makeSnapshot({
      positions: [-2, 0, 0, 2, 0, 0],
      elements: [6, 6],
      bonds: [0, 1],
      bondOrders: null,
    });
    const hit = pickAtPixel(cam, container, snap, snap.positions, 1, 50, 50);
    expect(hit).not.toBeNull();
    if (hit && hit.kind === "bond") {
      expect(hit.bondOrder).toBe(1);
    }
  });

  it("uses currentPositions instead of snapshot.positions for the hit test", () => {
    const cam = makeOrthoCamera();
    const container = mockContainer(0, 0, 100, 100);
    const snap = makeSnapshot({ positions: [0, 0, 0], elements: [6] });
    // Override: move atom off-screen in the live frame.
    const live = new Float32Array([10, 10, 0]); // outside frustum
    const hit = pickAtPixel(cam, container, snap, live, 1, 50, 50);
    expect(hit).toBeNull();
  });
});
