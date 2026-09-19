/**
 * Turning what the user drew, opened or selected into a library molecule.
 *
 * A Ketcher sketch arrives as a molfile: flat, unit bond lengths, and
 * without the hydrogens a chemist leaves implicit. It is parsed by the same
 * MOL parser every host uses, rescaled to Å (bond lengths from covalent
 * radii), completed with the hydrogens its valences call for (see
 * `hydrogens.ts`; the user can turn this off) and centred. The heavy-atom
 * skeleton is exactly what the user drew and stays planar until they move
 * it; only the added hydrogens leave the drawing plane.
 */

import { parseStructureFile, parseStructureText } from "../../parsers/structure";
import type { StructureParseResult } from "../../parsers/structure";
import type { Snapshot } from "../../types";
import {
  centered,
  formulaOf,
  geometryFromSnapshot,
  isPlanar,
  scaleBondsToCovalent,
} from "./fragment";
import { addHydrogens } from "./hydrogens";
import type { LibraryMoleculeDraft, LibraryOrigin } from "./types";

export interface DraftOptions {
  /** Add the hydrogens the valences call for (a sketch's implicit hydrogens). Off by default. */
  addHydrogens?: boolean;
  /** Formal charge per snapshot atom, consulted by the hydrogen addition. */
  formalCharges?: ArrayLike<number> | null;
}

/** The `formal_charge` scalar channel of a parsed structure, if the file carried one. */
export function formalChargesOf(parsed: StructureParseResult): Float32Array | null {
  const channel = parsed.scalarChannels.find((c) => c.name === "formal_charge");
  return channel?.frames[0]?.values ?? null;
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
  options: DraftOptions = {},
): LibraryMoleculeDraft {
  const raw = geometryFromSnapshot(snapshot, indices);
  if (raw.elements.length === 0) throw new Error("The molecule has no atoms.");
  const planar = isPlanar(raw.positions);
  let geometry = planar ? scaleBondsToCovalent(raw) : raw;
  if (options.addHydrogens) {
    const atoms = indices
      ? [...new Set(indices)].sort((a, b) => a - b)
      : Array.from({ length: snapshot.nAtoms }, (_, i) => i);
    const source = options.formalCharges;
    const charges = source ? atoms.map((a) => source[a] ?? 0) : null;
    geometry = addHydrogens(geometry, {
      charges,
      planeNormal: planar ? [0, 0, 1] : null,
    }).geometry;
  }
  geometry = centered(geometry);
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

/**
 * Parse a molfile (Ketcher's output, or pasted text) into a draft. The
 * hydrogens the sketch leaves implicit are added unless `addHydrogens` is
 * false; the molfile itself is kept as drawn so the sketch can be re-edited.
 */
export async function draftFromMolfile(
  molfile: string,
  name: string,
  { addHydrogens: withHydrogens = true }: { addHydrogens?: boolean } = {},
): Promise<LibraryMoleculeDraft> {
  const text = molfile.trim();
  if (!text) throw new Error("The sketch is empty.");
  const parsed = await parseStructureText(molfile, "sketch.mol");
  const draft = draftFromSnapshot(parsed.snapshot, name, "sketch", undefined, {
    addHydrogens: withHydrogens,
    formalCharges: formalChargesOf(parsed),
  });
  draft.molfile = molfile;
  return draft;
}

/** Parse a structure file the user picked into a draft named after the file. */
export async function draftFromFile(file: File, name?: string): Promise<LibraryMoleculeDraft> {
  const parsed = await parseStructureFile(file);
  const base = file.name.replace(/\.[^.]+$/, "");
  return draftFromSnapshot(parsed.snapshot, name ?? base, "file");
}
