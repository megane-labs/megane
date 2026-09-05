import { describe, it, expect } from "vitest";
import {
  CARTESIAN_LATTICE,
  CARTESIAN_VIEW_AXES,
  LATTICE_VIEW_AXES,
  STANDARD_AZIMUTH,
  STANDARD_ELEVATION,
  VIEW_AXES,
  axisOrientation,
  isViewAxis,
  latticeVectors,
  orientationFromPose,
  screenRight,
  standardOrientation,
  type CameraOrientation,
  type Vec3,
} from "@/renderer/cameraOrientation";

const dot = (u: ArrayLike<number>, v: ArrayLike<number>) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const norm = (v: ArrayLike<number>) => Math.sqrt(dot(v, v));

/** a, b, c of the fixture cells used below. */
const CUBIC = [10, 0, 0, 0, 10, 0, 0, 0, 10];
// Hexagonal: γ = 120°, c along z.
const HEXAGONAL = [3, 0, 0, -1.5, (3 * Math.sqrt(3)) / 2, 0, 0, 0, 5];
// Triclinic with c tilted off z and b tilted off y.
const TRICLINIC = [4, 0, 0, 1, 4, 0, 0.5, 1, 5];

function expectOrthonormal(o: CameraOrientation) {
  expect(norm(o.eye)).toBeCloseTo(1, 9);
  expect(norm(o.up)).toBeCloseTo(1, 9);
  expect(dot(o.eye, o.up)).toBeCloseTo(0, 9);
}

/** Component-wise closeness (cross products produce -0, which toEqual rejects). */
function expectVec(got: ArrayLike<number>, want: ArrayLike<number>, label = "") {
  for (let i = 0; i < 3; i++) expect(got[i], `${label}[${i}]`).toBeCloseTo(want[i], 9);
}

