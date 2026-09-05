/**
 * Camera orientations derived from the lattice vectors (issue #661).
 *
 * Two families of orientation are computed here, both from the actual cell
 * vectors rather than a fixed rotation matrix so that non-orthogonal cells
 * are honoured:
 *
 * - {@link standardOrientation} — VESTA's "Standard orientation of crystal
 *   shape": +c points up the screen and +b to the right, then the eye is
 *   swung by arctan(1/3) ≈ 18.435° around the vertical axis and raised by
 *   arctan(1/6) ≈ 9.462° above the horizon. The default view and "Reset
 *   view" use it.
 * - {@link axisOrientation} — look straight along one crystallographic
 *   (±a, ±b, ±c) or Cartesian (±x, ±y, ±z) axis. The signed axis names the
 *   side the camera sits on, so "+a" means the +a end of the cell points at
 *   the viewer (VESTA's a* toolbar button); c is kept upright for the a/b
 *   views and b for the c views.
 *
 * Structures without a cell fall back to the Cartesian frame (a = x, b = y,
 * c = z), so every structure has a well-defined standard orientation and the
 * crystal- and Cartesian-axis views coincide for them.
 *
 * Everything here is pure vector math with no three.js dependency so it can
 * be unit-tested without a WebGL context.
 */

export type Vec3 = [number, number, number];

export type LatticeAxis = "a" | "b" | "c";
export type CartesianAxis = "x" | "y" | "z";
export type AxisSign = "+" | "-";
/** A signed axis a camera can be aligned with, e.g. `"+a"` or `"-z"`. */
export type ViewAxis = `${AxisSign}${LatticeAxis | CartesianAxis}`;

/** Every {@link ViewAxis}, crystal axes first, in the order the UI lists them. */
export const LATTICE_VIEW_AXES: readonly ViewAxis[] = ["+a", "-a", "+b", "-b", "+c", "-c"];
export const CARTESIAN_VIEW_AXES: readonly ViewAxis[] = ["+x", "-x", "+y", "-y", "+z", "-z"];
export const VIEW_AXES: readonly ViewAxis[] = [...LATTICE_VIEW_AXES, ...CARTESIAN_VIEW_AXES];

/** Type guard for strings coming from a host message or a test hook. */
export function isViewAxis(value: unknown): value is ViewAxis {
  return typeof value === "string" && (VIEW_AXES as readonly string[]).includes(value);
}

