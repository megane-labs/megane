/**
 * Moving and turning atoms by hand: what a drag in the view, or the Transform
 * form, does to the selected atoms.
 *
 * A drag on an atom moves the selection it is in. The modifiers held at the
 * press pick the motion (`dragModeFor`): plain drags translate in the screen
 * plane, Shift moves in depth, Ctrl / ⌘ turns the selection about its centre
 * like a trackball, and Ctrl / ⌘ + Shift spins it about the line of sight.
 * During the drag an axis key locks the motion to x / y / z or to the cell's
 * a / b / c (`axisVector`), and *Snap* rounds it to `SNAP_DISTANCE` /
 * `SNAP_ANGLE`.
 *
 * Everything here is a pure function of the positions at the press and the
 * gesture so far (`BuildDragGesture`), so a drag can be recomputed from
 * scratch on every pointer move, or when an axis key changes mid-drag,
 * without drift. The result is a `Displacements` map that `BuilderStore`
 * turns into `move_atoms` ops.
 */

import { getRadius } from "../constants";
import type { EditAtomRef, EditOp } from "../pipeline/types";
import type { Snapshot } from "../types";
import { rotateAbout, type Displacements } from "./geometry";
import type { BuildDragGesture, BuildModifiers } from "./types";

export type Vec3 = [number, number, number];

/** What a drag does to the atoms it carries. */
export type DragMode = "translate" | "depth" | "rotate" | "spin";

/** The axes a drag can be locked to: Cartesian, or the cell vectors. */
export type AxisKey = "x" | "y" | "z" | "a" | "b" | "c";
export const AXIS_KEYS: readonly AxisKey[] = ["x", "y", "z", "a", "b", "c"];

/** Step of a snapped move, in Å. */
export const SNAP_DISTANCE = 0.1;
/** Step of a snapped turn, in degrees. */
export const SNAP_ANGLE = 15;
/** Degrees a turn takes per pixel of pointer travel. */
export const ROTATE_DEG_PER_PIXEL = 0.5;
/**
 * Two atoms that are not bonded are a close contact when they are nearer
 * than this fraction of the sum of their van der Waals radii (1.2 Å for two
 * hydrogens, 1.7 Å for two carbons) — closer than any non-bonded pair in a
 * sensible geometry, 1–3 pairs included.
 */
export const CLOSE_CONTACT_FACTOR = 0.5;
/** Above this many atom pairs, close contacts are not checked during a drag. */
export const MAX_CONTACT_PAIRS = 4_000_000;

/** The motion the modifiers held at the press select. */
export function dragModeFor(mods: Pick<BuildModifiers, "shiftKey" | "mod">): DragMode {
  if (mods.mod) return mods.shiftKey ? "spin" : "rotate";
  return mods.shiftKey ? "depth" : "translate";
}

