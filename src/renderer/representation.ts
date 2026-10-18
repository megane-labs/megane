/**
 * Representation modes and the per-renderer switches each one implies.
 *
 * Every place that decides whether atoms, bonds, cartoon, surface or lines are
 * drawn — and at which radius — derives it from `representationFlags`, so the
 * main atom mesh, the secondary atom layers and the bond mesh can never
 * disagree about a mode (they once did: periodic atom copies vanished in
 * illustrative mode because one copy of the test forgot that mode).
 */

import { BALL_STICK_ATOM_SCALE, LICORICE_RADIUS, SPACEFILL_ATOM_SCALE } from "../constants";

/** Representation mode for the viewer. */
export type RepresentationType =
  | "atoms"
  | "licorice"
  | "cartoon"
  | "both"
  | "surface"
  | "line"
  | "illustrative";

/** What a representation mode draws, and how the atom spheres are sized. */
export interface RepresentationFlags {
  /** Atom spheres are drawn (the main mesh and every secondary atom layer). */
  readonly showAtoms: boolean;
  /**
   * Bond sticks are drawn. Callers still AND this with "the pipeline emits
   * bonds". Illustrative hides them: its touching spacefill spheres would
   * swallow every stick anyway.
   */
  readonly showBonds: boolean;
  /** Cα cartoon is drawn (when the structure has a backbone). */
  readonly showCartoon: boolean;
  /** Molecular surface is drawn. */
  readonly showSurface: boolean;
  /** VMD/PyMOL-style wireframe lines replace the atom/bond meshes. */
  readonly showLine: boolean;
  /** Flat, unlit shading with a silhouette outline (Mol*-style spacefill). */
  readonly illustrative: boolean;
  /** Fraction of the vdW radius the atom spheres are drawn at. */
  readonly atomRadiusScale: number;
  /**
   * One radius shared by every atom and bond (licorice tube), or `null` for
   * per-element atom radii and per-order bond radii.
   */
  readonly uniformRadius: number | null;
}

/** Derive the renderer switches for a representation mode. */
export function representationFlags(type: RepresentationType): RepresentationFlags {
  const illustrative = type === "illustrative";
  const showAtoms = type === "atoms" || type === "both" || type === "licorice" || illustrative;
  return {
    showAtoms,
    showBonds: showAtoms && !illustrative,
    showCartoon: type === "cartoon" || type === "both",
    showSurface: type === "surface",
    showLine: type === "line",
    illustrative,
    atomRadiusScale: illustrative ? SPACEFILL_ATOM_SCALE : BALL_STICK_ATOM_SCALE,
    uniformRadius: type === "licorice" ? LICORICE_RADIUS : null,
  };
}
