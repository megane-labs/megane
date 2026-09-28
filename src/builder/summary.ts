/**
 * One-line descriptions of a structure and its cell, for the info line over
 * the view (`InfoHud`).
 */

import type { Snapshot } from "../types";
import { getAtomicMass } from "../constants";
import { boxToCellParams } from "../crystal/cell";
import { formulaOf } from "./library/fragment";

/** The structure's formula and molar mass. */
export function structureSummary(shown: Snapshot): { formula: string; mass: number } {
  let mass = 0;
  for (let i = 0; i < shown.nAtoms; i++) mass += getAtomicMass(shown.elements[i]);
  return { formula: formulaOf(shown.elements), mass };
}

/** `a × b × c Å`, with the angles when the cell is not orthogonal. */
export function cellSummary(box: Float32Array): string {
  const p = boxToCellParams(box);
  const f = (v: number) => v.toFixed(2);
  const angles =
    Math.abs(p.alpha - 90) < 0.05 && Math.abs(p.beta - 90) < 0.05 && Math.abs(p.gamma - 90) < 0.05
      ? ""
      : ` · ${f(p.alpha)}° ${f(p.beta)}° ${f(p.gamma)}°`;
  return `${f(p.a)} × ${f(p.b)} × ${f(p.c)} Å${angles}`;
}
