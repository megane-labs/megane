/**
 * Types of the Builder's Flow mode: a model built by connecting blocks.
 *
 * Manual mode edits one document by clicking in the 3D view. Flow mode
 * describes how a model is *made* instead: a molecule from a SMILES string
 * or the library, a bulk crystal cut into a slab with molecules laid on it,
 * a polymer chain (the built-in blocks, run in the browser), a tool-server
 * call (packmol's liquid box, solvation) fed by those, and so on, as a graph whose
 * wires carry structures. Running the graph evaluates each block once its
 * inputs are ready and makes the output block's result the Manual document,
 * so both modes work on one structure (`shared.ts`); the 3D view shows the
 * result of the block picked in the graph (else that structure), and *Open
 * in Manual* hands any block's result to Manual mode the same way.
 *
 * The graph is separate from the viewer's pipeline on purpose: the viewer's
 * graph describes how a loaded structure is *shown* and is re-evaluated
 * synchronously on every change, while a build step can take minutes (a
 * packmol run) and is only run on request, with its result cached by the
 * block's parameters and inputs (`engine.ts`).
 */

import type { BulkStructure } from "../../crystal/bulk";
import type { Snapshot } from "../../types";
import type { FormValues } from "../tools/form";

export type FlowMode = "manual" | "flow";

/** Every block type, in the order the Add menu lists them. */
export const FLOW_NODE_TYPES = [
  "molecule",
  "document",
  "crystal",
  "polymer",
  "supercell",
  "slab",
  "adsorb",
  "tool",
] as const;

export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

/** A molecule from a SMILES string (embedded in 3D by RDKit) or from the Builder library. */
export interface MoleculeParams {
  type: "molecule";
  source: "smiles" | "library";
  smiles: string;
  /** Library molecule id (`preset:<slug>` or `user:<id>`). */
  libraryId: string;
  /** Name given to the molecule (residue name in a packed box); blank uses the SMILES. */
  name: string;
}

/** The structure open in Manual mode, as it is when the flow runs. */
export interface DocumentParams {
  type: "document";
}

/** One tool of the connected tool server (Builder Tool Contract), called with its form. */
export interface ToolParams {
  type: "tool";
  /** The tool's `name` on the server. */
  tool: string;
  /** Its label when the block was made, for a block whose server is not connected. */
  label: string;
  /** Form values of the fields that are not inputs (§4.1). */
  values: FormValues;
  /**
   * Per-input row values of a table input (`components` of a liquid box):
   * port key → upstream block id → the row's other columns (the count).
   */
  rows: Record<string, Record<string, FormValues>>;
}

/** A bulk crystal from a prototype structure (`crystal/bulk.ts`), built in the browser. */
export interface CrystalParams {
  type: "crystal";
  structure: BulkStructure;
  /** Element symbols of the A, B and X species; only the prototype's species are read. */
  elements: string[];
  /** Lattice constant a, Å. */
  a: number;
  /** c/a of a hexagonal prototype. */
  covera: number;
  /** Conventional cubic cell instead of the primitive one, where it exists. */
  cubic: boolean;
}

/** A linear homopolymer: a repeat unit's SMILES with two `*` ends, repeated and embedded by RDKit. */
export interface PolymerParams {
  type: "polymer";
  /** Repeat unit, e.g. `*CC(c1ccccc1)*`: the first `*` is the head, the last the tail. */
  repeatUnit: string;
  /** Number of repeat units. */
  length: number;
  /** Name of the chain (residue name of the copies a tool makes); blank uses the repeat unit. */
  name: string;
}

/** The input structure repeated along its cell vectors. */
export interface SupercellParams {
  type: "supercell";
  repeat: [number, number, number];
}

/** A Miller-index slab cut from the input bulk crystal, repeated in plane. */
export interface SlabParams {
  type: "slab";
  miller: [number, number, number];
  /** Repeats of the surface unit cell along the normal. */
  layers: number;
  /** Vacuum on each side along the normal, Å; 0 keeps the slab periodic. */
  vacuum: number;
  /** Repeats of the surface cell along a and b. */
  repeat: [number, number];
}

/** Copies of a molecule laid on a grid above a surface. */
export interface AdsorbParams {
  type: "adsorb";
  /** Gap between the surface's top atom and each molecule's lowest atom, Å. */
  height: number;
  /** Copies along the surface cell's a and b vectors. */
  grid: [number, number];
}

export type FlowParams =
  | MoleculeParams
  | DocumentParams
  | ToolParams
  | CrystalParams
  | PolymerParams
  | SupercellParams
  | SlabParams
  | AdsorbParams;

/** What a wire carries: one structure, with a name and optional residue labels. */
export interface FlowData {
  name: string;
  snapshot: Snapshot;
  /** Per-atom `RESNAME<resid>` labels for PDB export, or null. */
  labels: string[] | null;
}

/**
 * - `idle`: never run.
 * - `stale`: ran, but the block or something upstream changed since.
 * - `running`, `done`, `error`: the last run.
 */
export type RunStatus = "idle" | "stale" | "running" | "done" | "error";

/** The state of one block's last run. */
export interface NodeRun {
  status: RunStatus;
  /** Cache key of the result (`nodeKey`): the block's params and its inputs' keys. */
  key: string | null;
  data: FlowData | null;
  error: string | null;
  warnings: string[];
  /** A one-line summary of the result (the tool's own text), or null. */
  summary: string | null;
  /** Progress of a running tool call, 0..1, or null when unknown. */
  fraction: number | null;
  message: string | null;
}

/** `data` of an xyflow node in the Flow graph. */
export interface FlowNodeData {
  params: FlowParams;
  [key: string]: unknown;
}

/** Name of every block's single output handle. */
export const OUTPUT_HANDLE = "out";

export const IDLE_RUN: NodeRun = {
  status: "idle",
  key: null,
  data: null,
  error: null,
  warnings: [],
  summary: null,
  fraction: null,
  message: null,
};
