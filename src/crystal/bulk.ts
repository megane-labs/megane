/**
 * Bulk crystal generator: the common prototype structures from a lattice
 * constant and one to three elements — the Builder's "New bulk crystal".
 * Atom positions and cells reproduce ASE's `ase.build.bulk` (primitive cells
 * by default, `cubic` for the conventional cell where one exists) so the
 * ASE-generated fixtures under `tests/fixtures/crystal/` pin them; perovskite
 * is the one prototype ASE does not ship and is defined here.
 */

import { ELEMENT_SYMBOLS, getElementSymbol } from "../constants";
import type { Snapshot } from "../types";
import { type Mat3, fracToCart } from "./cell";

export type BulkStructure =
  | "sc"
  | "fcc"
  | "bcc"
  | "hcp"
  | "diamond"
  | "zincblende"
  | "rocksalt"
  | "cesiumchloride"
  | "fluorite"
  | "wurtzite"
  | "perovskite";

export interface BulkStructureInfo {
  value: BulkStructure;
  label: string;
  /** How many element slots the prototype takes (A, AB, ABX). */
  species: 1 | 2 | 3;
  /** Whether a conventional cubic cell can be asked for. */
  cubic: boolean;
  /** Whether the prototype has an independent c axis. */
  hexagonal: boolean;
}

export const BULK_STRUCTURES: readonly BulkStructureInfo[] = [
  { value: "sc", label: "Simple cubic", species: 1, cubic: false, hexagonal: false },
  { value: "fcc", label: "FCC", species: 1, cubic: true, hexagonal: false },
  { value: "bcc", label: "BCC", species: 1, cubic: true, hexagonal: false },
  { value: "hcp", label: "HCP", species: 1, cubic: false, hexagonal: true },
  { value: "diamond", label: "Diamond", species: 1, cubic: true, hexagonal: false },
  { value: "zincblende", label: "Zincblende (AB)", species: 2, cubic: true, hexagonal: false },
  { value: "rocksalt", label: "Rocksalt (AB)", species: 2, cubic: true, hexagonal: false },
  { value: "cesiumchloride", label: "CsCl (AB)", species: 2, cubic: false, hexagonal: false },
  { value: "fluorite", label: "Fluorite (AB₂)", species: 2, cubic: true, hexagonal: false },
  { value: "wurtzite", label: "Wurtzite (AB)", species: 2, cubic: false, hexagonal: true },
  { value: "perovskite", label: "Perovskite (ABX₃)", species: 3, cubic: false, hexagonal: false },
];

export interface BulkSpec {
  structure: BulkStructure;
  /** Atomic numbers of the A, B (and X) species; extra entries are ignored. */
  elements: number[];
  /** Lattice constant a, Å. */
  a: number;
  /** c/a for hcp / wurtzite; the ideal √(8/3) when omitted. */
  covera?: number;
  /** Conventional cubic cell instead of the primitive one, where it exists. */
  cubic?: boolean;
}

/** Reference lattice constants (ASE `ase.data.reference_states`) for the examples list. */
export interface BulkExample {
  name: string;
  spec: BulkSpec;
}

const IDEAL_COVERA = Math.sqrt(8 / 3);

function z(symbol: string): number {
  const found = Object.entries(ELEMENT_SYMBOLS).find(([, s]) => s === symbol);
  if (!found) throw new Error(`unknown element ${symbol}`);
  return Number(found[0]);
}

/** Atomic number for an element symbol (case-insensitive), or null. */
export function elementFromSymbol(symbol: string): number | null {
  const s = symbol.trim();
  if (!s) return null;
  const want = s[0].toUpperCase() + s.slice(1).toLowerCase();
  const found = Object.entries(ELEMENT_SYMBOLS).find(([, sym]) => sym === want);
  return found ? Number(found[0]) : null;
}

