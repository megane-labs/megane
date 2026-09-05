import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import {
  computeViewBounds,
  fitCameraToView,
  applyFrustumInsets,
  createSwitchedCamera,
  updatePerspectiveClipping,
  zoomOrthographicAroundTarget,
  wheelZoomFactor,
  dollyPerspectiveTowardTarget,
  orientCamera,
  currentOrientation,
} from "@/renderer/CameraManager";
import {
  axisOrientation,
  standardOrientation,
  type CameraOrientation,
} from "@/renderer/cameraOrientation";
import type { Snapshot } from "@/types";

/** The pre-#661 canonical view: camera on -y looking along +y, z up. */
const LOOK_ALONG_Y: CameraOrientation = { eye: [0, -1, 0], up: [0, 0, 1] };

function makeSnapshot(opts: {
  positions: number[];
  elements?: number[];
  box?: number[] | null;
  boxOrigin?: number[] | null;
}): Snapshot {
  const positions = new Float32Array(opts.positions);
  const nAtoms = positions.length / 3;
  const elements = new Uint8Array(opts.elements ?? new Array(nAtoms).fill(6));
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions,
    elements,
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: opts.box === null || opts.box === undefined ? null : new Float32Array(opts.box),
    boxOrigin:
      opts.boxOrigin === null || opts.boxOrigin === undefined
        ? null
        : new Float32Array(opts.boxOrigin),
  };
}

/** Mock camera controls — only the surface used by fitCameraToView. */
function makeMockControls() {
  return {
    target: new THREE.Vector3(),
    update: vi.fn(),
  };
}