describe("latticeVectors", () => {
  it("splits a row-major 3×3 box into a, b, c", () => {
    const l = latticeVectors(new Float32Array(TRICLINIC));
    expect(l).not.toBeNull();
    expect(l!.a).toEqual([4, 0, 0]);
    expect(l!.b).toEqual([1, 4, 0]);
    expect(l!.c).toEqual([0.5, 1, 5]);
  });

  it("returns null for a missing, short, all-zero, or non-finite box", () => {
    expect(latticeVectors(null)).toBeNull();
    expect(latticeVectors(undefined)).toBeNull();
    expect(latticeVectors([1, 0, 0, 0, 1, 0])).toBeNull();
    expect(latticeVectors(new Float32Array(9))).toBeNull();
    expect(latticeVectors([NaN, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull();
  });

  it("returns null when a lattice vector is zero", () => {
    expect(latticeVectors([1, 0, 0, 0, 1, 0, 0, 0, 0])).toBeNull();
    expect(latticeVectors([1, 0, 0, 0, 0, 0, 0, 0, 1])).toBeNull();
    expect(latticeVectors([0, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull();
  });

  it("returns null for a coplanar (zero-volume) triple", () => {
    expect(latticeVectors([1, 0, 0, 0, 1, 0, 1, 1, 0])).toBeNull();
    expect(latticeVectors([2, 0, 0, 4, 0, 0, 0, 0, 3])).toBeNull();
  });
});

describe("standardOrientation", () => {
  it("uses the documented VESTA angles", () => {
    expect(STANDARD_AZIMUTH).toBeCloseTo((18.435 * Math.PI) / 180, 4);
    expect(STANDARD_ELEVATION).toBeCloseTo((9.462 * Math.PI) / 180, 4);
  });

  it("is an orthonormal eye/up pair for every kind of cell", () => {
    for (const box of [null, CUBIC, HEXAGONAL, TRICLINIC]) {
      expectOrthonormal(standardOrientation(box));
    }
  });

  it("swings the eye by arctan(1/3) around c and raises it by arctan(1/6) for a cubic cell", () => {
    const o = standardOrientation(CUBIC);
    const cosA = Math.cos(STANDARD_AZIMUTH);
    const sinA = Math.sin(STANDARD_AZIMUTH);
    const cosE = Math.cos(STANDARD_ELEVATION);
    const sinE = Math.sin(STANDARD_ELEVATION);
    // Base frame: +c (z) up, +b (y) right, viewer on the +a (x) side.
    expect(o.eye[0]).toBeCloseTo(cosE * cosA, 9);
    expect(o.eye[1]).toBeCloseTo(cosE * sinA, 9);
    expect(o.eye[2]).toBeCloseTo(sinE, 9);
    expect(o.up[0]).toBeCloseTo(-sinE * cosA, 9);
    expect(o.up[1]).toBeCloseTo(-sinE * sinA, 9);
    expect(o.up[2]).toBeCloseTo(cosE, 9);
    // Elevation is measured from the ab plane; azimuth in that plane.
    expect(Math.asin(o.eye[2])).toBeCloseTo(STANDARD_ELEVATION, 9);
    expect(Math.atan2(o.eye[1], o.eye[0])).toBeCloseTo(STANDARD_AZIMUTH, 9);
  });

  it("falls back to the Cartesian frame without a cell", () => {
    expect(standardOrientation(null)).toEqual(standardOrientation(CUBIC));
    expect(standardOrientation(new Float32Array(9))).toEqual(standardOrientation(CUBIC));
    expect(CARTESIAN_LATTICE).toEqual({ a: [1, 0, 0], b: [0, 1, 0], c: [0, 0, 1] });
  });

  it("is independent of the cell size", () => {
    const small = standardOrientation(CUBIC);
    const big = standardOrientation(CUBIC.map((v) => v * 7));
    for (let i = 0; i < 3; i++) {
      expect(big.eye[i]).toBeCloseTo(small.eye[i], 9);
      expect(big.up[i]).toBeCloseTo(small.up[i], 9);
    }
  });

  it("keeps +c pointing up the screen and +b to the right for a hexagonal cell", () => {
    const o = standardOrientation(HEXAGONAL);
    const l = latticeVectors(HEXAGONAL)!;
    const right = screenRight(o);
    // Screen-up is world c tilted back by the elevation: c has no
    // screen-right component and a positive screen-up one.
    expect(dot(l.c, right)).toBeCloseTo(0, 9);
    expect(dot(l.c, o.up)).toBeGreaterThan(0);
    // b lies to the right (and, seen from above, slightly downward).
    expect(dot(l.b, right)).toBeGreaterThan(0);
    // The +a end of the cell comes toward the viewer, to the lower left —
    // VESTA's characteristic look.
    expect(dot(l.a, o.eye)).toBeGreaterThan(0);
    expect(dot(l.a, right)).toBeLessThan(0);
    expect(dot(l.a, o.up)).toBeLessThan(0);
  });

  it("derives the frame from the actual lattice vectors of a triclinic cell", () => {
    const o = standardOrientation(TRICLINIC);
    const l = latticeVectors(TRICLINIC)!;
    const right = screenRight(o);
    const cHat = l.c.map((v) => v / norm(l.c)) as Vec3;
    // c projects straight up: no screen-right component, and the angle
    // between c and screen-up is exactly the elevation.
    expect(dot(cHat, right)).toBeCloseTo(0, 9);
    expect(Math.acos(dot(cHat, o.up))).toBeCloseTo(STANDARD_ELEVATION, 9);
    // b is to the right of c; a comes toward the viewer.
    expect(dot(l.b, right)).toBeGreaterThan(0);
    expect(dot(l.a, o.eye)).toBeGreaterThan(0);
    // With zero angles the eye is exactly the base-frame "toward" vector,
    // i.e. perpendicular to both b and c.
    const flat = standardOrientation(TRICLINIC, 0, 0);
    expect(dot(flat.eye, l.b)).toBeCloseTo(0, 9);
    expect(dot(flat.eye, l.c)).toBeCloseTo(0, 9);
    expect(dot(flat.up, cHat)).toBeCloseTo(1, 9);
  });
});

describe("axisOrientation", () => {
  it("lists the twelve axes, crystal first", () => {
    expect(LATTICE_VIEW_AXES).toEqual(["+a", "-a", "+b", "-b", "+c", "-c"]);
    expect(CARTESIAN_VIEW_AXES).toEqual(["+x", "-x", "+y", "-y", "+z", "-z"]);
    expect(VIEW_AXES).toEqual([...LATTICE_VIEW_AXES, ...CARTESIAN_VIEW_AXES]);
    for (const axis of VIEW_AXES) expect(isViewAxis(axis)).toBe(true);
    expect(isViewAxis("a")).toBe(false);
    expect(isViewAxis("+w")).toBe(false);
    expect(isViewAxis(42)).toBe(false);
  });

  it("puts the camera on the named side of the axis with the documented up vector", () => {
    const cases: Record<string, { eye: Vec3; up: Vec3 }> = {
      "+x": { eye: [1, 0, 0], up: [0, 0, 1] },
      "-x": { eye: [-1, 0, 0], up: [0, 0, 1] },
      "+y": { eye: [0, 1, 0], up: [0, 0, 1] },
      "-y": { eye: [0, -1, 0], up: [0, 0, 1] },
      "+z": { eye: [0, 0, 1], up: [0, 1, 0] },
      "-z": { eye: [0, 0, -1], up: [0, 1, 0] },
    };
    for (const [axis, want] of Object.entries(cases)) {
      const o = axisOrientation(axis as never, null);
      for (let i = 0; i < 3; i++) {
        expect(o.eye[i], `${axis} eye[${i}]`).toBeCloseTo(want.eye[i], 12);
        expect(o.up[i], `${axis} up[${i}]`).toBeCloseTo(want.up[i], 12);
      }
    }
  });

  it("makes the crystal axes coincide with x/y/z when there is no cell", () => {
    for (let i = 0; i < LATTICE_VIEW_AXES.length; i++) {
      expect(axisOrientation(LATTICE_VIEW_AXES[i], null)).toEqual(
        axisOrientation(CARTESIAN_VIEW_AXES[i], null),
      );
    }
  });

  it("ignores the cell for the Cartesian axes", () => {
    expect(axisOrientation("+x", TRICLINIC)).toEqual(axisOrientation("+x", null));
    expect(axisOrientation("-z", HEXAGONAL)).toEqual(axisOrientation("-z", null));
  });

  it("looks along the real lattice vectors of a triclinic cell", () => {
    const l = latticeVectors(TRICLINIC)!;
    for (const [axis, v, sign] of [
      ["+a", l.a, 1],
      ["-a", l.a, -1],
      ["+b", l.b, 1],
      ["-b", l.b, -1],
      ["+c", l.c, 1],
      ["-c", l.c, -1],
    ] as const) {
      const o = axisOrientation(axis, TRICLINIC);
      expectOrthonormal(o);
      for (let i = 0; i < 3; i++) {
        expect(o.eye[i], `${axis} eye[${i}]`).toBeCloseTo((sign * v[i]) / norm(v), 9);
      }
    }
  });

  it("keeps c upright for the a/b views and b upright for the c views", () => {
    const l = latticeVectors(TRICLINIC)!;
    for (const axis of ["+a", "-a", "+b", "-b"] as const) {
      const o = axisOrientation(axis, TRICLINIC);
      expect(dot(l.c, screenRight(o))).toBeCloseTo(0, 9);
      expect(dot(l.c, o.up)).toBeGreaterThan(0);
    }
    for (const axis of ["+c", "-c"] as const) {
      const o = axisOrientation(axis, TRICLINIC);
      expect(dot(l.b, screenRight(o))).toBeCloseTo(0, 9);
      expect(dot(l.b, o.up)).toBeGreaterThan(0);
    }
    // Looking down +c: a to the right, b up (an x/y plot).
    const top = axisOrientation("+c", CUBIC);
    expectVec(screenRight(top), [1, 0, 0]);
  });

  it("looking along +a shows b to the right — the untilted standard view", () => {
    const o = axisOrientation("+a", HEXAGONAL);
    const flat = standardOrientation(HEXAGONAL, 0, 0);
    // For a hexagonal cell a ⟂ c but a is not ⟂ b, so the two eye vectors
    // differ; both keep c up and b to the right.
    const l = latticeVectors(HEXAGONAL)!;
    expect(dot(l.b, screenRight(o))).toBeGreaterThan(0);
    expect(dot(l.b, screenRight(flat))).toBeGreaterThan(0);
    expect(dot(l.c, o.up)).toBeGreaterThan(0);
    expect(dot(l.c, flat.up)).toBeGreaterThan(0);
    // For an orthogonal cell the untilted standard view *is* the +a view.
    const untilted = standardOrientation(CUBIC, 0, 0);
    const alongA = axisOrientation("+a", CUBIC);
    expectVec(untilted.eye, alongA.eye, "eye");
    expectVec(untilted.up, alongA.up, "up");
  });
});

describe("orientationFromPose", () => {
  it("recovers eye and a perpendicularised up from a camera pose", () => {
    const o = orientationFromPose([3, 4, 0], [0, 0, 0], [0, 0, 1]);
    expect(o).not.toBeNull();
    expectVec(o!.eye, [0.6, 0.8, 0], "eye");
    expectVec(o!.up, [0, 0, 1], "up");
  });

  it("projects a non-perpendicular up onto the view plane", () => {
    const o = orientationFromPose([0, -10, 0], [0, 0, 0], [0, 1, 1]);
    expectOrthonormal(o!);
    expect(o!.up[2]).toBeCloseTo(1, 9);
  });

  it("returns null when the camera sits on its target", () => {
    expect(orientationFromPose([1, 2, 3], [1, 2, 3], [0, 0, 1])).toBeNull();
  });

  it("substitutes some perpendicular up when the given up is parallel to the eye", () => {
    const alongZ = orientationFromPose([0, 0, 5], [0, 0, 0], [0, 0, 1]);
    expectOrthonormal(alongZ!);
    const alongX = orientationFromPose([5, 0, 0], [0, 0, 0], [-1, 0, 0]);
    expectOrthonormal(alongX!);
  });
});

describe("screenRight", () => {
  it("completes a right-handed (right, up, eye) frame", () => {
    // Camera on -y looking along +y with z up: right is +x.
    expectVec(screenRight({ eye: [0, -1, 0], up: [0, 0, 1] }), [1, 0, 0]);
    // Camera on +x looking along -x with z up: right is +y.
    expectVec(screenRight({ eye: [1, 0, 0], up: [0, 0, 1] }), [0, 1, 0]);
  });
});
