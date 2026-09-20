/**
 * Turning what the user drew, opened or selected into a library molecule.
 *
 * A Ketcher sketch arrives as a molfile: flat, unit bond lengths, and
 * without the hydrogens a chemist leaves implicit. By default it is embedded
 * in 3D by RDKit (`embed.ts`: ETKDG conformer generation, the implicit
 * hydrogens added, then an MMFF94s / UFF minimisation) and the resulting mol
 * block is parsed by the same MOL parser every host uses and centred. With
 * embedding off — or as the fallback when RDKit cannot run — the sketch is
 * parsed as drawn, rescaled to Å (bond lengths from covalent radii),
 * completed with the hydrogens its valences call for (see `hydrogens.ts`;
 * the user can turn this off) and centred; the heavy-atom skeleton then stays
 * planar until the user moves it, and only the added hydrogens leave the
 * drawing plane.
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
import { embedSketch, type EmbedSketchOptions } from "./embed";
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

export interface MolfileDraftOptions {
  /** Add the hydrogens the sketch leaves implicit (default true). */
  addHydrogens?: boolean;
  /**
   * Embed the sketch in 3D with RDKit (default false; the dialog turns it
   * on). Off, the sketch is kept flat and its hydrogens placed by valence.
   */
  embed3D?: boolean;
  /** Force field for the RDKit minimisation; see `EmbedSketchOptions`. */
  forceField?: EmbedSketchOptions["forceField"];
  /** The embedding function, replaceable for tests. */
  embed?: typeof embedSketch;
}

/**
 * Parse a molfile (Ketcher's output, or pasted text) into a draft. With
 * `embed3D` the molecule is first embedded in 3D by RDKit, hydrogens
 * included unless `addHydrogens` is false; otherwise it is read as drawn and
 * the hydrogens the sketch leaves implicit are added by valence. The molfile
 * itself is kept as drawn so the sketch can be re-edited.
 */
export async function draftFromMolfile(
  molfile: string,
  name: string,
  {
    addHydrogens: withHydrogens = true,
    embed3D = false,
    forceField,
    embed = embedSketch,
  }: MolfileDraftOptions = {},
): Promise<LibraryMoleculeDraft> {
  const text = molfile.trim();
  if (!text) throw new Error("The sketch is empty.");
  let draft: LibraryMoleculeDraft;
  if (embed3D) {
    const embedded = await embed(molfile, { addHydrogens: withHydrogens, forceField });
    const parsed = await parseStructureText(embedded.molblock, "sketch.mol");
    // RDKit already added the hydrogens (or was told not to); the geometry
    // is 3D, so the flat-sketch rescaling and valence hydrogens do not apply.
    draft = draftFromSnapshot(parsed.snapshot, name, "sketch");
  } else {
    const parsed = await parseStructureText(molfile, "sketch.mol");
    draft = draftFromSnapshot(parsed.snapshot, name, "sketch", undefined, {
      addHydrogens: withHydrogens,
      formalCharges: formalChargesOf(parsed),
    });
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