/** Unit vector of an axis key; a / b / c need a cell (rows of `box`), else null. */
export function axisVector(key: AxisKey, box: ArrayLike<number> | null): Vec3 | null {
  const k = AXIS_KEYS.indexOf(key);
  if (k < 3) {
    const v: Vec3 = [0, 0, 0];
    v[k] = 1;
    return v;
  }
  if (!box || box.length < 9) return null;
  const r = (k - 3) * 3;
  const v: Vec3 = [box[r], box[r + 1], box[r + 2]];
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** Mean position of `atoms` (flat xyz positions). */
export function centroid(positions: ArrayLike<number>, atoms: number[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const i of atoms) for (let k = 0; k < 3; k++) c[k] += positions[i * 3 + k];
  const n = Math.max(atoms.length, 1);
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** What a drag did so far, for the status line. */
export interface DragReadout {
  kind: "move" | "rotate";
  /** Å moved (signed along a locked axis), or degrees turned. */
  value: number;
  /** The move, for an unlocked translation. */
  delta: Vec3 | null;
  axis: AxisKey | null;
}

export interface DragOutcome {
  displacements: Displacements;
  readout: DragReadout;
}

export interface DragOptions {
  /** The locked axis and its unit vector, or null for a free drag. */
  axis: { key: AxisKey; vector: Vec3 } | null;
  snap: boolean;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const plus = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const snapTo = (v: number, step: number) => Math.round(v / step) * step;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Signed angle (rad, counter-clockwise on screen) from `a` to `b` around `c`, in pixels. */
function screenTurn(c: [number, number], a: [number, number], b: [number, number]): number {
  const ax = a[0] - c[0];
  const ay = a[1] - c[1];
  const bx = b[0] - c[0];
  const by = b[1] - c[1];
  if (Math.hypot(ax, ay) < 4 || Math.hypot(bx, by) < 4) return 0;
  // Screen y points down, so the visual counter-clockwise turn is −Δatan2.
  let t = Math.atan2(ay, ax) - Math.atan2(by, bx);
  if (t > Math.PI) t -= 2 * Math.PI;
  if (t <= -Math.PI) t += 2 * Math.PI;
  return t;
}

function translation(atoms: number[], d: Vec3): Displacements {
  return new Map(atoms.map((i) => [i, d]));
}

function rotation(
  start: ArrayLike<number>,
  atoms: number[],
  center: Vec3,
  turns: { axis: Vec3; angle: number }[],
): Displacements {
  const out: Displacements = new Map();
  for (const i of atoms) {
    const from: Vec3 = [start[i * 3], start[i * 3 + 1], start[i * 3 + 2]];
    let p = from;
    for (const t of turns) p = rotateAbout(p, center, t.axis, t.angle);
    out.set(i, [p[0] - from[0], p[1] - from[1], p[2] - from[2]]);
  }
  return out;
}

/**
 * Where a drag puts `atoms`: their displacements from `start` (the positions
 * at the press) for the gesture so far, and the readout.
 */
export function dragDisplacements(
  start: ArrayLike<number>,
  atoms: number[],
  mode: DragMode,
  g: BuildDragGesture,
  opts: DragOptions,
): DragOutcome {
  const dx = g.to[0] - g.from[0];
  const dy = g.to[1] - g.from[1];
  const w = g.worldPerPixel;
  const axis = opts.axis;
  // The pointer's travel in the camera plane through the grabbed atom.
  const inPlane = plus(scale(g.right, dx * w), scale(g.up, -dy * w));

  if (mode === "translate" || mode === "depth") {
    if (axis) {
      // Along the axis by the distance whose on-screen image best matches the
      // pointer's travel. An axis pointing at the viewer has no such image;
      // then the vertical travel moves along it, as a depth drag does.
      const u = axis.vector;
      const along = dot(u, g.toCamera);
      const onScreen: Vec3 = plus(u, scale(g.toCamera, -along));
      const len2 = dot(onScreen, onScreen);
      let t = len2 > 0.05 ? dot(inPlane, onScreen) / len2 : dy * w * (along >= 0 ? 1 : -1);
      if (opts.snap) t = snapTo(t, SNAP_DISTANCE);
      return {
        displacements: translation(atoms, scale(u, t)),
        readout: { kind: "move", value: t, delta: null, axis: axis.key },
      };
    }
    let d: Vec3;
    if (mode === "depth") {
      // Dragging up pushes the atoms away from the viewer, down pulls them in.
      let s = dy * w;
      if (opts.snap) s = snapTo(s, SNAP_DISTANCE);
      d = scale(g.toCamera, s);
    } else {
      d = opts.snap ? (inPlane.map((v) => snapTo(v, SNAP_DISTANCE)) as Vec3) : inPlane;
    }
    return {
      displacements: translation(atoms, d),
      readout: { kind: "move", value: Math.hypot(...d), delta: d, axis: null },
    };
  }

  const center = centroid(start, atoms);
  if (axis) {
    const u = axis.vector;
    let deg =
      mode === "spin"
        ? ((screenTurn(g.project(center), g.from, g.to) * 180) / Math.PI) *
          (dot(u, g.toCamera) < 0 ? -1 : 1)
        : dx * ROTATE_DEG_PER_PIXEL;
    if (opts.snap) deg = snapTo(deg, SNAP_ANGLE);
    return {
      displacements: rotation(start, atoms, center, [{ axis: u, angle: rad(deg) }]),
      readout: { kind: "rotate", value: deg, delta: null, axis: axis.key },
    };
  }
  if (mode === "spin") {
    let deg = (screenTurn(g.project(center), g.from, g.to) * 180) / Math.PI;
    if (opts.snap) deg = snapTo(deg, SNAP_ANGLE);
    return {
      displacements: rotation(start, atoms, center, [{ axis: g.toCamera, angle: rad(deg) }]),
      readout: { kind: "rotate", value: deg, delta: null, axis: null },
    };
  }
  // Trackball: a horizontal drag turns the front toward the pointer about the
  // screen's up axis, a vertical drag about its right axis.
  let yaw = dx * ROTATE_DEG_PER_PIXEL;
  let pitch = dy * ROTATE_DEG_PER_PIXEL;
  if (opts.snap) {
    yaw = snapTo(yaw, SNAP_ANGLE);
    pitch = snapTo(pitch, SNAP_ANGLE);
  }
  const total =
    (2 *
      Math.acos(Math.min(1, Math.abs(Math.cos(rad(yaw) / 2) * Math.cos(rad(pitch) / 2)))) *
      180) /
    Math.PI;
  return {
    displacements: rotation(start, atoms, center, [
      { axis: g.up, angle: rad(yaw) },
      { axis: g.right, angle: rad(pitch) },
    ]),
    readout: { kind: "rotate", value: total, delta: null, axis: null },
  };
}

/** The status-line text of a readout, e.g. `Move 1.20 Å along x` or `Rotate 30.0°`. */
export function readoutLabel(r: DragReadout): string {
  const along = r.axis ? ` along ${r.axis}` : "";
  if (r.kind === "move") {
    const delta = r.delta ? ` (${r.delta.map((v) => v.toFixed(2)).join(", ")})` : "";
    return `Move ${r.value.toFixed(2)} Å${along}${delta}`;
  }
  return `Rotate ${r.value.toFixed(1)}°${r.axis ? ` about ${r.axis}` : ""}`;
}

/**
 * Atoms of `moved` and of the rest that are a close contact
 * (`CLOSE_CONTACT_FACTOR`) without being bonded, sorted. Empty when the
 * check would be too large to run on every pointer move.
 */
export function closeContacts(snapshot: Snapshot, moved: number[]): number[] {
  const n = snapshot.nAtoms;
  if (moved.length === 0 || moved.length * n > MAX_CONTACT_PAIRS) return [];
  const inMoved = new Uint8Array(n);
  for (const i of moved) if (i >= 0 && i < n) inMoved[i] = 1;
  const bonded = new Set<number>();
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = snapshot.bonds[b * 2];
    const j = snapshot.bonds[b * 2 + 1];
    if (inMoved[i] || inMoved[j]) bonded.add(Math.min(i, j) * n + Math.max(i, j));
  }
  const p = snapshot.positions;
  const hit = new Set<number>();
  for (const i of moved) {
    if (i < 0 || i >= n) continue;
    const ri = getRadius(snapshot.elements[i]);
    for (let j = 0; j < n; j++) {
      if (inMoved[j]) continue;
      const lim = CLOSE_CONTACT_FACTOR * (ri + getRadius(snapshot.elements[j]));
      const ddx = p[i * 3] - p[j * 3];
      const ddy = p[i * 3 + 1] - p[j * 3 + 1];
      const ddz = p[i * 3 + 2] - p[j * 3 + 2];
      if (ddx * ddx + ddy * ddy + ddz * ddz >= lim * lim) continue;
      if (bonded.has(Math.min(i, j) * n + Math.max(i, j))) continue;
      hit.add(i);
      hit.add(j);
    }
  }
  return [...hit].sort((a, b) => a - b);
}

/** Every atom of `atoms` moved by `delta`: the Transform form's Translate. */
export function translateDisplacements(atoms: number[], delta: Vec3): Displacements {
  return translation(atoms, delta);
}

/** `atoms` turned by `deg` about `axis` through their centre: the Transform form's Rotate. */
export function rotateDisplacements(
  positions: ArrayLike<number>,
  atoms: number[],
  axis: Vec3,
  deg: number,
): Displacements {
  return rotation(positions, atoms, centroid(positions, atoms), [{ axis, angle: rad(deg) }]);
}

/** `move_atoms` ops for `displacements`, one per distinct displacement. */
export function moveOps(displacements: Displacements, refs: Map<number, EditAtomRef>): EditOp[] {
  const groups = new Map<string, { delta: [number, number, number]; atoms: EditAtomRef[] }>();
  for (const [i, delta] of displacements) {
    const ref = refs.get(i);
    if (ref === undefined || delta.every((v) => Math.abs(v) < 1e-9)) continue;
    const key = delta.map((v) => v.toFixed(9)).join(",");
    const group = groups.get(key) ?? { delta, atoms: [] };
    group.atoms.push(ref);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({ op: "move_atoms", atoms: g.atoms, delta: g.delta }));
}