export const BULK_EXAMPLES: readonly BulkExample[] = [
  { name: "Cu (fcc)", spec: { structure: "fcc", elements: [z("Cu")], a: 3.61, cubic: true } },
  { name: "Al (fcc)", spec: { structure: "fcc", elements: [z("Al")], a: 4.05, cubic: true } },
  { name: "Au (fcc)", spec: { structure: "fcc", elements: [z("Au")], a: 4.08, cubic: true } },
  { name: "Pt (fcc)", spec: { structure: "fcc", elements: [z("Pt")], a: 3.92, cubic: true } },
  { name: "Fe (bcc)", spec: { structure: "bcc", elements: [z("Fe")], a: 2.87, cubic: true } },
  { name: "W (bcc)", spec: { structure: "bcc", elements: [z("W")], a: 3.16, cubic: true } },
  { name: "Mg (hcp)", spec: { structure: "hcp", elements: [z("Mg")], a: 3.21, covera: 1.624 } },
  { name: "Ti (hcp)", spec: { structure: "hcp", elements: [z("Ti")], a: 2.95, covera: 1.588 } },
  {
    name: "Si (diamond)",
    spec: { structure: "diamond", elements: [z("Si")], a: 5.43, cubic: true },
  },
  { name: "C (diamond)", spec: { structure: "diamond", elements: [z("C")], a: 3.57, cubic: true } },
  {
    name: "NaCl (rocksalt)",
    spec: { structure: "rocksalt", elements: [z("Na"), z("Cl")], a: 5.64, cubic: true },
  },
  {
    name: "MgO (rocksalt)",
    spec: { structure: "rocksalt", elements: [z("Mg"), z("O")], a: 4.21, cubic: true },
  },
  {
    name: "GaAs (zincblende)",
    spec: { structure: "zincblende", elements: [z("Ga"), z("As")], a: 5.65, cubic: true },
  },
  {
    name: "CsCl",
    spec: { structure: "cesiumchloride", elements: [z("Cs"), z("Cl")], a: 4.12 },
  },
  {
    name: "CaF₂ (fluorite)",
    spec: { structure: "fluorite", elements: [z("Ca"), z("F")], a: 5.46, cubic: true },
  },
  {
    name: "ZnO (wurtzite)",
    spec: { structure: "wurtzite", elements: [z("Zn"), z("O")], a: 3.25, covera: 5.21 / 3.25 },
  },
  {
    name: "SrTiO₃ (perovskite)",
    spec: { structure: "perovskite", elements: [z("Sr"), z("Ti"), z("O")], a: 3.905 },
  },
];

interface Proto {
  cell: Mat3;
  /** Flat fractional coordinates. */
  frac: number[];
  /** Species slot (0 = A, 1 = B, 2 = X) of each atom. */
  slot: number[];
}

/** ASE's primitive fcc cell: rows (0,b,b), (b,0,b), (b,b,0). */
function fccPrimitive(a: number): Mat3 {
  const b = a / 2;
  return [0, b, b, b, 0, b, b, b, 0];
}

function hexCell(a: number, c: number): Mat3 {
  return [a, 0, 0, -a / 2, (Math.sqrt(3) / 2) * a, 0, 0, 0, c];
}

/**
 * Prototype in fractional coordinates. The fcc-derived primitives (diamond,
 * zincblende, rocksalt, fluorite) are the sum of fcc sublattices offset in
 * Cartesian space as ASE builds them, so their fractional coordinates are
 * computed from those offsets.
 */
