/**
 * Line / wireframe representation renderer (VMD "Lines" / PyMOL "lines" style).
 *
 * Draws the molecule as thin GL line segments instead of spheres + cylinders:
 *  - Each bond is split at its midpoint into two segments, each colored with the
 *    CPK color of its nearer atom (two-tone, like VMD).
 *  - Atoms that participate in no bond are drawn as a small 3-axis cross so lone
 *    atoms / ions remain visible.
 *
 * GL line width is effectively 1px on most WebGL platforms (the `linewidth`
 * material property is ignored), which matches the thin-line look of VMD/PyMOL.
 *
 * Data flows in via loadSnapshot() (topology) and updatePositions() (trajectory
 * frames). The geometry is built only while the lines are visible: a hidden
 * renderer just remembers the topology and the latest positions, and builds
 * from them when it is first shown. Line mode is off by default, and for a
 * 1M-atom structure the geometry is ~100 MB that nobody would see.
 * The renderer owns a THREE.LineSegments that MoleculeRenderer adds to the scene.
 */

import * as THREE from "three";
import type { Snapshot } from "../types";
import { getColor } from "../constants";

/** Half-length of each arm of the cross drawn for a bondless atom, in Å. */
const LONE_ATOM_CROSS_RADIUS = 0.2;

export class LineRenderer {
  /** The THREE.LineSegments holding all line geometry; add to scene. */
  readonly mesh: THREE.LineSegments;