/** Lattice vectors in Å, Cartesian components. */
export interface LatticeVectors {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

/** The frame used when a structure carries no (usable) cell. */
export const CARTESIAN_LATTICE: Readonly<LatticeVectors> = Object.freeze({
  a: [1, 0, 0] as Vec3,
  b: [0, 1, 0] as Vec3,
  c: [0, 0, 1] as Vec3,
});

/**
 * A camera pose relative to its target, independent of distance and zoom.
 * Both vectors are unit length and mutually perpendicular.
 */
export interface CameraOrientation {
  /** Direction from the target to the camera. */
  eye: Vec3;
  /** Screen-up direction. */
  up: Vec3;
}

/** Horizontal swing of the standard orientation: arctan(1/3) ≈ 18.435°. */
export const STANDARD_AZIMUTH = Math.atan(1 / 3);
/** Elevation of the standard orientation: arctan(1/6) ≈ 9.462°. */
export const STANDARD_ELEVATION = Math.atan(1 / 6);

const EPS = 1e-9;

function dot(u: Vec3, v: Vec3): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

function cross(u: Vec3, v: Vec3): Vec3 {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function add(u: Vec3, v: Vec3): Vec3 {
  return [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
}

/** Unit vector along `v`, or null when `v` is (numerically) zero. */
function normalize(v: Vec3): Vec3 | null {
  const len = length(v);
  return len > EPS ? scale(v, 1 / len) : null;
}

/** Unit vector along `v`; callers guarantee `v` is not zero. */
function unit(v: Vec3): Vec3 {
  return scale(v, 1 / length(v));
}

/** Some unit vector perpendicular to the unit vector `v`. */
function anyPerpendicular(v: Vec3): Vec3 {
  const helper: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(add(helper, scale(v, -dot(helper, v))));
}

/**
 * Component of `v` perpendicular to the unit vector `axis`, normalised. When
 * `v` is parallel to `axis` (or zero) there is no such component, and an
 * arbitrary perpendicular is returned instead so the caller always gets a
 * usable screen-up.
 */
function perpendicular(v: Vec3, axis: Vec3): Vec3 {
  return normalize(add(v, scale(axis, -dot(v, axis)))) ?? anyPerpendicular(axis);
}

/**
 * Read the lattice vectors out of a snapshot's row-major 3×3 `box`.
 *
 * Returns null when there is no usable cell: a missing or short array, an
 * all-zero box (how parsers mark "no cell"), a zero-length vector, or a
 * (near-)degenerate triple whose volume is zero. Callers substitute the
 * Cartesian frame in that case.
 */
export function latticeVectors(box: ArrayLike<number> | null | undefined): LatticeVectors | null {
  if (!box || box.length < 9) return null;
  const a: Vec3 = [box[0], box[1], box[2]];
  const b: Vec3 = [box[3], box[4], box[5]];
  const c: Vec3 = [box[6], box[7], box[8]];
  for (const v of [a, b, c]) {
    if (!v.every(Number.isFinite)) return null;
  }
  const la = length(a);
  const lb = length(b);
  const lc = length(c);
  if (la <= EPS || lb <= EPS || lc <= EPS) return null;
  // Volume relative to the product of the edge lengths: 1 for an orthogonal
  // cell, → 0 as the vectors become coplanar.
  const volume = Math.abs(dot(a, cross(b, c)));
  if (volume <= 1e-6 * la * lb * lc) return null;
  return { a, b, c };
}

/**
 * The screen frame VESTA's standard orientation starts from: +c up, +b
 * right, and the viewer on the side `right × up` points to (the +a side for
 * a right-handed cell).
 */
function baseFrame(lattice: LatticeVectors): { right: Vec3; up: Vec3; toward: Vec3 } {
  // latticeVectors() rejects zero and coplanar vectors (and the Cartesian
  // frame is orthonormal), so c is never zero and b never parallel to c here.
  const up = unit(lattice.c);
  const right = perpendicular(lattice.b, up);
  const toward = cross(right, up);
  return { right, up, toward };
}

/**
 * VESTA's "Standard orientation of crystal shape" for the given cell (or the
 * Cartesian frame when there is none).
 */
export function standardOrientation(
  box: ArrayLike<number> | null | undefined,
  azimuth: number = STANDARD_AZIMUTH,
  elevation: number = STANDARD_ELEVATION,
): CameraOrientation {
  const lattice = latticeVectors(box) ?? CARTESIAN_LATTICE;
  const { right, up, toward } = baseFrame(lattice);
  // Swing the eye horizontally toward +b (the model's +a end turns to the
  // lower left of the screen), then raise it above the horizon so the top
  // face of the cell shows.
  const horizontal = add(scale(toward, Math.cos(azimuth)), scale(right, Math.sin(azimuth)));
  const eye = add(scale(horizontal, Math.cos(elevation)), scale(up, Math.sin(elevation)));
  // Screen-up is world-up tilted back by the same elevation so it stays
  // perpendicular to the eye vector.
  const screenUp = add(scale(up, Math.cos(elevation)), scale(horizontal, -Math.sin(elevation)));
  return { eye, up: screenUp };
}

/**
 * Look straight along a lattice or Cartesian axis from its positive (`+`) or
 * negative (`-`) side. See the module docs for the up-vector convention.
 */
export function axisOrientation(
  axis: ViewAxis,
  box: ArrayLike<number> | null | undefined,
): CameraOrientation {
  const sign = axis[0] === "-" ? -1 : 1;
  const name = axis[1] as LatticeAxis | CartesianAxis;
  const lattice =
    name === "x" || name === "y" || name === "z"
      ? CARTESIAN_LATTICE
      : (latticeVectors(box) ?? CARTESIAN_LATTICE);
  const key: LatticeAxis = name === "x" ? "a" : name === "y" ? "b" : name === "z" ? "c" : name;
  // Lattices from latticeVectors() and the Cartesian frame never carry a zero
  // vector, and no two of their vectors are parallel.
  const eye = unit(scale(lattice[key], sign));
  // Keep c upright when looking along a or b; when looking along c itself,
  // b goes up (so the +c view shows a to the right, b up, like an x/y plot).
  const up = perpendicular(key === "c" ? lattice.b : lattice.c, eye);
  return { eye, up };
}

/**
 * Screen-right direction of an orientation (`up × eye`), completing the
 * right-handed screen frame (right, up, eye).
 */
export function screenRight(orientation: CameraOrientation): Vec3 {
  return cross(orientation.up, orientation.eye);
}

/** Orientation of a camera at `position` looking at `target` with `up`. */
export function orientationFromPose(
  position: ArrayLike<number>,
  target: ArrayLike<number>,
  up: ArrayLike<number>,
): CameraOrientation | null {
  const eye = normalize([
    position[0] - target[0],
    position[1] - target[1],
    position[2] - target[2],
  ]);
  if (!eye) return null;
  return { eye, up: perpendicular([up[0], up[1], up[2]], eye) };
}
