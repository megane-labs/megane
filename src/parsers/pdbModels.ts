/**
 * Does a PDB file hold more than one model?
 *
 * Asked before a large PDB is sent down the lazy multi-frame path: a
 * single-model file has nothing to stream, and the path's frame-0 prefix and
 * background index would parse it up to three times (the prefix cannot prove
 * model 0 is complete without an ENDMDL, so it retries with the whole file).
 *
 * The format puts a MODEL record before each model's first ATOM/HETATM, so the
 * first of those records in the file answers the question from its head alone.
 *
 * Keep it dependency-free — it only reads text.
 */

/** How much of the file's head {@link pdbMayHaveModels} reads. */
export const PDB_MODEL_SNIFF_BYTES = 1024 * 1024;

// A MODEL record (as the Rust parser reads it: "MODEL" once trailing blanks are
// trimmed from columns 1-6), or the first coordinate record.
const FIRST_MODEL_OR_ATOM = /^(?:(MODEL)(?:\s|$)|ATOM {2}|HETATM)/m;

/**
 * True unless `head` proves the file is single-model: its first coordinate
 * record comes with no MODEL record before it. A head with no coordinate
 * record at all (a very long header) cannot rule models out, so it is true.
 */
export function pdbHeadMayHaveModels(head: string): boolean {
  const first = FIRST_MODEL_OR_ATOM.exec(head);
  return first === null || first[1] === "MODEL";
}

/** {@link pdbHeadMayHaveModels} over the first {@link PDB_MODEL_SNIFF_BYTES} of `file`. */
export async function pdbMayHaveModels(file: Blob): Promise<boolean> {
  return pdbHeadMayHaveModels(await file.slice(0, PDB_MODEL_SNIFF_BYTES).text());
}
