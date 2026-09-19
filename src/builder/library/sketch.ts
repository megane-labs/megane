/**
 * Turning what the user drew, opened or selected into a library molecule.
 *
 * A Ketcher sketch arrives as a molfile: flat, unit bond lengths. It is
 * parsed by the same MOL parser every host uses, then rescaled to Å (bond
 * lengths from covalent radii) and centred — nothing else is invented, so a
 * sketched molecule is exactly the atoms and bonds the user drew, and stays
 * planar until they move it.
 */

import { parseStructureFile, parseStructureText } from "../../parsers/structure";
import type { Snapshot } from "../../types";
import {
  centered,
  formulaOf,
  geometryFromSnapshot,
  isPlanar,
  scaleBondsToCovalent,
} from "./fragment";
import type { LibraryMoleculeDraft, LibraryOrigin } from "./types";

/** Name a molecule gets when the user leaves the name blank. */
export function defaultName(formula: string): string {
  return formula || "Molecule";
}

/** A draft from a snapshot (a parsed file or the current document), optionally a subset of its atoms. */
export function draftFromSnapshot(
  snapshot: Snapshot,
  name: string,
  origin: LibraryOrigin,
  indices?: number[],
): LibraryMoleculeDraft {
  const raw = geometryFromSnapshot(snapshot, indices);
  if (raw.elements.length === 0) throw new Error("The molecule has no atoms.");
  const planar = isPlanar(raw.positions);
  const geometry = centered(planar ? scaleBondsToCovalent(raw) : raw);
  const formula = formulaOf(geometry.elements);
  const draft: LibraryMoleculeDraft = {
    name: name.trim() || defaultName(formula),
    formula,
    origin,
    ...geometry,
  };
  if (planar) draft.planar = true;
  return draft;
}

/** Parse a molfile (Ketcher's output, or pasted text) into a draft. */
export async function draftFromMolfile(
  molfile: string,
  name: string,
): Promise<LibraryMoleculeDraft> {
  const text = molfile.trim();
  if (!text) throw new Error("The sketch is empty.");
  const parsed = await parseStructureText(molfile, "sketch.mol");
  const draft = draftFromSnapshot(parsed.snapshot, name, "sketch");
  draft.molfile = molfile;
  return draft;
}

/** Parse a structure file the user picked into a draft named after the file. */
export async function draftFromFile(file: File, name?: string): Promise<LibraryMoleculeDraft> {
  const parsed = await parseStructureFile(file);
  const base = file.name.replace(/\.[^.]+$/, "");
  return draftFromSnapshot(parsed.snapshot, name ?? base, "file");
}
