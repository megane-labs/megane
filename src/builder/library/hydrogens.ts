/**
 * Valence-aware hydrogen addition for library molecules.
 *
 * A Ketcher sketch carries only the atoms the user drew: the hydrogens a
 * chemist leaves implicit are missing from the molfile. This module fills
 * them in the way a sketcher would — each atom gets `valence − Σ bond order`
 * hydrogens (formal charge and the hypervalent S / P valences taken into
 * account) — and places them in 3D from the atom's steric number:
 * tetrahedral, trigonal-planar or linear, oriented by the neighbours the
 * atom already has. The heavy-atom skeleton is not moved, so a flat sketch
 * stays flat except for its hydrogens (a CH₂ gets its pair above and below
 * the drawing plane, a CH₃ a staggered cone).
 *
 * Nothing here is a parser: the sketch is read as-is by the MOL parser and
 * the hydrogens are added afterwards, in the Builder, only where the user
 * asked for them.
 */

import { BOND_AROMATIC, getCovalentRadius } from "../../constants";
import type { MoleculeGeometry } from "./types";

type Vec3 = [number, number, number];

/**
 * Allowed valences (bond-order sums) of the elements a sketch can carry
 * implicit hydrogens on, lowest first; S and P step up to their hypervalent
 * states when the drawn bonds already exceed the lower one. Elements not
 * listed (metals, noble gases, …) never get hydrogens.
 */
const VALENCES: Record<number, number[]> = {
  5: [3],
  6: [4],
  7: [3],
  8: [2],
  9: [1],
  14: [4],
  15: [3, 5],
  16: [2, 4, 6],
  17: [1],
  35: [1],
  53: [1],
};

/** Valence electrons of the same elements, for counting lone pairs. */
const VALENCE_ELECTRONS: Record<number, number> = {
  5: 3,
  6: 4,
  7: 5,
  8: 6,
  9: 7,
  14: 4,
  15: 5,
  16: 6,
  17: 7,
  35: 7,
  53: 7,
};

/** The valence an atom of element `z` with formal charge `charge` needs to reach, given the bonds it already has. */
function targetValence(z: number, charge: number, bondSum: number): number | null {
  const allowed = VALENCES[z];
  if (!allowed) return null;
  const group = VALENCE_ELECTRONS[z];
  // Charge shifts the valence the way a sketcher expects: N⁺ makes 4 bonds,
  // O⁻ one, C⁺ / C⁻ three, B⁻ four.
  const shift = group >= 5 ? charge : group === 4 ? -Math.abs(charge) : -charge;
  for (const v of allowed) {
    const target = v + shift;
    if (target >= bondSum) return target;
  }
  return null;
}

/** Number of hydrogens to add to an atom, from its valence, charge and drawn bonds. */
export function implicitHydrogenCount(z: number, charge: number, bondSum: number): number {
  const target = targetValence(z, charge, Math.round(bondSum));
  if (target === null) return 0;
  return Math.max(0, target - Math.round(bondSum));
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
/** `a` normalised, or `null` when it is (nearly) zero. */
function unit(a: Vec3): Vec3 | null {
  const n = length(a);
  return n < 1e-6 ? null : scale(a, 1 / n);
}
/** The part of `a` perpendicular to unit vector `d`. */
function perpTo(a: Vec3, d: Vec3): Vec3 {
  return sub(a, scale(d, dot(a, d)));
}
/** Any unit vector perpendicular to unit vector `d`, preferring `hint`'s direction. */
function anyPerpendicular(d: Vec3, hint: Vec3 | null): Vec3 {
  if (hint) {
    const p = unit(perpTo(hint, d));
    if (p) return p;
  }
  const axis: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(axis, d))!;
}

/** Tetrahedral half-angle geometry: cos/sin of the angle between a bond and the axis of the remaining three. */
const TET = Math.acos(1 / 3); // 70.53°, the supplement of 109.47°
const TET_HALF = Math.acos(-1 / 3) / 2; // 54.74°, half the H–X–H angle
const TETRAHEDRON: Vec3[] = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
].map((v) => scale(v as Vec3, 1 / Math.sqrt(3)));

/**
 * Unit directions for `count` hydrogens on an atom that already has bonds in
 * `dirs` (unit vectors) and steric number `steric`. `planeHint` is a normal
 * the trigonal cases should keep the hydrogens perpendicular to (the sketch
 * plane, or the plane of the neighbour's own substituents); `stagger` is a
 * neighbour-substituent direction to stagger a tetrahedral cone against.
 */
