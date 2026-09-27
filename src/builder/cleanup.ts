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
 */

import type { StoreApi } from "zustand";
import { getElementSymbol } from "../constants";
import type { Snapshot } from "../types";
import { embedSketch, type EmbeddedSketch, type EmbedSketchOptions } from "./library/embed";
import { canEdit, shownSnapshot, type BuilderStore } from "./store";
import { molecules, superpose, type Displacements } from "./geometry";

/** V2000 holds at most 999 atoms; larger molecules are skipped. */
export const MAX_CLEANUP_ATOMS = 999;

type Embed = (molfile: string, options?: EmbedSketchOptions) => Promise<EmbeddedSketch>;

const pad = (v: string | number, n: number) => String(v).padStart(n);

/** The atoms `atoms` of `snapshot` (in that order) and the bonds among them, as a V2000 mol block. */
export function moleculeMolblock(snapshot: Snapshot, atoms: number[]): string {
  const local = new Map(atoms.map((a, k) => [a, k + 1]));
  const bonds: string[] = [];
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = local.get(snapshot.bonds[b * 2]);
    const j = local.get(snapshot.bonds[b * 2 + 1]);
    if (i === undefined || j === undefined) continue;
    const order = snapshot.bondOrders ? snapshot.bondOrders[b] : 1;
    const type = order >= 1 && order <= 4 ? order : 1;
    bonds.push(`${pad(i, 3)}${pad(j, 3)}${pad(type, 3)}  0`);
  }
  const lines = [
    "",
    "  megane-builder",
    "",
    `${pad(atoms.length, 3)}${pad(bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`,
  ];
  for (const a of atoms) {
    const [x, y, z] = [0, 1, 2].map((k) => snapshot.positions[a * 3 + k].toFixed(4));
    const sym = getElementSymbol(snapshot.elements[a]).padEnd(3);
    lines.push(`${pad(x, 10)}${pad(y, 10)}${pad(z, 10)} ${sym} 0  0  0  0  0  0  0  0  0  0  0  0`);
  }
  lines.push(...bonds, "M  END");
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
  /** Sum of the final force-field energies, kcal/mol (null when none reported). */
  energy: number | null;
  forceField: string | null;
}

/**
 * Clean up every molecule that contains one of `atoms` (every molecule when
 * `atoms` is empty). Rejects with RDKit's message when a molecule cannot be
 * embedded; nothing is changed then.
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
  let energy: number | null = null;
  let forceField: string | null = null;
  for (const mol of chosen) {
    if (mol.length < 2 || mol.length > MAX_CLEANUP_ATOMS) {
      skipped++;
      continue;
    }
    const result = await embed(moleculeMolblock(snapshot, mol), { addHydrogens: false });
    const embedded = molblockPositions(result.molblock, mol.length);
    const original = new Float64Array(mol.length * 3);
    mol.forEach((a, k) => {
      for (let c = 0; c < 3; c++) original[k * 3 + c] = snapshot.positions[a * 3 + c];
    });
    const placed = superpose(embedded, original);
    mol.forEach((a, k) => {
      displacements.set(
        a,
        [0, 1, 2].map((c) => placed[k * 3 + c] - original[k * 3 + c]) as [number, number, number],
      );
    });
    cleaned++;
    if (result.energy !== null) energy = (energy ?? 0) + result.energy;
    forceField = result.forceField;
  }
  return { displacements, cleaned, skipped, energy, forceField };
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
  let result: CleanupResult;
  try {
    result = await cleanUpMolecules(shown, s.selected, embed);
  } catch (err) {
    api
      .getState()
      .reportError(
        `Could not clean up the geometry: ${err instanceof Error ? err.message : String(err)}`,
      );
    return;
  }
  const now = api.getState();
  // The document changed while RDKit worked: the result no longer fits it.
  if (now.revision !== revision) {
    now.reportError("The structure changed while RDKit was working; nothing was moved.");
    return;
  }
  if (result.cleaned === 0) {
    now.reportError("Nothing to clean up: select a molecule of 2 to 999 bonded atoms.");
    return;
  }
  now.moveAtoms(result.displacements);
  const mols = `${result.cleaned} molecule${result.cleaned === 1 ? "" : "s"}`;
  const skipped =
    result.skipped > 0 ? `; ${result.skipped} skipped (single atoms or too large)` : "";
  const energy =
    result.energy !== null ? ` (${result.forceField}, ${result.energy.toFixed(2)} kcal/mol)` : "";
  now.reportInfo(`Cleaned up ${mols}${energy}${skipped}.`);
}
