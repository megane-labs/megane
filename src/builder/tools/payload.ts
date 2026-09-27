/**
 * Conversions between Builder data and the contract's wire payloads:
 * a result `Structure` → a `Snapshot` (new document) or an `add_fragment` op
 * (insert), the open document → a `Structure` argument, and a library
 * molecule → the V2000 mol block a `molecule` argument carries (§4.2, §5).
 */

import { getElementSymbol } from "../../constants";
import type { EditOp } from "../../pipeline/types";
import type { Snapshot } from "../../types";
import type { LibraryMolecule } from "../library/types";
import type { StructurePayload } from "./contract";

/** Residue labels in the writers' `RESNAME<resid>` form, or null when the result has none. */
export function residueLabels(structure: StructurePayload): string[] | null {
  const names = structure.residueNames;
  if (!names) return null;
  const ids = structure.residueIds;
  return names.map((name, i) => (ids ? `${name}${ids[i]}` : name));
}

/** A new-document Snapshot for a result. Every bond is asserted by the tool (§5.1). */
export function structureToSnapshot(structure: StructurePayload): Snapshot {
  const n = structure.elements.length;
  const nBonds = structure.bonds.length;
  const bonds = new Uint32Array(nBonds * 2);
  structure.bonds.forEach(([i, j], k) => {
    bonds[2 * k] = i;
    bonds[2 * k + 1] = j;
  });
  return {
    nAtoms: n,
    nBonds,
    nFileBonds: nBonds,
    positions: new Float32Array(structure.positions),
    elements: new Uint8Array(structure.elements),
    bonds,
    bondOrders: structure.bondOrders ? new Uint8Array(structure.bondOrders) : null,
    box: structure.cell ? new Float32Array(structure.cell) : null,
    boxOrigin: null,
    atomChainIds: structure.chainIds
      ? new Uint8Array(structure.chainIds.map((c) => c.charCodeAt(0)))
      : null,
    atomBFactors: null,
  };
}

/** The shown structure as a `document` argument (§4.3). */
export function snapshotToStructure(snapshot: Snapshot): StructurePayload {
  const bonds: [number, number][] = [];
  for (let k = 0; k < snapshot.nBonds; k++) {
    bonds.push([snapshot.bonds[2 * k], snapshot.bonds[2 * k + 1]]);
  }
  const out: StructurePayload = {
    elements: Array.from(snapshot.elements),
    positions: Array.from(snapshot.positions, (v) => Math.round(v * 1e5) / 1e5),
    cell: snapshot.box ? Array.from(snapshot.box, (v) => Math.round(v * 1e5) / 1e5) : null,
    bonds,
  };
  if (snapshot.bondOrders && snapshot.bondOrders.some((o) => o !== 1)) {
    out.bondOrders = Array.from(snapshot.bondOrders);
  }
  return out;
}

const pad = (s: string | number, width: number) => String(s).padStart(width);

/**
 * A V2000 mol block for a library molecule. The header's dimension code says
 * `3D`, or `2D` for a planar (imported 2D) molecule, so the server never has
 * to guess from the coordinates (§4.2).
 */
export function moleculeToMolblock(molecule: LibraryMolecule): string {
  const n = molecule.elements.length;
  const lines = [
    molecule.name.replace(/[\r\n]+/g, " ").slice(0, 80),
    `  megane  0000000000${molecule.planar ? "2D" : "3D"}`,
    "",
    `${pad(n, 3)}${pad(molecule.bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`,
  ];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [0, 1, 2].map((k) => molecule.positions[3 * i + k].toFixed(4));
    const symbol = getElementSymbol(molecule.elements[i]).padEnd(3);
    lines.push(
      `${pad(x, 10)}${pad(y, 10)}${pad(z, 10)} ${symbol} 0  0  0  0  0  0  0  0  0  0  0  0`,
    );
  }
  molecule.bonds.forEach(([i, j], k) => {
    lines.push(`${pad(i + 1, 3)}${pad(j + 1, 3)}${pad(molecule.bondOrders?.[k] ?? 1, 3)}  0`);
  });
  lines.push("M  END");
  return lines.join("\n") + "\n";
}

/** The `molecule` argument for a library molecule. */
export function moleculeArgument(molecule: LibraryMolecule): { name: string; molblock: string } {
  return { name: molecule.name, molblock: moleculeToMolblock(molecule) };
}

function sameCell(a: ArrayLike<number> | null, b: number[] | null): boolean {
  if (!a || !b) return a === null && b === null;
  for (let k = 0; k < 9; k++) if (Math.abs(a[k] - b[k]) > 1e-4) return false;
  return true;
}

/**
 * The ops an `insert` result becomes (§5.2): one `add_fragment` with the
 * result's absolute positions, preceded by a `set_cell` (without atom scaling)
 * when the result's cell differs from the document's.
 */
export function insertOps(
  structure: StructurePayload,
  fragmentId: string,
  documentCell: ArrayLike<number> | null,
): EditOp[] {
  const ops: EditOp[] = [];
  if (structure.cell && !sameCell(documentCell, structure.cell)) {
    ops.push({ op: "set_cell", box: [...structure.cell], scaleAtoms: false });
  }
  const fragment: Extract<EditOp, { op: "add_fragment" }> = {
    op: "add_fragment",
    id: fragmentId,
    elements: [...structure.elements],
    positions: [...structure.positions],
    bonds: structure.bonds.map(([i, j]) => [i, j] as [number, number]),
  };
  if (structure.bondOrders) fragment.bondOrders = [...structure.bondOrders];
  ops.push(fragment);
  return ops;
}