describe("computeViewBounds", () => {
  it("returns atom-centroid center when no box is present", () => {
    const snap = makeSnapshot({ positions: [-1, -2, -3, 1, 2, 3] });
    const { center, extent } = computeViewBounds(snap, LOOK_ALONG_Y);
    expect(center).toEqual([0, 0, 0]);
    // Screen axes of LOOK_ALONG_Y are world x (right) and z (up).
    expect(extent.extentX).toBeCloseTo(2, 5);
    expect(extent.extentY).toBeCloseTo(6, 5);
    expect(extent.maxExtent).toBeCloseTo(6, 5);
  });

  it("measures extentX / extentY along the screen axes of the orientation", () => {
    const snap = makeSnapshot({ positions: [-1, -2, -3, 1, 2, 3] });
    // Looking down +z with y up: right is x, up is y.
    const top = computeViewBounds(snap, { eye: [0, 0, 1], up: [0, 1, 0] }).extent;
    expect(top.extentX).toBeCloseTo(2, 5);
    expect(top.extentY).toBeCloseTo(4, 5);
    // Looking along -x from +x with z up: right is y, up is z.
    const side = computeViewBounds(snap, { eye: [1, 0, 0], up: [0, 0, 1] }).extent;
    expect(side.extentX).toBeCloseTo(4, 5);
    expect(side.extentY).toBeCloseTo(6, 5);
    // maxExtent is the world AABB whichever way the camera looks.
    expect(top.maxExtent).toBeCloseTo(6, 5);
    expect(side.maxExtent).toBeCloseTo(6, 5);
  });

  it("defaults to the structure's standard orientation", () => {
    const snap = makeSnapshot({ positions: [-1, -2, -3, 1, 2, 3] });
    const implicit = computeViewBounds(snap);
    const explicit = computeViewBounds(snap, standardOrientation(snap.box));
    expect(implicit).toEqual(explicit);
    // The tilted view sees a projection somewhere between an axis extent
    // and the space diagonal.
    expect(implicit.extent.extentX).toBeGreaterThan(2);
    expect(implicit.extent.extentX).toBeLessThan(Math.sqrt(4 + 16 + 36));
  });

  it("uses simulation cell when box is non-zero", () => {
    // Cubic box of side 10, axes aligned, origin at world origin.
    const snap = makeSnapshot({
      positions: [0, 0, 0], // single atom near origin (ignored for centering)
      box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
    });
    const { center, extent } = computeViewBounds(snap, LOOK_ALONG_Y);
    expect(center).toEqual([5, 5, 5]);
    expect(extent.extentX).toBeCloseTo(10, 5);
    expect(extent.extentY).toBeCloseTo(10, 5);
    expect(extent.maxExtent).toBeCloseTo(10, 5);
  });

  it("treats all-zero box as 'no box' (falls back to atom bounds)", () => {
    const snap = makeSnapshot({
      positions: [-1, 0, 0, 1, 0, 0],
      box: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    const { center, extent } = computeViewBounds(snap, LOOK_ALONG_Y);
    expect(center).toEqual([0, 0, 0]);
    expect(extent.extentX).toBeCloseTo(2, 5);
  });

  it("returns center=(0,0,0) for a snapshot with zero atoms", () => {
    const snap = makeSnapshot({ positions: [], elements: [] });
    const { center, extent } = computeViewBounds(snap);
    expect(center).toEqual([0, 0, 0]);
    expect(Number.isFinite(extent.maxExtent)).toBe(false); // -Infinity from empty extents
  });

  it("offsets the box center and corners by boxOrigin", () => {
    // Cubic box of side 10 anchored at an offset origin (like a confined slab
    // whose atoms sit at z≈600). The camera must center on the box's true
    // location, not at world zero.
    const snap = makeSnapshot({
      positions: [105, 205, 605],
      box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
      boxOrigin: [100, 200, 600],
    });
    const { center, extent } = computeViewBounds(snap, LOOK_ALONG_Y);
    expect(center[0]).toBeCloseTo(105, 5);
    expect(center[1]).toBeCloseTo(205, 5);
    expect(center[2]).toBeCloseTo(605, 5);
    // Extent is unchanged by the offset (still the box side).
    expect(extent.maxExtent).toBeCloseTo(10, 5);
    expect(extent.extentX).toBeCloseTo(10, 5);
  });

  it("null boxOrigin reproduces the origin-anchored result", () => {
    const snap = makeSnapshot({
      positions: [0, 0, 0],
      box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
      boxOrigin: null,
    });
    const { center } = computeViewBounds(snap);
    expect(center).toEqual([5, 5, 5]);
  });

  it("handles a triclinic cell (non-orthogonal vectors)", () => {
    const snap = makeSnapshot({
      positions: [0, 0, 0],
      // a=(4,0,0), b=(2,4,0), c=(0,0,5) — sheared parallelepiped
      box: [4, 0, 0, 2, 4, 0, 0, 0, 5],
    });
    // Looking down +z with y up: right is x, up is y.
    const { center, extent } = computeViewBounds(snap, { eye: [0, 0, 1], up: [0, 1, 0] });
    // Center is (a+b+c)/2 = (3, 2, 2.5)
    expect(center[0]).toBeCloseTo(3, 5);
    expect(center[1]).toBeCloseTo(2, 5);
    expect(center[2]).toBeCloseTo(2.5, 5);
    // x extent spans 0..6 (from i=ic=0,ib=1 → x=2; ia=1,ib=1 → x=6)
    expect(extent.extentX).toBeCloseTo(6, 5);
    expect(extent.extentY).toBeCloseTo(4, 5);
  });
});

describe("fitCameraToView", () => {
  it("centers controls.target on the structure", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    const controls = makeMockControls();
    const snap = makeSnapshot({ positions: [-1, -2, -3, 1, 2, 3] });
    fitCameraToView(cam, controls as never, snap);
    expect(controls.target.x).toBeCloseTo(0, 5);
    expect(controls.target.y).toBeCloseTo(0, 5);
    expect(controls.target.z).toBeCloseTo(0, 5);
    expect(controls.update).toHaveBeenCalled();
  });

  it("places camera along the orientation's eye vector by 1.2× max extent", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    const controls = makeMockControls();
    const snap = makeSnapshot({ positions: [-1, -1, -1, 1, 1, 1] });
    fitCameraToView(cam, controls as never, snap, LOOK_ALONG_Y);
    // Max extent = 2, distance = 2 × 1.2 = 2.4
    expect(cam.position.x).toBeCloseTo(0, 5);
    expect(cam.position.y).toBeCloseTo(-2.4, 5);
    expect(cam.position.z).toBeCloseTo(0, 5);
    expect(cam.up.toArray()).toEqual([0, 0, 1]);
  });

  it("defaults to the standard orientation of the snapshot's cell", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    const controls = makeMockControls();
    const snap = makeSnapshot({
      positions: [1, 1, 1],
      box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
    });
    fitCameraToView(cam, controls as never, snap);
    const want = standardOrientation(snap.box);
    // distance = 10 × 1.2 = 12 from the cell centre (5, 5, 5)
    for (let i = 0; i < 3; i++) {
      expect(cam.position.toArray()[i]).toBeCloseTo(5 + want.eye[i] * 12, 5);
      expect(cam.up.toArray()[i]).toBeCloseTo(want.up[i], 9);
    }
    // VESTA look: the camera sits on the +a side, swung toward +b and above.
    expect(cam.position.x).toBeGreaterThan(5);
    expect(cam.position.y).toBeGreaterThan(5);
    expect(cam.position.z).toBeGreaterThan(5);
    expect(cam.position.x - 5).toBeGreaterThan(cam.position.y - 5);
  });

  it("enforces a minimum distance of 0.1 for tiny structures", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    const controls = makeMockControls();
    const snap = makeSnapshot({ positions: [0, 0, 0] }); // single atom → maxExtent=0
    fitCameraToView(cam, controls as never, snap);
    expect(cam.position.distanceTo(controls.target)).toBeCloseTo(0.1, 5);
    expect(cam.near).toBeCloseTo(-1, 5); // -distance * 10
    expect(cam.far).toBeCloseTo(1, 5);
  });

  it("resets ortho zoom and sets near/far from distance", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    cam.zoom = 5;
    const controls = makeMockControls();
    const snap = makeSnapshot({ positions: [-1, -1, -1, 1, 1, 1] });
    fitCameraToView(cam, controls as never, snap);
    expect(cam.zoom).toBe(1);
    expect(cam.near).toBeCloseTo(-24, 5); // -2.4 × 10
    expect(cam.far).toBeCloseTo(24, 5);
  });

  it("updates perspective camera near/far and projection matrix", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const before = cam.projectionMatrix.elements.slice();
    const controls = makeMockControls();
    const snap = makeSnapshot({ positions: [-5, -5, -5, 5, 5, 5] });
    fitCameraToView(cam, controls as never, snap);
    // distance = 10 × 1.2 = 12
    expect(cam.near).toBeCloseTo(0.12, 5);
    expect(cam.far).toBeCloseTo(120, 5);
    // projection matrix should have been recomputed
    expect(cam.projectionMatrix.elements).not.toEqual(before);
  });

  it("returns the computed extent so callers can drive frustum insets", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    const controls = makeMockControls();
    const snap = makeSnapshot({ positions: [-3, -2, -1, 3, 2, 1] });
    const extent = fitCameraToView(cam, controls as never, snap, LOOK_ALONG_Y);
    expect(extent.extentX).toBeCloseTo(6, 5);
    expect(extent.extentY).toBeCloseTo(2, 5);
    expect(extent.maxExtent).toBeCloseTo(6, 5);
  });
});

