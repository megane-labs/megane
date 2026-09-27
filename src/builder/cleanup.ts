/**
 * "Clean up geometry": let RDKit re-embed each chosen molecule (ETKDG, then
 * an MMFF94s minimisation, UFF where MMFF has no parameters) and put the
 * result back where the molecule was.
 *
 * `megane-rdkit` exposes embedding, not minimisation from given coordinates,
 * so each bonded molecule goes to it as a V2000 mol block of its own atoms
 * and bonds with hydrogens as they are (`addHs` off keeps RDKit's atom order
 * equal to ours), and the conformer that comes back is rigidly superposed on
 * the original atoms (`superpose`) so the molecule stays in place. The new
 * positions are written as `move_atoms` ops, one Undo step for the lot.
 *
 * Two things RDKit would otherwise trip over are handled on the way in: a
 * molecule split across a periodic cell is made whole first
 * (`unwrappedPositions`), and an atom with more bonds than its neutral valence
 * allows (an ammonium N, an oxonium O, a borate B) is given the formal charge
 * that explains it (`inferredCharges`). A molecule RDKit still rejects is
 * left as it is and counted; the others are cleaned up.
 */

import type { StoreApi } from "zustand";
import { getElementSymbol } from "../constants";
import type { Snapshot } from "../types";
import { embedSketch, type EmbeddedSketch, type EmbedSketchOptions } from "./library/embed";
import { canEdit, shownSnapshot, type BuilderStore } from "./store";
import { molecules, superpose, unwrappedPositions, type Displacements } from "./geometry";

/** V2000 holds at most 999 atoms; larger molecules are skipped. */
export const MAX_CLEANUP_ATOMS = 999;

type Embed = (molfile: string, options?: EmbedSketchOptions) => Promise<EmbeddedSketch>;

const pad = (v: string | number, n: number) => String(v).padStart(n);

/** V2000 bond type per bond among `atoms` (local 0-based ends), bond order 1–4 as given, else single. */
function localBonds(snapshot: Snapshot, atoms: number[]): [number, number, number][] {
  const local = new Map(atoms.map((a, k) => [a, k]));
  const out: [number, number, number][] = [];
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = local.get(snapshot.bonds[b * 2]);
    const j = local.get(snapshot.bonds[b * 2 + 1]);
    if (i === undefined || j === undefined) continue;
    const order = snapshot.bondOrders ? snapshot.bondOrders[b] : 1;
    out.push([i, j, order >= 1 && order <= 4 ? order : 1]);
  }
  return out;
}

/**
 * The charge that makes an over-bonded atom's valence legal: four bonds on N
 * or P, three on O or S make a cation; four on B an anion. Atoms with an
 * aromatic bond are left alone (their valence is RDKit's to work out), and so
 * is every atom whose bonds fit its neutral valence — RDKit fills those up with
 * implicit hydrogens. Keyed by position in `atoms`.
 */
export function inferredCharges(snapshot: Snapshot, atoms: number[]): Map<number, number> {
  const valence = new Array<number>(atoms.length).fill(0);
  const aromatic = new Uint8Array(atoms.length);
  for (const [i, j, type] of localBonds(snapshot, atoms)) {
    for (const k of [i, j]) {
      if (type === 4) aromatic[k] = 1;
      else valence[k] += type;
    }
  }
  const charges = new Map<number, number>();
  atoms.forEach((a, k) => {
    if (aromatic[k]) return;
    const z = snapshot.elements[a];
    const v = valence[k];
    if ((z === 7 || z === 15) && v === 4) charges.set(k, 1);
    else if ((z === 8 || z === 16) && v === 3) charges.set(k, 1);
    else if (z === 5 && v === 4) charges.set(k, -1);
  });
  return charges;
}

/**
 * The atoms `atoms` of `snapshot` (in that order) and the bonds among them, as
 * a V2000 mol block, with `positions` (flat xyz, same order) in place of the
 * snapshot's when given and `charges` (by position in `atoms`) as `M  CHG`.
 */
export function moleculeMolblock(
  snapshot: Snapshot,
  atoms: number[],
  positions?: ArrayLike<number>,
  charges: Map<number, number> = new Map(),
): string {
  const bonds = localBonds(snapshot, atoms).map(
    ([i, j, type]) => `${pad(i + 1, 3)}${pad(j + 1, 3)}${pad(type, 3)}  0`,
  );
  const lines = [
    "",
    "  megane-builder",
    "",
    `${pad(atoms.length, 3)}${pad(bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`,
  ];
  atoms.forEach((a, k) => {
    const [x, y, z] = [0, 1, 2].map((c) =>
      (positions ? positions[k * 3 + c] : snapshot.positions[a * 3 + c]).toFixed(4),
    );
    const sym = getElementSymbol(snapshot.elements[a]).padEnd(3);
    lines.push(`${pad(x, 10)}${pad(y, 10)}${pad(z, 10)} ${sym} 0  0  0  0  0  0  0  0  0  0  0  0`);
  });
  lines.push(...bonds);
  // At most eight charges per M  CHG line.
  const entries = [...charges];
  for (let i = 0; i < entries.length; i += 8) {
    const chunk = entries.slice(i, i + 8);
    lines.push(
      `M  CHG${pad(chunk.length, 3)}` +
        chunk.map(([k, q]) => `${pad(k + 1, 4)}${pad(q, 4)}`).join(""),
    );
  }
  lines.push("M  END");
  return lines.join("\n") + "\n";
}

