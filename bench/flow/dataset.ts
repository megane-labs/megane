/**
 * Benchmark dataset for the Builder's Flow assistant.
 *
 * Each case is a request, the Builder it is made in (tool server connected or
 * not, a structure open in Manual mode, a flow already in the graph) and a
 * rubric. The rubrics only reference blocks, settings and tools the Flow
 * system prompt documents, so a perfect answer scores 1.0 — `golden.ts` holds
 * one for every case, and `tests/ts/bench/flow-bench.test.ts` runs each and
 * fails if it does not, or if the case's wrong answers are not caught.
 *
 * The result checks are the point: they grade what the flow *builds* when
 * the production engine runs it (atoms of which elements, a unit cell, what
 * a tool call asked for), not only how the graph looks.
 */

import type { FlowParams } from "@/builder/flow/types";
import { FLOW_TEMPLATES } from "@/builder/flow/templates";
import {
  atomsIn,
  bondCount,
  called,
  cell,
  count,
  equalCounts,
  isFormula,
  moleculeArg,
  none,
  noOverlap,
  onlyElements,
  some,
} from "./checks";
import type { FlowBenchCase } from "./types";

const near = (value: unknown, lo: number, hi: number) =>
  typeof value === "number" && value >= lo && value <= hi;

const same = (value: unknown, expected: number[]) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((v, i) => v === expected[i]);

/** A crystal block of `structure` whose species start with `elements`. */
const crystalOf =
  (structure: string, ...elements: string[]) =>
  (p: FlowParams) =>
    p.type === "crystal" &&
    p.structure === structure &&
    elements.every((e, i) => p.elements[i]?.trim().toLowerCase() === e.toLowerCase());

const latticeA = (lo: number, hi: number) => (p: FlowParams) =>
  p.type === "crystal" && near(p.a, lo, hi);

const miller = (h: number, k: number, l: number) => (p: FlowParams) =>
  p.type === "slab" && same(p.miller, [h, k, l]);

/** A `components` row of a liquid box: its molecule's formula and its count. */
function component(args: Record<string, unknown>, formula: Record<string, number>, n: number) {
  const rows = Array.isArray(args.components) ? (args.components as Record<string, unknown>[]) : [];
  return rows.some((r) => r.count === n && isFormula(moleculeArg(r.molecule), formula));
}

/** The slab-with-water template, as a flow already in the graph. */
const slabWithWater = () => FLOW_TEMPLATES.find((t) => t.id === "slab-adsorbates")!.create();

const WATER = { H: 2, O: 1 };