describe("orientCamera", () => {
  it("turns the camera around the target keeping its distance and zoom", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    cam.zoom = 3;
    cam.position.set(1, -9, 4);
    cam.up.set(0.2, 0.3, 0.9).normalize();
    const controls = makeMockControls();
    controls.target.set(1, 1, 1);
    const distance = cam.position.distanceTo(controls.target);

    orientCamera(cam, controls as never, axisOrientation("+z", null));

    expect(cam.position.x).toBeCloseTo(1, 9);
    expect(cam.position.y).toBeCloseTo(1, 9);
    expect(cam.position.z).toBeCloseTo(1 + distance, 9);
    expect(cam.up.toArray()).toEqual([0, 1, 0]);
    expect(cam.zoom).toBe(3);
    expect(controls.target.toArray()).toEqual([1, 1, 1]);
    expect(controls.update).toHaveBeenCalled();
  });

  it("backs a camera sitting on its target off by one unit", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(2, 2, 2);
    const controls = makeMockControls();
    controls.target.set(2, 2, 2);

    orientCamera(cam, controls as never, { eye: [-1, 0, 0], up: [0, 0, 1] });

    expect(cam.position.toArray()).toEqual([1, 2, 2]);
  });
});

describe("currentOrientation", () => {
  it("reads eye and up back from the camera pose", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    cam.position.set(0, -10, 0);
    cam.up.set(0, 0, 1);
    const controls = makeMockControls();
    const o = currentOrientation(cam, controls);
    expect(o).toEqual(LOOK_ALONG_Y);
  });

  it("is null while the camera sits on its target", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    const controls = makeMockControls();
    expect(currentOrientation(cam, controls)).toBeNull();
  });
});