/** The first `n` atom positions of a V2000 mol block, flat xyz. */
export function molblockPositions(molblock: string, n: number): Float64Array {
  const lines = molblock.split("\n");
  const counts = lines.findIndex((l) => l.includes("V2000"));
  if (counts < 0) throw new Error("RDKit returned no V2000 mol block.");
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const line = lines[counts + 1 + i] ?? "";
    for (let k = 0; k < 3; k++) {
      const v = Number(line.slice(k * 10, k * 10 + 10));
      if (!Number.isFinite(v)) throw new Error("RDKit returned an unreadable mol block.");
      out[i * 3 + k] = v;
    }
  }
  return out;
}

export interface CleanupResult {
  displacements: Displacements;
  /** Molecules cleaned up, and those skipped (a single atom, or too large). */
  cleaned: number;
  skipped: number;
  /** Molecules RDKit could not embed (left as they are), and its first message. */
  failed: number;
  error: string | null;
  /** Sum of the final force-field energies, kcal/mol (null when none reported). */
  energy: number | null;
  forceField: string | null;
}

/**
 * Clean up every molecule that contains one of `atoms` (every molecule when
 * `atoms` is empty). A molecule RDKit cannot embed is left out of
 * `displacements` and counted in `failed`.
 */
export async function cleanUpMolecules(
  snapshot: Snapshot,
  atoms: number[],
  embed: Embed = embedSketch,
): Promise<CleanupResult> {
  const wanted = new Set(atoms);
  const chosen = molecules(snapshot).filter(
    (m) => wanted.size === 0 || m.some((i) => wanted.has(i)),
  );
  const displacements: Displacements = new Map();
  let cleaned = 0;
  let skipped = 0;
  let failed = 0;
  let error: string | null = null;
  let energy: number | null = null;
  let forceField: string | null = null;
  for (const mol of chosen) {
    if (mol.length < 2 || mol.length > MAX_CLEANUP_ATOMS) {
      skipped++;
      continue;
    }
    // The superposition target is the molecule made whole, so a molecule
    // split across the cell comes back whole next to its first atom.
    const whole = unwrappedPositions(snapshot, mol);
    let embedded: Float64Array;
    let result: EmbeddedSketch;
    try {
      const molblock = moleculeMolblock(snapshot, mol, whole, inferredCharges(snapshot, mol));
      result = await embed(molblock, { addHydrogens: false });
      embedded = molblockPositions(result.molblock, mol.length);
    } catch (err) {
      failed++;
      error ??= err instanceof Error ? err.message : String(err);
      continue;
    }
    const placed = superpose(embedded, whole);
    mol.forEach((a, k) => {
      displacements.set(
        a,
        [0, 1, 2].map((c) => placed[k * 3 + c] - snapshot.positions[a * 3 + c]) as [
          number,
          number,
          number,
        ],
      );
    });
    cleaned++;
    if (result.energy !== null) energy = (energy ?? 0) + result.energy;
    forceField = result.forceField;
  }
  return { displacements, cleaned, skipped, failed, error, energy, forceField };
}

/**
 * Clean up the selected molecules (all of them when nothing is selected) and
 * write the result as one Undo step; reports progress and the outcome in the
 * notice line.
 */
export async function runCleanup(
  api: StoreApi<BuilderStore>,
  embed: Embed = embedSketch,
): Promise<void> {
  const s = api.getState();
  const shown = shownSnapshot(s);
  if (!canEdit(s) || !shown || shown.nAtoms === 0) return;
  const revision = s.revision;
  s.reportInfo("Cleaning up the geometry with RDKit…");
  const result = await cleanUpMolecules(shown, s.selected, embed);
  const now = api.getState();
  // The document changed while RDKit worked: the result no longer fits it.
  if (now.revision !== revision) {
    now.reportError("The structure changed while RDKit was working; nothing was moved.");
    return;
  }
  if (result.cleaned === 0) {
    now.reportError(
      result.error !== null
        ? `Could not clean up the geometry: ${result.error}`
        : "Nothing to clean up: select a molecule of 2 to 999 bonded atoms.",
    );
    return;
  }
  now.moveAtoms(result.displacements);
  const mols = `${result.cleaned} molecule${result.cleaned === 1 ? "" : "s"}`;
  const skipped =
    result.skipped > 0 ? `; ${result.skipped} skipped (single atoms or too large)` : "";
  const energy =
    result.energy !== null ? ` (${result.forceField}, ${result.energy.toFixed(2)} kcal/mol)` : "";
  if (result.failed > 0) {
    now.reportError(
      `Cleaned up ${mols}${energy}${skipped}; ${result.failed} left as they are (RDKit: ${result.error}).`,
    );
  } else {
    now.reportInfo(`Cleaned up ${mols}${energy}${skipped}.`);
  }
}
