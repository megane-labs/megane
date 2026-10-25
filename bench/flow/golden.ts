/**
 * A right answer and wrong answers for every Flow benchmark case.
 *
 * The right answer (`reference`) proves a perfect reply can score 1.0: it is
 * built through the Flow store's own actions (`addNode`, `connect`,
 * `updateParams`, `load`) — what the editor does when a user builds it — and
 * serialized with `serialize()`, never written as JSON by hand, then run
 * through the production engine by the test. The wrong answers
 * (`counterexamples`) prove the rubric can tell: each is a plausible mistake
 * (the wrong polymorph, CO written as methanol, the slab cut from a molecule,
 * the edit that rebuilt the whole flow) that must score below 1.0, and at
 * least one per case must fail on what the flow *builds*. A rubric that
 * passes everything is indistinguishable from one that works.
 *
 * `tests/ts/bench/flow-bench.test.ts` enforces both, for every case in
 * `dataset.ts`; a case without an entry here fails it.
 */

import { defaultBuiltinParams } from "@/builder/flow/builtins";
import { initialToolParams } from "@/builder/flow/ports";
import { createFlowStore, type FlowStore, type SerializedFlow } from "@/builder/flow/store";
import type { CrystalParams, FlowParams } from "@/builder/flow/types";
import { referenceTools } from "./environment";
import { FLOW_DATASET } from "./dataset";

export interface GoldenCase {
  /** The right answer, as the assistant's reply. */
  reference: () => string;
  /** Wrong answers, each a reply that must not score 1.0. */
  counterexamples: { label: string; reply: () => string }[];
}

/** A reply holding `flow`, in the shape the system prompt asks for. */
export function replyWith(flow: SerializedFlow, sentence = "Builds the structure."): string {
  return `\`\`\`json\n${JSON.stringify(flow)}\n\`\`\`\n${sentence}`;
}

interface Builder {
  add: (params: FlowParams) => string;
  wire: (source: string, target: string, input: string, multiple?: boolean) => void;
  set: (id: string, patch: Record<string, unknown>) => void;
}

/** A flow built through the store's actions, as the editor builds one. */
function build(steps: (b: Builder) => void, start?: SerializedFlow): SerializedFlow {
  const store = createFlowStore();
  const s = (): FlowStore => store.getState();
  if (start) s().load(start);
  steps({
    add: (params) => s().addNode(params),
    wire: (source, target, input, multiple = false) => {
      if (!s().connect({ source, target, sourceHandle: "out", targetHandle: input }, multiple)) {
        throw new Error(`refused wire ${source} → ${target} (${input})`);
      }
    },
    set: (id, patch) => s().updateParams(id, patch as Partial<FlowParams>),
  });
  return s().serialize();
}

const crystal = (patch: Partial<CrystalParams>): FlowParams => ({
  ...(defaultBuiltinParams("crystal") as CrystalParams),
  ...patch,
});
const builtin = (type: Parameters<typeof defaultBuiltinParams>[0], patch: object = {}) =>
  ({ ...defaultBuiltinParams(type), ...patch }) as FlowParams;
const library = (libraryId: string, name = ""): FlowParams => ({
  type: "molecule",
  source: "library",
  smiles: "",
  libraryId,
  name,
});
const smiles = (s: string, name = ""): FlowParams => ({
  type: "molecule",
  source: "smiles",
  smiles: s,
  libraryId: "",
  name,
});
const tool = (name: string, values: Record<string, unknown>): FlowParams => {
  const info = referenceTools().find((t) => t.name === name)!;
  const p = initialToolParams(info);
  return { ...p, values: { ...p.values, ...values, seed: 1 } };
};

const PT = { elements: ["Pt", "", ""], a: 3.92 };
const AU = { elements: ["Au", "", ""], a: 4.08 };
const CU = { elements: ["Cu", "", ""], a: 3.61 };

/** Crystal → slab → molecule on it, the shape of every adsorption case. */
function onSlab(
  bulk: Partial<CrystalParams>,
  slab: object,
  molecule: FlowParams,
  grid: [number, number],
): SerializedFlow {
  return build((b) => {
    const c = b.add(crystal(bulk));
    const s = b.add(builtin("slab", slab));
    const m = b.add(molecule);
    const a = b.add(builtin("adsorb", { grid }));
    b.wire(c, s, "bulk");
    b.wire(s, a, "surface");
    b.wire(m, a, "molecule");
  });
}