describe("applyFrustumInsets", () => {
  it("no-ops if the container is degenerate (0 width or height)", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    const before = { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom };
    applyFrustumInsets(cam, 0, 100, 0, 0, { maxExtent: 10, extentX: 10, extentY: 10 });
    expect(cam.left).toBe(before.left);
    expect(cam.right).toBe(before.right);

    applyFrustumInsets(cam, 100, 0, 0, 0, { maxExtent: 10, extentX: 10, extentY: 10 });
    expect(cam.top).toBe(before.top);
    expect(cam.bottom).toBe(before.bottom);
  });

  it("centers the frustum (no shift) when left/right insets are equal", () => {
    const cam = new THREE.OrthographicCamera();
    applyFrustumInsets(cam, 200, 100, 20, 20, { maxExtent: 10, extentX: 10, extentY: 10 });
    expect(cam.left + cam.right).toBeCloseTo(0, 5);
    expect(cam.top).toBeCloseTo(-cam.bottom, 5);
  });

  it("shifts the frustum when insets are asymmetric", () => {
    const cam = new THREE.OrthographicCamera();
    applyFrustumInsets(cam, 200, 100, 40, 0, { maxExtent: 10, extentX: 10, extentY: 10 });
    // shift = ((40 - 0) / (2*200)) * frustumWidth = 0.1 * frustumWidth
    // → left and right both decrease by `shift`, so center moves to negative x.
    const center = (cam.left + cam.right) / 2;
    expect(center).toBeLessThan(0);
  });

  it("scales frustum height with extent (padding factor 1.2)", () => {
    const cam = new THREE.OrthographicCamera();
    applyFrustumInsets(cam, 200, 100, 0, 0, { maxExtent: 10, extentX: 10, extentY: 10 });
    // halfH = max(extentY/2, extentX/(2·aspect)) × 1.2; aspect = 200/100 = 2
    //       = max(5, 2.5) × 1.2 = 6 → frustumHeight = 12
    expect(cam.top - cam.bottom).toBeCloseTo(12, 4);
  });

  it("enforces a minimum frustum height of 0.1", () => {
    const cam = new THREE.OrthographicCamera();
    applyFrustumInsets(cam, 200, 100, 0, 0, { maxExtent: 0, extentX: 0, extentY: 0 });
    expect(cam.top - cam.bottom).toBeCloseTo(0.1, 5);
  });

  it("clamps effective width to at least 30% of container or 100px", () => {
    const cam = new THREE.OrthographicCamera();
    // Insets eat almost the entire width; effective width should clamp.
    applyFrustumInsets(cam, 200, 100, 90, 90, { maxExtent: 10, extentX: 10, extentY: 10 });
    // With extentY=10, halfH = max(5, 10/(2·effectiveAspect)) × 1.2.
    // Without clamp, effectiveAspect would collapse and halfH would explode.
    // Verify result is finite and reasonable.
    const h = cam.top - cam.bottom;
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeLessThan(50);
  });
});