export const FLOW_DATASET: FlowBenchCase[] = [
  // ── Bulk crystals ────────────────────────────────────────────────────
  {
    id: "crystal-cu-bulk",
    prompt: "Build bulk fcc copper.",
    tags: ["crystal", "basic"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal"],
      maxBlocks: 2,
      params: [
        { label: "fcc Cu", block: "crystal", test: crystalOf("fcc", "Cu") },
        { label: "a ≈ 3.61 Å", block: "crystal", test: latticeA(3.55, 3.67) },
      ],
      result: [onlyElements("Cu"), cell()],
    },
  },
  {
    id: "crystal-nacl-supercell",
    prompt: "Make a 3×3×3 supercell of rocksalt NaCl.",
    tags: ["crystal", "supercell"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal", "supercell"],
      requiredWires: [{ from: "crystal", to: "supercell", input: "structure" }],
      params: [
        { label: "rocksalt Na Cl", block: "crystal", test: crystalOf("rocksalt", "Na", "Cl") },
        { label: "a ≈ 5.64 Å", block: "crystal", test: latticeA(5.5, 5.8) },
        {
          label: "repeat 3 × 3 × 3",
          block: "supercell",
          test: (p) => p.type === "supercell" && same(p.repeat, [3, 3, 3]),
        },
      ],
      result: [onlyElements("Na", "Cl"), equalCounts("Na", "Cl"), atomsIn([54, 216]), cell()],
    },
  },
  {
    id: "crystal-si-supercell",
    prompt: "Build diamond-structure silicon and repeat it 2 × 2 × 2.",
    tags: ["crystal", "supercell"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal", "supercell"],
      requiredWires: [{ from: "crystal", to: "supercell", input: "structure" }],
      params: [
        { label: "diamond Si", block: "crystal", test: crystalOf("diamond", "Si") },
        { label: "a ≈ 5.43 Å", block: "crystal", test: latticeA(5.35, 5.5) },
        {
          label: "repeat 2 × 2 × 2",
          block: "supercell",
          test: (p) => p.type === "supercell" && same(p.repeat, [2, 2, 2]),
        },
      ],
      result: [onlyElements("Si"), atomsIn([16, 64]), cell()],
    },
  },
  {
    id: "crystal-mg-hcp",
    prompt: "Bulk hcp magnesium with its experimental lattice constants.",
    tags: ["crystal", "basic"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal"],
      maxBlocks: 2,
      params: [
        { label: "hcp Mg", block: "crystal", test: crystalOf("hcp", "Mg") },
        { label: "a ≈ 3.21 Å", block: "crystal", test: latticeA(3.15, 3.27) },
        {
          label: "c/a ≈ 1.62",
          block: "crystal",
          test: (p) => p.type === "crystal" && near(p.covera, 1.58, 1.66),
        },
      ],
      result: [onlyElements("Mg"), atomsIn([2]), cell()],
    },
  },
  {
    id: "crystal-srtio3",
    prompt: "A cubic SrTiO3 perovskite crystal.",
    tags: ["crystal", "basic"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal"],
      maxBlocks: 2,
      params: [
        {
          label: "perovskite with A = Sr, B = Ti, X = O",
          block: "crystal",
          test: crystalOf("perovskite", "Sr", "Ti", "O"),
        },
        { label: "a ≈ 3.905 Å", block: "crystal", test: latticeA(3.85, 3.96) },
      ],
      result: [count("Sr", 1), count("Ti", 1), count("O", 3), cell()],
    },
  },

  // ── Slabs and molecules on them ──────────────────────────────────────
  {
    id: "slab-pt111",
    prompt: "Cut a Pt(111) slab, 4 layers thick, with 15 Å of vacuum.",
    tags: ["slab"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal", "slab"],
      requiredWires: [{ from: "crystal", to: "slab", input: "bulk" }],
      params: [
        { label: "fcc Pt", block: "crystal", test: crystalOf("fcc", "Pt") },
        { label: "a ≈ 3.92 Å", block: "crystal", test: latticeA(3.85, 4.0) },
        { label: "Miller (1 1 1)", block: "slab", test: miller(1, 1, 1) },
        { label: "4 layers", block: "slab", test: (p) => p.type === "slab" && p.layers === 4 },
        { label: "15 Å vacuum", block: "slab", test: (p) => p.type === "slab" && p.vacuum === 15 },
      ],
      result: [onlyElements("Pt"), cell()],
    },
  },
  {
    id: "adsorb-water-au100",
    prompt: "Lay a 3 × 3 grid of water molecules on an Au(100) surface.",
    tags: ["slab", "adsorb"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal", "slab", "molecule", "adsorb"],
      requiredWires: [
        { from: "crystal", to: "slab", input: "bulk" },
        { from: "slab", to: "adsorb", input: "surface" },
        { from: "molecule", to: "adsorb", input: "molecule" },
      ],
      params: [
        { label: "fcc Au", block: "crystal", test: crystalOf("fcc", "Au") },
        { label: "Miller (1 0 0)", block: "slab", test: miller(1, 0, 0) },
        {
          label: "a 3 × 3 grid",
          block: "adsorb",
          test: (p) => p.type === "adsorb" && same(p.grid, [3, 3]),
        },
      ],
      result: [some("Au"), count("O", 9), count("H", 18), cell(), noOverlap()],
    },
  },
  {
    id: "adsorb-co-pt111",
    prompt: "Put carbon monoxide molecules on a Pt(111) slab, 2 by 2.",
    tags: ["slab", "adsorb", "smiles"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal", "slab", "molecule", "adsorb"],
      requiredWires: [
        { from: "slab", to: "adsorb", input: "surface" },
        { from: "molecule", to: "adsorb", input: "molecule" },
      ],
      params: [
        { label: "Miller (1 1 1)", block: "slab", test: miller(1, 1, 1) },
        {
          label: "a 2 × 2 grid",
          block: "adsorb",
          test: (p) => p.type === "adsorb" && same(p.grid, [2, 2]),
        },
      ],
      // CO written as methanol ("CO") or formaldehyde ("C=O") brings hydrogens.
      result: [some("Pt"), count("C", 4), count("O", 4), none("H"), noOverlap()],
    },
  },
  {
    id: "adsorb-methanol-cu111-ja",
    prompt: "銅(111)面のスラブにメタノールを2×2で並べてください。",
    tags: ["slab", "adsorb", "japanese"],
    setup: {},
    rubric: {
      requiredBlocks: ["crystal", "slab", "molecule", "adsorb"],
      requiredWires: [
        { from: "crystal", to: "slab", input: "bulk" },
        { from: "slab", to: "adsorb", input: "surface" },
        { from: "molecule", to: "adsorb", input: "molecule" },
      ],
      params: [
        { label: "fcc Cu", block: "crystal", test: crystalOf("fcc", "Cu") },
        { label: "Miller (1 1 1)", block: "slab", test: miller(1, 1, 1) },
        {
          label: "a 2 × 2 grid",
          block: "adsorb",
          test: (p) => p.type === "adsorb" && same(p.grid, [2, 2]),
        },
      ],
      result: [some("Cu"), count("C", 4), count("O", 4), count("H", 16), noOverlap()],
    },
  },

  // ── Molecules and polymers ───────────────────────────────────────────
  {
    id: "molecule-aspirin",
    prompt: "A single aspirin molecule.",
    tags: ["molecule", "smiles"],
    setup: {},
    rubric: {
      requiredBlocks: ["molecule"],
      maxBlocks: 1,
      result: [
        onlyElements("C", "H", "O"),
        count("C", 9),
        count("H", 8),
        count("O", 4),
        cell(false),
      ],
    },
  },
  {
    id: "polymer-polystyrene",
    prompt: "A polystyrene chain with 10 repeat units.",
    tags: ["polymer"],
    setup: {},
    rubric: {
      requiredBlocks: ["polymer"],
      maxBlocks: 1,
      params: [
        {
          label: "10 repeat units",
          block: "polymer",
          test: (p) => p.type === "polymer" && p.length === 10,
        },
      ],
      result: [onlyElements("C", "H"), count("C", 80), count("H", 82)],
    },
  },
  {
    id: "polymer-peo",
    prompt: "Poly(ethylene oxide), 30 units long.",
    tags: ["polymer"],
    setup: {},
    rubric: {
      requiredBlocks: ["polymer"],
      maxBlocks: 1,
      params: [
        {
          label: "30 repeat units",
          block: "polymer",
          test: (p) => p.type === "polymer" && p.length === 30,
        },
      ],
      // Poly(vinyl alcohol) has the same formula; only PEO's oxygens sit in the
      // backbone, leaving a single O–H (at the chain end).
      result: [onlyElements("C", "H", "O"), count("C", 60), count("O", 30), bondCount("O", "H", 1)],
    },
  },

  // ── The structure open in Manual mode ────────────────────────────────
  {
    id: "document-supercell",
    prompt: "Repeat the structure I have open 2 × 2 × 2.",
    tags: ["document", "supercell"],
    setup: { document: "nacl-cell" },
    rubric: {
      requiredBlocks: ["document", "supercell"],
      forbiddenBlocks: ["crystal"],
      requiredWires: [{ from: "document", to: "supercell", input: "structure" }],
      params: [
        {
          label: "repeat 2 × 2 × 2",
          block: "supercell",
          test: (p) => p.type === "supercell" && same(p.repeat, [2, 2, 2]),
        },
      ],
      result: [atomsIn([64]), equalCounts("Na", "Cl"), cell()],
    },
  },
  {
    id: "document-slab",
    prompt: "Cut a (110) slab with 6 layers from the structure open in Manual mode.",
    tags: ["document", "slab"],
    setup: { document: "cu-cell" },
    rubric: {
      requiredBlocks: ["document", "slab"],
      forbiddenBlocks: ["crystal"],
      requiredWires: [{ from: "document", to: "slab", input: "bulk" }],
      params: [
        { label: "Miller (1 1 0)", block: "slab", test: miller(1, 1, 0) },
        { label: "6 layers", block: "slab", test: (p) => p.type === "slab" && p.layers === 6 },
      ],
      result: [onlyElements("Cu"), cell()],
    },
  },

  // ── Tool server ──────────────────────────────────────────────────────
  {
    id: "tool-liquid-mixture",
    prompt: "A liquid box of 500 water and 50 ethanol molecules at 0.9 g/cm³.",
    tags: ["tool", "liquid"],
    setup: { tools: true },
    rubric: {
      requiredBlocks: ["molecule", "tool"],
      requiredTools: ["liquid_box"],
      requiredWires: [{ from: "molecule", to: "tool", input: "components" }],
      result: [
        called("liquid_box", "500 water molecules", (a) => component(a, WATER, 500)),
        called("liquid_box", "50 ethanol molecules", (a) => component(a, { C: 2, H: 6, O: 1 }, 50)),
        called("liquid_box", "density 0.9", (a) => a.density === 0.9),
      ],
    },
  },
  {
    id: "tool-solvate-au111",
    prompt: "An Au(111) slab with its vacuum filled with water.",
    tags: ["tool", "slab", "solvation"],
    setup: { tools: true },
    rubric: {
      requiredBlocks: ["crystal", "slab", "molecule", "tool"],
      requiredTools: ["solvate"],
      requiredWires: [
        { from: "crystal", to: "slab", input: "bulk" },
        { from: "slab", to: "tool", input: "document" },
        { from: "molecule", to: "tool", input: "solvent" },
      ],
      params: [{ label: "Miller (1 1 1)", block: "slab", test: miller(1, 1, 1) }],
      result: [
        called("solvate", "solvates an Au slab", (a) => {
          const doc = a.document as { elements?: number[]; cell?: unknown } | undefined;
          return !!doc?.cell && !!doc.elements?.length && doc.elements.every((z) => z === 79);
        }),
        called("solvate", "with water", (a) => isFormula(moleculeArg(a.solvent), WATER)),
      ],
    },
  },
  {
    id: "tool-polymer-box",
    prompt: "Pack 8 polyethylene chains of 10 units each into a box at 0.1 g/cm³.",
    tags: ["tool", "polymer", "liquid"],
    setup: { tools: true },
    rubric: {
      requiredBlocks: ["polymer", "tool"],
      requiredTools: ["liquid_box"],
      requiredWires: [{ from: "polymer", to: "tool", input: "components" }],
      result: [
        called("liquid_box", "8 C20H42 chains", (a) => component(a, { C: 20, H: 42 }, 8)),
        called("liquid_box", "density 0.1", (a) => a.density === 0.1),
      ],
    },
  },
  {
    id: "no-tools-water-box",
    prompt: "Make a box of 1000 water molecules.",
    tags: ["tool", "prose"],
    setup: {},
    rubric: {
      prose: [
        {
          label: "says a tool server is needed",
          test: (text) => /tool server|ツールサーバ/i.test(text),
        },
      ],
    },
  },

  // ── Editing the flow in the graph ────────────────────────────────────
  {
    id: "edit-slab-layers",
    prompt: "Make this slab 6 layers thick.",
    tags: ["edit", "slab"],
    setup: { flow: slabWithWater(), selected: ["n2"] },
    rubric: {
      keeps: ["n1", "n2", "n3", "n4"],
      unchanged: ["n1", "n3", "n4"],
      params: [
        { label: "6 layers", block: "slab", test: (p) => p.type === "slab" && p.layers === 6 },
        { label: "still (1 1 1)", block: "slab", test: miller(1, 1, 1) },
      ],
      result: [some("Pt"), count("O", 9), noOverlap()],
    },
  },
  {
    id: "edit-swap-molecule",
    prompt: "Use ammonia instead of water on the surface.",
    tags: ["edit", "adsorb"],
    setup: { flow: slabWithWater() },
    rubric: {
      keeps: ["n1", "n2", "n4"],
      unchanged: ["n1", "n2", "n4"],
      result: [some("Pt"), count("N", 9), none("O"), noOverlap()],
    },
  },
];