function prototype(spec: BulkSpec): Proto {
  const { a } = spec;
  const covera = spec.covera ?? IDEAL_COVERA;
  const cubic = !!spec.cubic;
  switch (spec.structure) {
    case "sc":
      return { cell: [a, 0, 0, 0, a, 0, 0, 0, a], frac: [0, 0, 0], slot: [0] };
    case "fcc":
      return cubic
        ? {
            cell: [a, 0, 0, 0, a, 0, 0, 0, a],
            frac: [0, 0, 0, 0, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0],
            slot: [0, 0, 0, 0],
          }
        : { cell: fccPrimitive(a), frac: [0, 0, 0], slot: [0] };
    case "bcc": {
      const b = a / 2;
      return cubic
        ? { cell: [a, 0, 0, 0, a, 0, 0, 0, a], frac: [0, 0, 0, 0.5, 0.5, 0.5], slot: [0, 0] }
        : { cell: [-b, b, b, b, -b, b, b, b, -b], frac: [0, 0, 0], slot: [0] };
    }
    case "hcp":
      return {
        cell: hexCell(a, covera * a),
        frac: [0, 0, 0, 1 / 3, 2 / 3, 0.5],
        slot: [0, 0],
      };
    case "diamond":
    case "zincblende": {
      const slotB = spec.structure === "diamond" ? 0 : 1;
      if (cubic) {
        return {
          cell: [a, 0, 0, 0, a, 0, 0, 0, a],
          frac: [
            0, 0, 0, 0.25, 0.25, 0.25, 0, 0.5, 0.5, 0.25, 0.75, 0.75, 0.5, 0, 0.5, 0.75, 0.25, 0.75,
            0.5, 0.5, 0, 0.75, 0.75, 0.25,
          ],
          slot: [0, slotB, 0, slotB, 0, slotB, 0, slotB],
        };
      }
      // Second fcc sublattice at Cartesian (a/4, a/4, a/4) = fractional (¼, ¼, ¼).
      return { cell: fccPrimitive(a), frac: [0, 0, 0, 0.25, 0.25, 0.25], slot: [0, slotB] };
    }
    case "rocksalt":
      if (cubic) {
        return {
          cell: [a, 0, 0, 0, a, 0, 0, 0, a],
          frac: [
            0, 0, 0, 0.5, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0.5, 0, 0,
            0.5, 0,
          ],
          slot: [0, 1, 0, 1, 0, 1, 0, 1],
        };
      }
      // Second sublattice at Cartesian (a/2, 0, 0) = fractional (−½, ½, ½).
      return { cell: fccPrimitive(a), frac: [0, 0, 0, -0.5, 0.5, 0.5], slot: [0, 1] };
    case "cesiumchloride":
      return { cell: [a, 0, 0, 0, a, 0, 0, 0, a], frac: [0, 0, 0, 0.5, 0.5, 0.5], slot: [0, 1] };
    case "fluorite":
      if (cubic) {
        return {
          cell: [a, 0, 0, 0, a, 0, 0, 0, a],
          frac: [
            0, 0, 0, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75, 0, 0.5, 0.5, 0.25, 0.75, 0.75, 0.75, 0.25,
            0.25, 0.5, 0, 0.5, 0.75, 0.25, 0.75, 0.25, 0.75, 0.25, 0.5, 0.5, 0, 0.75, 0.75, 0.25,
            0.25, 0.25, 0.75,
          ],
          slot: [0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1],
        };
      }
      // Sublattices at Cartesian (a/4,a/4,a/4) and (3a/4,3a/4,3a/4).
      return {
        cell: fccPrimitive(a),
        frac: [0, 0, 0, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75],
        slot: [0, 1, 1],
      };
    case "wurtzite": {
      const u = 0.25 + 1 / 3 / (covera * covera);
      return {
        cell: hexCell(a, covera * a),
        frac: [0, 0, 0, 1 / 3, 2 / 3, 0.5 - u, 1 / 3, 2 / 3, 0.5, 0, 0, 1 - u],
        slot: [0, 1, 0, 1],
      };
    }
    case "perovskite":
      return {
        cell: [a, 0, 0, 0, a, 0, 0, 0, a],
        frac: [0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0.5],
        slot: [0, 1, 2, 2, 2],
      };
  }
}

/** Info row for a structure. */
export function bulkStructureInfo(structure: BulkStructure): BulkStructureInfo {
  return BULK_STRUCTURES.find((s) => s.value === structure)!;
}

/**
 * The bulk crystal `spec` describes, as a Snapshot with no bonds (a crystal
 * is drawn from its lattice; bonds are the viewer's Add Bond node's job).
 * Throws on a non-positive lattice constant or a missing species.
 */
export function bulkSnapshot(spec: BulkSpec): Snapshot {
  const info = bulkStructureInfo(spec.structure);
  if (!(spec.a > 0)) throw new Error("Lattice constant a must be positive");
  if (spec.covera !== undefined && !(spec.covera > 0)) throw new Error("c/a must be positive");
  for (let k = 0; k < info.species; k++) {
    const el = spec.elements[k];
    if (!Number.isInteger(el) || el < 1 || el > 118) {
      throw new Error(`Species ${"ABX"[k]} needs an element`);
    }
  }
  const proto = prototype(spec);
  const cart = fracToCart(proto.frac, proto.cell);
  const n = proto.slot.length;
  return {
    nAtoms: n,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(cart),
    elements: new Uint8Array(proto.slot.map((s) => spec.elements[s])),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: new Float32Array(proto.cell),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/** Document name for a bulk crystal, e.g. `NaCl-rocksalt`. */
export function bulkName(spec: BulkSpec): string {
  const info = bulkStructureInfo(spec.structure);
  const symbols = spec.elements.slice(0, info.species).map(getElementSymbol);
  return `${symbols.join("")}-${spec.structure}`;
}