  private snapshot: Snapshot | null = null;
  /** Atom index pairs (a, b) of the drawn bonds; each one is 4 vertices
   *  (a → midpoint, midpoint → b). */
  private shownBonds = new Uint32Array(0);
  /** Bondless atoms drawn as a cross; each one is 6 vertices (±x, ±y, ±z),
   *  following the bond vertices. */
  private loneAtoms = new Uint32Array(0);
  /** When set, only atoms flagged here (`mask[i] === 1`) are drawn as lines —
   *  used by per-atom representation to render one species as lines while the
   *  rest stays ball-and-stick. `null` draws the whole structure. */
  private lineMask: Uint8Array | null = null;
  /** The topology changed since the geometry was last built. */
  private dirty = false;
  /** Positions of the latest frame, when they differ from the snapshot's. */
  private latestPositions: Float32Array | null = null;
  /** A frame arrived while hidden, so the built vertices are out of date. */
  private positionsStale = false;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    this.mesh = new THREE.LineSegments(geometry, material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /**
   * Load a new snapshot (topology). When `lineMask` is given, only atoms
   * flagged in it (and bonds whose *both* endpoints are flagged) are drawn —
   * the rest are left to the mesh renderers. The geometry is built now if the
   * lines are visible, otherwise when they are next shown.
   */
  loadSnapshot(snapshot: Snapshot, lineMask: Uint8Array | null = null): void {
    if (snapshot !== this.snapshot) this.latestPositions = null;
    this.snapshot = snapshot;
    this.lineMask = lineMask;
    this.dirty = true;
    if (this.mesh.visible) this._build(snapshot);
  }

  /** Update positions for a new trajectory frame (topology unchanged). */
  updatePositions(positions: Float32Array): void {
    if (!this.snapshot) return;
    this.latestPositions = positions;
    if (this.dirty) return;
    if (!this.mesh.visible) {
      this.positionsStale = true;
      return;
    }
    this._writePositions(positions);
  }

  /** Show or hide the lines, building or refreshing the geometry on show. */
  setVisible(v: boolean): void {
    if (v && this.snapshot) {
      if (this.dirty) this._build(this.snapshot);
      else if (this.positionsStale) this._writePositions(this.latestPositions!);
    }
    this.mesh.visible = v;
  }

  /** Free all Three.js GPU resources. */
  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private _build(snapshot: Snapshot): void {
    this.dirty = false;
    const { nAtoms, nBonds, bonds, elements } = snapshot;
    const mask = this.lineMask;
    const inMask = (i: number): boolean => !mask || mask[i] === 1;

    // Track which atoms have at least one *shown* bond so we can cross-mark the
    // rest (only line atoms get a cross when masking is active). Only bonds
    // whose both endpoints are line atoms are drawn as lines.
    const bonded = new Uint8Array(nAtoms);
    let nShownBonds = 0;
    for (let i = 0; i < nBonds; i++) {
      const a = bonds[i * 2];
      const b = bonds[i * 2 + 1];
      if (!inMask(a) || !inMask(b)) continue;
      bonded[a] = 1;
      bonded[b] = 1;
      nShownBonds++;
    }
    let nLone = 0;
    for (let i = 0; i < nAtoms; i++) if (!bonded[i] && inMask(i)) nLone++;

    const shownBonds = new Uint32Array(nShownBonds * 2);
    const loneAtoms = new Uint32Array(nLone);
    // Vertex budget: each shown bond → 2 segments (4 verts); each lone line atom
    // → 3 crosses (6 verts).
    const nVerts = nShownBonds * 4 + nLone * 6;
    const colorsArr = new Float32Array(nVerts * 3);
    const setColor = (v: number, rgb: [number, number, number]): void => {
      colorsArr[v * 3] = rgb[0];
      colorsArr[v * 3 + 1] = rgb[1];
      colorsArr[v * 3 + 2] = rgb[2];
    };

    // Two-tone bond segments: a→mid (color a), mid→b (color b).
    let k = 0;
    for (let i = 0; i < nBonds; i++) {
      const a = bonds[i * 2];
      const b = bonds[i * 2 + 1];
      if (!inMask(a) || !inMask(b)) continue;
      shownBonds[k * 2] = a;
      shownBonds[k * 2 + 1] = b;
      const ca = getColor(elements[a]);
      const cb = getColor(elements[b]);
      setColor(k * 4, ca);
      setColor(k * 4 + 1, ca);
      setColor(k * 4 + 2, cb);
      setColor(k * 4 + 3, cb);
      k++;
    }

    // Lone-atom crosses: 3 axis-aligned segments through the atom position.
    let v = nShownBonds * 4;
    k = 0;
    for (let i = 0; i < nAtoms; i++) {
      if (bonded[i] || !inMask(i)) continue;
      loneAtoms[k++] = i;
      const c = getColor(elements[i]);
      for (let j = 0; j < 6; j++) setColor(v++, c);
    }

    this.shownBonds = shownBonds;
    this.loneAtoms = loneAtoms;
    this.mesh.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3),
    );
    this.mesh.geometry.setAttribute("color", new THREE.BufferAttribute(colorsArr, 3));
    this._writePositions(this.latestPositions ?? snapshot.positions);
  }

  private _writePositions(positions: Float32Array): void {
    this.positionsStale = false;
    const attr = this.mesh.geometry.getAttribute("position");
    if (!attr) return;
    const arr = attr.array as Float32Array;
    const bonds = this.shownBonds;
    const nBonds = bonds.length / 2;
    for (let i = 0; i < nBonds; i++) {
      const a = bonds[i * 2] * 3;
      const b = bonds[i * 2 + 1] * 3;
      const o = i * 12;
      const mx = (positions[a] + positions[b]) * 0.5;
      const my = (positions[a + 1] + positions[b + 1]) * 0.5;
      const mz = (positions[a + 2] + positions[b + 2]) * 0.5;
      arr[o] = positions[a];
      arr[o + 1] = positions[a + 1];
      arr[o + 2] = positions[a + 2];
      arr[o + 3] = mx;
      arr[o + 4] = my;
      arr[o + 5] = mz;
      arr[o + 6] = mx;
      arr[o + 7] = my;
      arr[o + 8] = mz;
      arr[o + 9] = positions[b];
      arr[o + 10] = positions[b + 1];
      arr[o + 11] = positions[b + 2];
    }
    const lone = this.loneAtoms;
    let o = nBonds * 12;
    for (let i = 0; i < lone.length; i++) {
      const a = lone[i] * 3;
      // One segment per axis, from -r to +r along it.
      for (let axis = 0; axis < 3; axis++) {
        for (let sign = -1; sign <= 1; sign += 2) {
          arr[o] = positions[a];
          arr[o + 1] = positions[a + 1];
          arr[o + 2] = positions[a + 2];
          arr[o + axis] += LONE_ATOM_CROSS_RADIUS * sign;
          o += 3;
        }
      }
    }
    attr.needsUpdate = true;
  }
}