/** Crystal → supercell. */
function repeated(bulk: Partial<CrystalParams>, repeat: [number, number, number]): SerializedFlow {
  return build((b) => {
    const c = b.add(crystal(bulk));
    const x = b.add(builtin("supercell", { repeat }));
    b.wire(c, x, "structure");
  });
}

const single = (params: FlowParams) => build((b) => void b.add(params));

const NACL = { structure: "rocksalt" as const, elements: ["Na", "Cl", ""], a: 5.64 };
const SI = { structure: "diamond" as const, elements: ["Si", "", ""], a: 5.43 };

const slabWithWater = () => FLOW_DATASET.find((c) => c.id === "edit-slab-layers")!.setup.flow!;

/** A liquid box of `rows` (molecule params and counts) at `density`. */
function liquidBox(rows: [FlowParams, number][], density: number): SerializedFlow {
  return build((b) => {
    const ids = rows.map(([params]) => b.add(params));
    const box = b.add(tool("liquid_box", { density }));
    ids.forEach((id) => b.wire(id, box, "components", true));
    b.set(box, {
      rows: { components: Object.fromEntries(ids.map((id, i) => [id, { count: rows[i][1] }])) },
    });
  });
}

/** An Au slab solvated by `solvent`. */
function solvated(miller: [number, number, number], solvent: FlowParams): SerializedFlow {
  return build((b) => {
    const c = b.add(crystal(AU));
    const s = b.add(builtin("slab", { miller, layers: 3, vacuum: 10, repeat: [2, 2] }));
    const w = b.add(solvent);
    const t = b.add(tool("solvate", { density: 1 }));
    b.wire(c, s, "bulk");
    b.wire(s, t, "document");
    b.wire(w, t, "solvent");
  });
}

const flow = (f: () => SerializedFlow) => () => replyWith(f());