export function hydrogenDirections(
  dirs: Vec3[],
  count: number,
  steric: number,
  planeHint: Vec3 | null,
  stagger: Vec3 | null,
): Vec3[] {
  const out: Vec3[] = [];
  if (count <= 0) return out;
  const k = dirs.length;
  if (k === 0) {
    if (steric <= 2) out.push([1, 0, 0], [-1, 0, 0]);
    else if (steric === 3) {
      const n = planeHint ?? [0, 0, 1];
      const p = anyPerpendicular(n, [1, 0, 0]);
      const q = cross(n, p);
      for (let j = 0; j < 3; j++) {
        const phi = (j * 2 * Math.PI) / 3;
        out.push(add(scale(p, Math.cos(phi)), scale(q, Math.sin(phi))));
      }
    } else out.push(...TETRAHEDRON);
  } else if (k === 1) {
    const d = dirs[0];
    const u = scale(d, -1);
    if (steric <= 2) out.push(u);
    else if (steric === 3) {
      const n = anyPerpendicular(d, planeHint);
      const p = unit(cross(n, d))!;
      const c = Math.cos(Math.PI / 3);
      const s = Math.sin(Math.PI / 3);
      out.push(add(scale(u, c), scale(p, s)), add(scale(u, c), scale(p, -s)));
    } else {
      const p = anyPerpendicular(d, stagger ?? planeHint);
      const q = cross(d, p);
      // Anti to one neighbour substituent means 60° from the other two: staggered.
      const phi0 = stagger ? Math.PI : 0;
      for (let j = 0; j < 3; j++) {
        const phi = phi0 + (j * 2 * Math.PI) / 3;
        const ring = add(scale(p, Math.cos(phi)), scale(q, Math.sin(phi)));
        out.push(add(scale(u, Math.cos(TET)), scale(ring, Math.sin(TET))));
      }
    }
  } else if (k === 2) {
    const [d1, d2] = dirs;
    const b = unit(scale(add(d1, d2), -1)) ?? anyPerpendicular(d1, planeHint);
    const n = unit(cross(d1, d2)) ?? anyPerpendicular(b, planeHint);
    if (steric <= 3) out.push(b, n);
    else {
      out.push(
        add(scale(b, Math.cos(TET_HALF)), scale(n, Math.sin(TET_HALF))),
        add(scale(b, Math.cos(TET_HALF)), scale(n, -Math.sin(TET_HALF))),
      );
    }
  } else {
    // Three or more neighbours: opposite their sum, or — for a flat sketch
    // whose neighbours cancel out in the plane — out of that plane.
    const sum = dirs.reduce((acc, d) => add(acc, d), [0, 0, 0] as Vec3);
    const away = length(sum) >= 0.5 ? unit(scale(sum, -1))! : null;
    const normal = unit(cross(dirs[0], dirs[1])) ?? anyPerpendicular(dirs[0], planeHint);
    out.push(away ?? normal, away ? normal : scale(normal, -1));
  }
  // A geometry the cases above do not cover (an over-coordinated atom asked
  // for more hydrogens than it has open sites) falls back to the axes.
  const axes: Vec3[] = [
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
  ];
  for (const a of axes) if (out.length < count) out.push(a);
  return out.slice(0, count);
}

export interface AddHydrogensOptions {
  /** Formal charge per atom (parallel to `elements`); omitted means all neutral. */
  charges?: ArrayLike<number> | null;
  /**
   * Normal of the plane a flat sketch was drawn in. Trigonal hydrogens on
   * atoms with a single neighbour are laid in that plane; omitted for a 3D
   * geometry, where the neighbour's own substituents define the plane.
   */
  planeNormal?: Vec3 | null;
}

export interface AddHydrogensResult {
  geometry: MoleculeGeometry;
  /** How many hydrogens were appended. */
  added: number;
}

/**
 * `geometry` with the hydrogens its valences call for appended (elements,
 * positions and single bonds to their parent atom), heavy atoms untouched.
 * Existing hydrogens count as bonds, so a saturated molecule comes back as
 * it was. Bond lengths are the covalent-radius sum.
 */
export function addHydrogens(
  geometry: MoleculeGeometry,
  options: AddHydrogensOptions = {},
): AddHydrogensResult {
  const n = geometry.elements.length;
  const pos = (i: number): Vec3 => [
    geometry.positions[i * 3],
    geometry.positions[i * 3 + 1],
    geometry.positions[i * 3 + 2],
  ];
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  const bondSum = new Array<number>(n).fill(0);
  geometry.bonds.forEach(([i, j], b) => {
    const order = geometry.bondOrders ? geometry.bondOrders[b] : 1;
    const weight = order === BOND_AROMATIC ? 1.5 : order;
    neighbours[i].push(j);
    neighbours[j].push(i);
    bondSum[i] += weight;
    bondSum[j] += weight;
  });
  const charge = (i: number) => (options.charges ? (options.charges[i] ?? 0) : 0);

  const elements = [...geometry.elements];
  const positions = [...geometry.positions];
  const bonds = geometry.bonds.map(([i, j]) => [i, j] as [number, number]);
  const bondOrders = geometry.bondOrders ? [...geometry.bondOrders] : null;
  let added = 0;

  for (let i = 0; i < n; i++) {
    const z = geometry.elements[i];
    const count = implicitHydrogenCount(z, charge(i), bondSum[i]);
    if (count === 0) continue;
    const p = pos(i);
    const dirs: Vec3[] = [];
    for (const j of neighbours[i]) {
      const d = unit(sub(pos(j), p));
      if (d) dirs.push(d);
    }
    const sigma = dirs.length + count;
    const electrons = VALENCE_ELECTRONS[z] - charge(i) - Math.round(bondSum[i]) - count;
    const lonePairs = Math.max(0, Math.floor(electrons / 2));
    const steric = sigma + lonePairs;

    // The plane and stagger hints come from the first neighbour's other substituents.
    let planeHint: Vec3 | null = options.planeNormal ?? null;
    let stagger: Vec3 | null = null;
    if (dirs.length === 1) {
      const j = neighbours[i][0];
      const other = neighbours[j].find((m) => m !== i);
      if (other !== undefined) {
        const s = unit(sub(pos(other), pos(j)));
        if (s) {
          stagger = s;
          planeHint = unit(cross(dirs[0], s)) ?? planeHint;
        }
      }
    }

    const bondLength = getCovalentRadius(z) + getCovalentRadius(1);
    for (const dir of hydrogenDirections(dirs, count, steric, planeHint, stagger)) {
      const h = elements.length;
      elements.push(1);
      positions.push(
        p[0] + dir[0] * bondLength,
        p[1] + dir[1] * bondLength,
        p[2] + dir[2] * bondLength,
      );
      bonds.push([i, h]);
      bondOrders?.push(1);
      added++;
    }
  }

  const out: MoleculeGeometry = { elements, positions, bonds };
  if (bondOrders) out.bondOrders = bondOrders;
  return { geometry: out, added };
}