describe("createSwitchedCamera", () => {
  it("creates a perspective camera when enabled=true", () => {
    const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    ortho.position.set(1, 2, 3);
    const next = createSwitchedCamera(ortho, true, 200, 100);
    expect(next).toBeInstanceOf(THREE.PerspectiveCamera);
    expect((next as THREE.PerspectiveCamera).aspect).toBeCloseTo(2, 5);
  });

  it("creates an orthographic camera when enabled=false", () => {
    const persp = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const next = createSwitchedCamera(persp, false, 100, 200);
    expect(next).toBeInstanceOf(THREE.OrthographicCamera);
    const o = next as THREE.OrthographicCamera;
    expect(o.right - o.left).toBeCloseTo(25, 4); // frustumSize=50, aspect=0.5
    expect(o.top - o.bottom).toBeCloseTo(50, 4);
  });

  it("preserves position and up vector across the switch", () => {
    const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    ortho.position.set(7, 8, 9);
    ortho.up.set(0, 0, 1);
    const persp = createSwitchedCamera(ortho, true, 100, 100);
    expect(persp.position.toArray()).toEqual([7, 8, 9]);
    expect(persp.up.toArray()).toEqual([0, 0, 1]);
  });

  it("does not mutate the input camera's position vector", () => {
    const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    ortho.position.set(1, 2, 3);
    const persp = createSwitchedCamera(ortho, true, 100, 100);
    persp.position.set(99, 99, 99);
    expect(ortho.position.toArray()).toEqual([1, 2, 3]);
  });
});

describe("updatePerspectiveClipping", () => {
  /** Place a perspective camera `distance` units in front of the target. */
  function makePerspectiveAt(distance: number) {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
    const controls = makeMockControls();
    controls.target.set(0, 0, 0);
    cam.position.set(0, -distance, 0);
    return { cam, controls };
  }

  it("grows far so a dollied-out model stays inside the frustum", () => {
    const { cam, controls } = makePerspectiveAt(500);
    const extent = { maxExtent: 10, extentX: 10, extentY: 10 };
    const radius = 10 * 0.72;

    const changed = updatePerspectiveClipping(cam, controls, extent);

    expect(changed).toBe(true);
    // Back of the model (distance + radius) must be in front of the far plane.
    expect(cam.far).toBeGreaterThanOrEqual(500 + radius);
  });

  it("keeps near positive and above the precision floor when zoomed in close", () => {
    // distance - radius - margin is strongly negative here.
    const { cam, controls } = makePerspectiveAt(0.05);
    const extent = { maxExtent: 100, extentX: 100, extentY: 100 };

    updatePerspectiveClipping(cam, controls, extent);

    expect(cam.near).toBeGreaterThan(0);
    expect(cam.near).toBeGreaterThanOrEqual(cam.far * 1e-4);
    expect(cam.near).toBeGreaterThanOrEqual(0.01);
  });

  it("brackets the model bounding sphere at a mid distance", () => {
    const distance = 50;
    const { cam, controls } = makePerspectiveAt(distance);
    const extent = { maxExtent: 20, extentX: 20, extentY: 20 };
    const radius = 20 * 0.72;

    updatePerspectiveClipping(cam, controls, extent);

    // The whole sphere of `radius` centered at the target lies within [near, far].
    expect(cam.near).toBeLessThanOrEqual(distance - radius);
    expect(cam.far).toBeGreaterThanOrEqual(distance + radius);
  });

  it("is a no-op for orthographic cameras", () => {
    const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
    ortho.position.set(0, -50, 0);
    const controls = makeMockControls();
    const before = ortho.projectionMatrix.clone();

    const changed = updatePerspectiveClipping(ortho, controls, {
      maxExtent: 10,
      extentX: 10,
      extentY: 10,
    });

    expect(changed).toBe(false);
    expect(ortho.near).toBe(0.1);
    expect(ortho.far).toBe(1000);
    expect(ortho.projectionMatrix.equals(before)).toBe(true);
  });

  it("returns false when near/far are already up to date", () => {
    const { cam, controls } = makePerspectiveAt(100);
    const extent = { maxExtent: 15, extentX: 15, extentY: 15 };

    expect(updatePerspectiveClipping(cam, controls, extent)).toBe(true);
    expect(updatePerspectiveClipping(cam, controls, extent)).toBe(false);
  });

  it("bounds the far/near ratio for depth-buffer precision when deep-zoomed", () => {
    const { cam, controls } = makePerspectiveAt(0.05);
    const extent = { maxExtent: 100, extentX: 100, extentY: 100 };

    updatePerspectiveClipping(cam, controls, extent);

    expect(cam.far / cam.near).toBeLessThanOrEqual(1e4 + 1e-6);
  });
});

