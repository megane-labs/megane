/**
 * Ready-made flows for the Flow rail's Templates menu, as the viewer's
 * pipeline editor has ready-made pipelines: a liquid mixture, molecules on a
 * slab, polymer chains in a box, a solid–liquid interface, a crystal supercell.
 * Applying one replaces the flow; the user then edits the blocks and runs.
 *
 * The crystal, slab, polymer and placement blocks run in the browser. A
 * template that packs a box or solvates names a tool of the reference tool
 * server (`liquid_box`, `solvate`, see docs/docs/dev/builder-tools.md §12)
 * by name, with only the settings it means to change: the block fills in the
 * tool's other defaults once a server offering it is connected
 * (`FlowStore.completeTools`), and asks for one until then.
 */

import type { SerializedFlow } from "./store";
import type { CrystalParams, FlowParams, ToolParams } from "./types";
import { defaultBuiltinParams } from "./builtins";

export interface FlowTemplate {
  id: string;
  label: string;
  description: string;
  /** Tool-server tools the template's blocks call; empty when it runs in the browser alone. */
  tools: string[];
  create: () => SerializedFlow;
}

/** Fixed seed of the templates' stochastic tools, so a template builds the same box twice. */
export const TEMPLATE_SEED = 2026;

/** Horizontal and vertical spacing of a template's blocks. */
const DX = 300;
const DY = 150;

type Block = [id: string, col: number, rowIndex: number, params: FlowParams];

function flow(blocks: Block[], edges: [string, string, string][]): SerializedFlow {
  return {
    version: 1,
    nodes: blocks.map(([id, col, r, params]) => ({
      id,
      position: { x: 40 + col * DX, y: 40 + r * DY },
      params,
    })),
    edges: edges.map(([source, target, targetHandle]) => ({ source, target, targetHandle })),
  };
}

function library(libraryId: string, name: string): FlowParams {
  return { type: "molecule", source: "library", smiles: "", libraryId, name };
}

function tool(
  name: string,
  label: string,
  values: ToolParams["values"],
  rows: ToolParams["rows"] = {},
): ToolParams {
  return { type: "tool", tool: name, label, values: { ...values, seed: TEMPLATE_SEED }, rows };
}

function crystal(name: "Pt" | "Au" | "NaCl"): FlowParams {
  const base = defaultBuiltinParams("crystal") as CrystalParams;
  switch (name) {
    case "Pt":
      return { ...base, elements: ["Pt", "", ""], a: 3.92 };
    case "Au":
      return { ...base, elements: ["Au", "", ""], a: 4.08 };
    case "NaCl":
      return { ...base, structure: "rocksalt", elements: ["Na", "Cl", ""], a: 5.64 };
  }
}

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [
  {
    id: "liquid-mixture",
    label: "Liquid mixture",
    description: "Water and ethanol packed into a periodic box at liquid density (packmol).",
    tools: ["liquid_box"],
    create: () =>
      flow(
        [
          ["n1", 0, 0, library("preset:water", "WAT")],
          ["n2", 1, 0, library("preset:ethanol", "ETOH")],
          [
            "n3",
            0.5,
            1,
            tool(
              "liquid_box",
              "Liquid box",
              { density: 0.95 },
              { components: { n1: { count: 300 }, n2: { count: 30 } } },
            ),
          ],
        ],
        [
          ["n1", "n3", "components"],
          ["n2", "n3", "components"],
        ],
      ),
  },
  {
    id: "slab-adsorbates",
    label: "Molecules on a slab",
    description: "A Pt(111) slab cut from bulk fcc Pt with a 3 × 3 layer of water on top.",
    tools: [],
    create: () =>
      flow(
        [
          ["n1", 0, 0, crystal("Pt")],
          ["n2", 0, 1, { type: "slab", miller: [1, 1, 1], layers: 4, vacuum: 10, repeat: [2, 2] }],
          ["n3", 1, 1, library("preset:water", "WAT")],
          ["n4", 0.5, 2, { type: "adsorb", height: 2.2, grid: [3, 3] }],
        ],
        [
          ["n1", "n2", "bulk"],
          ["n2", "n4", "surface"],
          ["n3", "n4", "molecule"],
        ],
      ),
  },
  {
    id: "polymer-melt",
    label: "Polymer chains in a box",
    description:
      "Short polyethylene chains built from a repeat unit, packed loosely into a box (packmol).",
    tools: ["liquid_box"],
    // packmol moves each chain as one rigid conformer, so chains cannot be
    // packed to melt density (~0.85 g/cm³): 20-unit chains at 0.85 stop at the
    // iteration limit with atoms 0.15 Å apart after over two minutes. Short
    // chains in a dilute box pack in well under a second, and the box edge
    // (36 Å) is longer than a fully extended C20 chain (~25 Å), whatever
    // conformer RDKit embeds. Compress the box with MD to reach a real melt.
    create: () =>
      flow(
        [
          ["n1", 0, 0, { type: "polymer", repeatUnit: "*CC*", length: 10, name: "PE" }],
          [
            "n2",
            0,
            1,
            tool(
              "liquid_box",
              "Liquid box",
              { density: 0.1 },
              { components: { n1: { count: 10 } } },
            ),
          ],
        ],
        [["n1", "n2", "components"]],
      ),
  },
  {
    id: "solid-liquid",
    label: "Water on a slab",
    description:
      "An Au(100) slab with its vacuum filled with water: a solid–liquid interface (packmol).",
    tools: ["solvate"],
    create: () =>
      flow(
        [
          ["n1", 0, 0, crystal("Au")],
          ["n2", 0, 1, { type: "slab", miller: [1, 0, 0], layers: 3, vacuum: 8, repeat: [3, 3] }],
          ["n3", 1, 1, library("preset:water", "WAT")],
          ["n4", 0.5, 2, tool("solvate", "Solvate", { density: 1.0 })],
        ],
        [
          ["n1", "n2", "bulk"],
          ["n2", "n4", "document"],
          ["n3", "n4", "solvent"],
        ],
      ),
  },
  {
    id: "crystal-supercell",
    label: "Crystal supercell",
    description: "Rocksalt NaCl repeated 3 × 3 × 3.",
    tools: [],
    create: () =>
      flow(
        [
          ["n1", 0, 0, crystal("NaCl")],
          ["n2", 0, 1, { type: "supercell", repeat: [3, 3, 3] }],
        ],
        [["n1", "n2", "structure"]],
      ),
  },
];