export const GOLDEN: Record<string, GoldenCase> = {
  "crystal-cu-bulk": {
    reference: flow(() => single(crystal(CU))),
    counterexamples: [
      {
        label: "bcc instead of fcc",
        reply: flow(() => single(crystal({ ...CU, structure: "bcc" }))),
      },
      {
        label: "silver",
        reply: flow(() => single(crystal({ elements: ["Ag", "", ""], a: 4.09 }))),
      },
    ],
  },
  "crystal-nacl-supercell": {
    reference: flow(() => repeated(NACL, [3, 3, 3])),
    counterexamples: [
      { label: "2 × 2 × 2", reply: flow(() => repeated(NACL, [2, 2, 2])) },
      {
        label: "CsCl structure",
        reply: flow(() => repeated({ ...NACL, structure: "cesiumchloride" }, [3, 3, 3])),
      },
    ],
  },
  "crystal-si-supercell": {
    reference: flow(() => repeated(SI, [2, 2, 2])),
    counterexamples: [
      { label: "no supercell", reply: flow(() => single(crystal(SI))) },
      {
        label: "germanium",
        reply: flow(() => repeated({ ...SI, elements: ["Ge", "", ""], a: 5.66 }, [2, 2, 2])),
      },
    ],
  },
  "crystal-mg-hcp": {
    reference: flow(() =>
      single(crystal({ structure: "hcp", elements: ["Mg", "", ""], a: 3.21, covera: 1.624 })),
    ),
    counterexamples: [
      {
        label: "fcc Mg",
        reply: flow(() => single(crystal({ structure: "fcc", elements: ["Mg", "", ""], a: 4.52 }))),
      },
    ],
  },
  "crystal-srtio3": {
    reference: flow(() =>
      single(crystal({ structure: "perovskite", elements: ["Sr", "Ti", "O"], a: 3.905 })),
    ),
    counterexamples: [
      {
        label: "A and B swapped",
        reply: flow(() =>
          single(crystal({ structure: "perovskite", elements: ["Ti", "Sr", "O"], a: 3.905 })),
        ),
      },
      {
        label: "rocksalt SrO",
        reply: flow(() =>
          single(crystal({ structure: "rocksalt", elements: ["Sr", "O", ""], a: 5.16 })),
        ),
      },
    ],
  },
  "slab-pt111": {
    reference: flow(() =>
      build((b) => {
        const c = b.add(crystal(PT));
        const s = b.add(builtin("slab", { miller: [1, 1, 1], layers: 4, vacuum: 15 }));
        b.wire(c, s, "bulk");
      }),
    ),
    counterexamples: [
      {
        label: "(100), 10 Å",
        reply: flow(() =>
          build((b) => {
            const c = b.add(crystal(PT));
            const s = b.add(builtin("slab", { miller: [1, 0, 0], layers: 4, vacuum: 10 }));
            b.wire(c, s, "bulk");
          }),
        ),
      },
      {
        label: "palladium",
        reply: flow(() =>
          build((b) => {
            const c = b.add(crystal({ elements: ["Pd", "", ""], a: 3.89 }));
            const s = b.add(builtin("slab", { miller: [1, 1, 1], layers: 4, vacuum: 15 }));
            b.wire(c, s, "bulk");
          }),
        ),
      },
    ],
  },
  "adsorb-water-au100": {
    reference: flow(() =>
      onSlab(AU, { miller: [1, 0, 0] }, library("preset:water", "WAT"), [3, 3]),
    ),
    counterexamples: [
      {
        label: "2 × 2 grid",
        reply: flow(() => onSlab(AU, { miller: [1, 0, 0] }, library("preset:water"), [2, 2])),
      },
      {
        label: "methanol",
        reply: flow(() => onSlab(AU, { miller: [1, 0, 0] }, library("preset:methanol"), [3, 3])),
      },
    ],
  },
  "adsorb-co-pt111": {
    reference: flow(() => onSlab(PT, { miller: [1, 1, 1] }, smiles("[C-]#[O+]", "CO"), [2, 2])),
    counterexamples: [
      {
        label: "CO written as methanol",
        reply: flow(() => onSlab(PT, { miller: [1, 1, 1] }, smiles("CO", "CO"), [2, 2])),
      },
      {
        label: "carbon dioxide",
        reply: flow(() =>
          onSlab(PT, { miller: [1, 1, 1] }, library("preset:carbon-dioxide"), [2, 2]),
        ),
      },
    ],
  },
  "adsorb-methanol-cu111-ja": {
    reference: flow(() =>
      onSlab(CU, { miller: [1, 1, 1] }, library("preset:methanol", "MOH"), [2, 2]),
    ),
    counterexamples: [
      {
        label: "ethanol",
        reply: flow(() => onSlab(CU, { miller: [1, 1, 1] }, library("preset:ethanol"), [2, 2])),
      },
      {
        label: "silver surface",
        reply: flow(() =>
          onSlab(
            { elements: ["Ag", "", ""], a: 4.09 },
            { miller: [1, 1, 1] },
            library("preset:methanol"),
            [2, 2],
          ),
        ),
      },
    ],
  },
  "molecule-aspirin": {
    reference: flow(() => single(smiles("CC(=O)Oc1ccccc1C(=O)O", "ASP"))),
    counterexamples: [
      { label: "salicylic acid", reply: flow(() => single(smiles("Oc1ccccc1C(=O)O"))) },
    ],
  },
  "polymer-polystyrene": {
    reference: flow(() =>
      single(builtin("polymer", { repeatUnit: "*CC(c1ccccc1)*", length: 10, name: "PS" })),
    ),
    counterexamples: [
      {
        label: "polyethylene",
        reply: flow(() =>
          single(builtin("polymer", { repeatUnit: "*CC*", length: 10, name: "PE" })),
        ),
      },
      {
        label: "5 units",
        reply: flow(() =>
          single(builtin("polymer", { repeatUnit: "*CC(c1ccccc1)*", length: 5, name: "PS" })),
        ),
      },
    ],
  },
  "polymer-peo": {
    reference: flow(() =>
      single(builtin("polymer", { repeatUnit: "*CCO*", length: 30, name: "PEO" })),
    ),
    counterexamples: [
      {
        label: "poly(vinyl alcohol)",
        reply: flow(() =>
          single(builtin("polymer", { repeatUnit: "*CC(O)*", length: 30, name: "PVA" })),
        ),
      },
    ],
  },
  "document-supercell": {
    reference: flow(() =>
      build((b) => {
        const d = b.add({ type: "document" });
        const x = b.add(builtin("supercell", { repeat: [2, 2, 2] }));
        b.wire(d, x, "structure");
      }),
    ),
    counterexamples: [
      {
        label: "a new NaCl crystal instead of the open structure",
        reply: flow(() => repeated({ ...NACL, cubic: false }, [2, 2, 2])),
      },
      {
        label: "3 × 3 × 3",
        reply: flow(() =>
          build((b) => {
            const d = b.add({ type: "document" });
            const x = b.add(builtin("supercell", { repeat: [3, 3, 3] }));
            b.wire(d, x, "structure");
          }),
        ),
      },
    ],
  },
  "document-slab": {
    reference: flow(() =>
      build((b) => {
        const d = b.add({ type: "document" });
        const s = b.add(builtin("slab", { miller: [1, 1, 0], layers: 6 }));
        b.wire(d, s, "bulk");
      }),
    ),
    counterexamples: [
      {
        label: "a new Au crystal instead of the open structure",
        reply: flow(() =>
          build((b) => {
            const c = b.add(crystal(AU));
            const s = b.add(builtin("slab", { miller: [1, 1, 0], layers: 6 }));
            b.wire(c, s, "bulk");
          }),
        ),
      },
    ],
  },
  "tool-liquid-mixture": {
    reference: flow(() =>
      liquidBox(
        [
          [library("preset:water", "WAT"), 500],
          [library("preset:ethanol", "ETOH"), 50],
        ],
        0.9,
      ),
    ),
    counterexamples: [
      {
        label: "counts swapped",
        reply: flow(() =>
          liquidBox(
            [
              [library("preset:water"), 50],
              [library("preset:ethanol"), 500],
            ],
            0.9,
          ),
        ),
      },
      {
        label: "methanol instead of ethanol",
        reply: flow(() =>
          liquidBox(
            [
              [library("preset:water"), 500],
              [library("preset:methanol"), 50],
            ],
            0.9,
          ),
        ),
      },
    ],
  },
  "tool-solvate-au111": {
    reference: flow(() => solvated([1, 1, 1], library("preset:water", "WAT"))),
    counterexamples: [
      { label: "ammonia", reply: flow(() => solvated([1, 1, 1], library("preset:ammonia"))) },
      {
        label: "solvates the bulk crystal, not the slab",
        reply: flow(() =>
          build((b) => {
            const c = b.add(crystal(AU));
            const w = b.add(library("preset:water"));
            const t = b.add(tool("solvate", { density: 1 }));
            b.wire(c, t, "document");
            b.wire(w, t, "solvent");
          }),
        ),
      },
    ],
  },
  "tool-polymer-box": {
    reference: flow(() =>
      liquidBox([[builtin("polymer", { repeatUnit: "*CC*", length: 10, name: "PE" }), 8]], 0.1),
    ),
    counterexamples: [
      {
        label: "20-unit chains",
        reply: flow(() =>
          liquidBox([[builtin("polymer", { repeatUnit: "*CC*", length: 20, name: "PE" }), 8]], 0.1),
        ),
      },
      {
        label: "melt density",
        reply: flow(() =>
          liquidBox(
            [[builtin("polymer", { repeatUnit: "*CC*", length: 10, name: "PE" }), 8]],
            0.85,
          ),
        ),
      },
    ],
  },
  "no-tools-water-box": {
    reference: () =>
      "Packing a box of water needs a tool server with packmol; connect one from the Add menu first.",
    counterexamples: [
      { label: "a lone water molecule", reply: flow(() => single(library("preset:water"))) },
      { label: "refuses without saying why", reply: () => "I can't do that." },
    ],
  },
  "edit-slab-layers": {
    reference: flow(() => build((b) => b.set("n2", { layers: 6 }), slabWithWater())),
    counterexamples: [
      {
        label: "the grid changed too",
        reply: flow(() =>
          build((b) => {
            b.set("n2", { layers: 6 });
            b.set("n4", { grid: [2, 2] });
          }, slabWithWater()),
        ),
      },
      {
        label: "rebuilt from scratch, losing the molecules' 2.2 Å height",
        reply: flow(() =>
          onSlab(
            PT,
            { miller: [1, 1, 1], layers: 6, vacuum: 10, repeat: [2, 2] },
            library("preset:water", "WAT"),
            [3, 3],
          ),
        ),
      },
    ],
  },
  "edit-swap-molecule": {
    reference: flow(() =>
      build((b) => b.set("n3", { libraryId: "preset:ammonia", name: "NH3" }), slabWithWater()),
    ),
    counterexamples: [
      { label: "left the water", reply: flow(() => slabWithWater()) },
      {
        label: "methane",
        reply: flow(() =>
          build((b) => b.set("n3", { libraryId: "preset:methane", name: "CH4" }), slabWithWater()),
        ),
      },
    ],
  },
};