describe("zoomOrthographicAroundTarget", () => {
  /**
   * Build an orthographic camera looking at `target` from the -Y axis (the
   * app's orientation: up = +Z). `cx`/`cy` offset the frustum center so the
   * target projects off-screen-center, mimicking the sidebar inset shift that
   * triggered the original drift bug.
   */
  function makeOrtho(target: THREE.Vector3, cx = 0, cy = 0) {
    const half = 25;
    const cam = new THREE.OrthographicCamera(
      -half + cx,
      half + cx,
      half + cy,
      -half + cy,
      -1000,
      1000,
    );
    cam.position.set(target.x, target.y - 50, target.z);
    cam.up.set(0, 0, 1);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return cam;
  }

  it("keeps the target's screen position fixed across a zoom (anchor invariant)", () => {
    const target = new THREE.Vector3(0, 0, 0);
    // Frustum center offset by 5 in x so the target is off screen-center.
    const cam = makeOrtho(target, 5);
    const before = target.clone().project(cam);

    zoomOrthographicAroundTarget(cam, target, 2.0);

    const after = target.clone().project(cam);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("is reversible: zoom in then out restores zoom and frustum bounds", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const cam = makeOrtho(target, 5, -3);
    const l0 = cam.left;
    const r0 = cam.right;
    const t0 = cam.top;
    const b0 = cam.bottom;

    for (let i = 0; i < 10; i++) zoomOrthographicAroundTarget(cam, target, 1.2);
    for (let i = 0; i < 10; i++) zoomOrthographicAroundTarget(cam, target, 1 / 1.2);

    expect(cam.zoom).toBeCloseTo(1, 5);
    expect(cam.left).toBeCloseTo(l0, 4);
    expect(cam.right).toBeCloseTo(r0, 4);
    expect(cam.top).toBeCloseTo(t0, 4);
    expect(cam.bottom).toBeCloseTo(b0, 4);
  });

  it("clamps zoom at the 0.01 minimum", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const cam = makeOrtho(target);
    zoomOrthographicAroundTarget(cam, target, 0.0001);
    expect(cam.zoom).toBe(0.01);
  });

  it("applies no frustum shift when the target is already screen-centered", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const cam = makeOrtho(target); // cx = cy = 0 → target at NDC origin
    const { shiftX, shiftY } = zoomOrthographicAroundTarget(cam, target, 3.0);
    expect(Math.abs(shiftX)).toBeLessThan(1e-9);
    expect(Math.abs(shiftY)).toBeLessThan(1e-9);
    // Frustum width unchanged; only zoom scales.
    expect(cam.left).toBeCloseTo(-25, 9);
    expect(cam.right).toBeCloseTo(25, 9);
    expect(cam.zoom).toBeCloseTo(3, 9);
  });
});

