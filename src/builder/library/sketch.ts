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

/** Which step of turning a sketch into a molecule failed; see `sketchErrorMessage`. */
export type SketchStage = "empty" | "embed" | "parse";

/** A failure of `draftFromMolfile`, tagged with the step that failed. */
export class SketchError extends Error {
  readonly stage: SketchStage;
  constructor(stage: SketchStage, message: string) {
    super(message);
    this.name = "SketchError";
    this.stage = stage;
  }
}

/** RDKit messages that mean it could not read the input, not that it could not embed it. */
const UNREADABLE = /pars|mol ?block|smiles|could not read|invalid/i;

/**
 * What the sketch dialog says for a failure: only a real embedding failure is
 * blamed on the 3D embedding; an empty sketch, a molfile RDKit cannot read,
 * and a result that does not parse each get their own wording.
 */
export function sketchErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof SketchError)) return message;
  switch (err.stage) {
    case "empty":
      return "The sketch is empty: draw a molecule (or paste a MOL file) first.";
    case "parse":
      return `Could not read the 3D structure RDKit returned: ${message}`;
    case "embed":
      return UNREADABLE.test(message)
        ? `RDKit could not read the molecule: ${message}`
        : `RDKit could not embed the sketch in 3D: ${message}`;
  }
}

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
  if (!molfile.trim()) throw new SketchError("empty", "The sketch is empty.");
  let molblock: string;
  try {
    molblock = (await embed(molfile, { addHydrogens, forceField })).molblock;
  } catch (err) {
    throw new SketchError("embed", err instanceof Error ? err.message : String(err));
  }
  let draft: LibraryMoleculeDraft;
  try {
    const parsed = await parseStructureText(molblock, "sketch.mol");
    draft = draftFromSnapshot(parsed.snapshot, name, "sketch");
  } catch (err) {
    throw new SketchError("parse", err instanceof Error ? err.message : String(err));
  }
  draft.molfile = molfile;
  return draft;
}

/** Parse a structure file the user picked into a draft named after the file. */
export async function draftFromFile(file: File, name?: string): Promise<LibraryMoleculeDraft> {
  const parsed = await parseStructureFile(file);
  const base = file.name.replace(/\.[^.]+$/, "");
  return draftFromSnapshot(parsed.snapshot, name ?? base, "file");
}
