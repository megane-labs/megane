/**
 * Turning what the user drew, opened or selected into a library molecule.
 *
 * A Ketcher sketch arrives as a molfile: flat, unit bond lengths, and
 * without the hydrogens a chemist leaves implicit. It is embedded in 3D by
 * RDKit (`embed.ts`: ETKDG conformer generation, the implicit hydrogens
 * added, then an MMFF94s / UFF minimisation), and the mol block RDKit
 * returns is parsed by the same MOL parser every host uses and centred.
 * RDKit is the only source of 3D geometry for a sketch; nothing is placed by
 * hand. A file the user imports is kept as it is (a flat 2D file is only
 * rescaled to Å and marked so).
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
import { embedSketch, type EmbedSketchOptions } from "./embed";
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

export interface MolfileDraftOptions {
  /** Add the hydrogens the sketch leaves implicit before embedding (default true). */
  addHydrogens?: boolean;
  /** Force field for the RDKit minimisation; see `EmbedSketchOptions`. */
  forceField?: EmbedSketchOptions["forceField"];
  /** The embedding function, replaceable for tests. */
  embed?: typeof embedSketch;
}

/**
 * Embed a molfile (Ketcher's output, or pasted text) in 3D with RDKit and
 * parse the result into a draft. The hydrogens the sketch leaves implicit
 * are added unless `addHydrogens` is false. The molfile itself is kept as
 * drawn so the sketch can be re-edited.
 */
export async function draftFromMolfile(
  molfile: string,
  name: string,
  { addHydrogens = true, forceField, embed = embedSketch }: MolfileDraftOptions = {},
): Promise<LibraryMoleculeDraft> {
  if (!molfile.trim()) throw new Error("The sketch is empty.");
  const embedded = await embed(molfile, { addHydrogens, forceField });
  const parsed = await parseStructureText(embedded.molblock, "sketch.mol");
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