describe("fitCameraToView orientation reset", () => {
  it("restores the standard orientation after the trackball rolled the camera", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    // Simulate a trackball drag that left the camera rolled and over a pole.
    cam.up.set(0.3, -0.8, 0.5).normalize();
    cam.position.set(12, 40, -7);
    const controls = makeMockControls();
    const snap = makeSnapshot({ positions: [-1, 0, 0, 1, 0, 0] });

    fitCameraToView(cam, controls, snap);

    const want = standardOrientation(null);
    const distance = cam.position.distanceTo(controls.target);
    expect(distance).toBeCloseTo(2.4, 6);
    for (let i = 0; i < 3; i++) {
      expect(cam.up.toArray()[i]).toBeCloseTo(want.up[i], 9);
      expect(cam.position.toArray()[i]).toBeCloseTo(want.eye[i] * distance, 6);
    }
    expect(controls.update).toHaveBeenCalled();
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in (factor > 1) for negative deltaY and out for positive", () => {
    expect(wheelZoomFactor(-100, 0, 1.2)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0, 1.2)).toBeLessThan(1);
  });

  it("is exactly reversible: in then out returns to 1", () => {
    const zoomIn = wheelZoomFactor(-120, 0, 1.2);
    const zoomOut = wheelZoomFactor(120, 0, 1.2);
    expect(zoomIn * zoomOut).toBeCloseTo(1, 12);
  });

  it("matches the OrbitControls ramp 0.95^(zoomSpeed * |delta| / 100)", () => {
    expect(wheelZoomFactor(100, 0, 1.2)).toBeCloseTo(Math.pow(0.95, 1.2), 12);
    expect(wheelZoomFactor(-50, 0, 2)).toBeCloseTo(1 / Math.pow(0.95, 1), 12);
  });

  it("scales line and page delta modes onto the pixel ramp", () => {
    const px = wheelZoomFactor(40, 0, 1);
    const line = wheelZoomFactor(1, 1, 1);
    const page = wheelZoomFactor(1, 2, 1);
    expect(line).toBeCloseTo(px, 12);
    expect(page).toBeCloseTo(wheelZoomFactor(800, 0, 1), 12);
  });

  it("returns 1 for a zero delta", () => {
    expect(wheelZoomFactor(0, 0, 1.2)).toBe(1);
  });
});

describe("dollyPerspectiveTowardTarget", () => {
  it("divides the distance to the target by the zoom factor", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, -40, 0);
    const target = new THREE.Vector3(0, 0, 0);
    dollyPerspectiveTowardTarget(cam, target, 2);
    expect(cam.position.distanceTo(target)).toBeCloseTo(20, 9);
    // Direction is preserved.
    expect(cam.position.x).toBeCloseTo(0, 9);
    expect(cam.position.y).toBeCloseTo(-20, 9);
    expect(cam.position.z).toBeCloseTo(0, 9);
  });

  it("zooming out (factor < 1) moves the camera away along the same axis", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(3, 4, 0);
    const target = new THREE.Vector3(0, 0, 0);
    dollyPerspectiveTowardTarget(cam, target, 0.5);
    expect(cam.position.distanceTo(target)).toBeCloseTo(10, 9);
    expect(cam.position.x).toBeCloseTo(6, 9);
    expect(cam.position.y).toBeCloseTo(8, 9);
  });

  it("is reversible around an off-origin target", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(5, -30, 2);
    const target = new THREE.Vector3(5, 5, 2);
    const start = cam.position.clone();
    dollyPerspectiveTowardTarget(cam, target, 1.7);
    dollyPerspectiveTowardTarget(cam, target, 1 / 1.7);
    expect(cam.position.distanceTo(start)).toBeLessThan(1e-9);
  });

  it("never dollies through the pivot: distance is floored at minDistance", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, -1, 0);
    const target = new THREE.Vector3(0, 0, 0);
    dollyPerspectiveTowardTarget(cam, target, 1e6, 0.05);
    expect(cam.position.distanceTo(target)).toBeCloseTo(0.05, 9);
    expect(cam.position.y).toBeLessThan(0);
  });

  it("is a no-op when the camera sits exactly on the target", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const target = new THREE.Vector3(1, 2, 3);
    cam.position.copy(target);
    dollyPerspectiveTowardTarget(cam, target, 2);
    expect(cam.position.toArray()).toEqual([1, 2, 3]);
  });
});
