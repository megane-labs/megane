/** The Flow assistant's self-check: reading, normalizing, checking and preparing a model's flow. */

import { describe, it, expect } from "vitest";
import {
  MAX_REPORTED_FLOW_ERRORS,
  buildFlowRepairPrompt,
  buildUnparsableFlowPrompt,
  collectFlowErrors,
  diagnoseFlowResponse,
  normalizeParams,
  prepareGeneratedFlow,
  tryExtractFlow,
  type FlowCheckContext,
  type RawFlow,
} from "@/builder/flow/ai/check";
import { FLOW_TEMPLATES } from "@/builder/flow/templates";
import { parseTools } from "@/builder/tools/contract";
import { LIB_WATER, tools } from "../helpers";
import { TOOLS } from "../../tools/fixtures";

const ETHANOL = { ...LIB_WATER, id: "preset:ethanol", name: "ethanol" };
const ctx: FlowCheckContext = { library: [LIB_WATER, ETHANOL], tools: Object.values(tools) };
const noTools: FlowCheckContext = { library: [LIB_WATER], tools: null };

type Node = { id: string; position?: unknown; params: Record<string, unknown> };
type Edge = { source: string; target: string; targetHandle?: string };

function flow(nodes: Node[], edges: Edge[] = []): RawFlow {
  return {
    version: 1,
    nodes: nodes.map((n, i) => ({ position: { x: 40, y: 40 + i * 150 }, ...n })),
    edges,
  };
}

const crystal = (extra: Record<string, unknown> = {}) => ({
  id: "c",
  params: { type: "crystal", structure: "fcc", elements: ["Pt", "", ""], a: 3.92, ...extra },
});
const slab = (extra: Record<string, unknown> = {}) => ({
  id: "s",
  params: { type: "slab", miller: [1, 1, 1], ...extra },
});
const water = (id = "w") => ({
  id,
  params: { type: "molecule", source: "library", libraryId: "preset:water" },
});

describe("tryExtractFlow", () => {
  it("takes the last closed fence that is a flow", () => {
    const first = JSON.stringify(flow([crystal()]));
    const last = JSON.stringify(flow([water()]));
    const text = `\`\`\`json\n${first}\n\`\`\`\n\`\`\`json\n${last}\n\`\`\`\nDone.`;
    expect((tryExtractFlow(text)!.nodes[0] as Node).id).toBe("w");
  });

  it("ignores a viewer pipeline, broken JSON and an open fence", () => {
    expect(tryExtractFlow('```json\n{"version":3,"nodes":[],"edges":[]}\n```')).toBeNull();
    expect(tryExtractFlow('```json\n{"version":1,"nodes":[\n```')).toBeNull();
    expect(tryExtractFlow('```json\n{"version":1,"nodes":[],"edges":[]}')).toBeNull();
    expect(tryExtractFlow("plain words")).toBeNull();
  });
});

describe("normalizeParams", () => {
  it("fills a built-in block's defaults and drops keys it does not have", () => {
    expect(normalizeParams({ type: "slab", miller: [1, 0, 0], hkl: [1, 1, 1] }, ctx)).toEqual({
      type: "slab",
      miller: [1, 0, 0],
      layers: 4,
      vacuum: 10,
      repeat: [2, 2],
    });
  });

  it("reads a molecule with only a library id as a library molecule", () => {
    expect(normalizeParams({ type: "molecule", libraryId: "preset:water" }, ctx)).toEqual({
      type: "molecule",
      source: "library",
      smiles: "",
      libraryId: "preset:water",
      name: "",
    });
    expect(normalizeParams({ type: "molecule", smiles: "CCO" }, ctx)).toMatchObject({
      source: "smiles",
      smiles: "CCO",
    });
  });

  it("names a tool block after its tool and gives it empty values and rows", () => {
    expect(normalizeParams({ type: "tool", tool: "liquid_box" }, ctx)).toEqual({
      type: "tool",
      tool: "liquid_box",
      label: tools.liquid_box.label,
      values: {},
      rows: {},
    });
    expect(normalizeParams({ type: "tool", tool: "nope", values: 3 }, noTools)).toMatchObject({
      label: "nope",
      values: {},
    });
    expect(normalizeParams({ type: "document", extra: 1 }, ctx)).toEqual({ type: "document" });
  });
});

describe("collectFlowErrors", () => {
  it("accepts every template, with and without the tools it names", () => {
    for (const t of FLOW_TEMPLATES) {
      const raw = t.create() as unknown as RawFlow;
      expect(collectFlowErrors(raw, ctx), t.id).toEqual([]);
      if (t.tools.length === 0) expect(collectFlowErrors(raw, noTools), t.id).toEqual([]);
    }
  });

  it("reports structural problems alone", () => {
    const errors = collectFlowErrors(
      {
        version: 1,
        nodes: [
          { params: { type: "crystal" } },
          { id: "a", params: { type: "crystal" } },
          { id: "a", params: { type: "crystal" } },
          { id: "b", params: { type: "teleport" } },
          { id: "c", params: "slab" },
        ],
        edges: [{ source: "a", target: "zz", targetHandle: "bulk" }, { source: 1 }],
      },
      ctx,
    );
    expect(errors).toEqual([
      'nodes[0] needs a string `id` (e.g. "n1").',
      'two blocks have the id "a"; every block needs its own id.',
      expect.stringContaining('block "b" has the unknown type "teleport"'),
      expect.stringContaining('block "c" has no `params` object'),
      'the wire a → zz names "zz", which is not a block of the flow.',
      "edges[1] needs string `source`, `target` and `targetHandle`.",
    ]);
  });

  it("asks for at least one block", () => {
    expect(collectFlowErrors(flow([]), ctx)).toEqual(["the flow has no blocks."]);
  });

  it("names settings a block does not have", () => {
    expect(collectFlowErrors(flow([{ id: "d", params: { type: "document", x: 1 } }]), ctx)).toEqual(
      ['block "d" (document) has no setting "x"; it has no settings.'],
    );
    expect(collectFlowErrors(flow([crystal({ lattice: 4 })]), ctx)).toEqual([
      'block "c" (crystal) has no setting "lattice"; its settings are structure, elements, a, covera, cubic.',
    ]);
  });

  it("checks the type of every built-in setting", () => {
    const errors = collectFlowErrors(
      flow([
        crystal({ structure: "fluorescent", elements: "Pt", cubic: "yes", a: "3.9" }),
        { id: "p", params: { type: "polymer", repeatUnit: 5, name: null, length: 10 } },
        { id: "x", params: { type: "supercell", repeat: [2, 2] } },
        { id: "s", params: { type: "slab", repeat: [1, 1, 1] } },
        { id: "g", params: { type: "adsorb", grid: [1], height: "2" } },
        { id: "m", params: { type: "molecule", source: "file" } },
      ]),
      ctx,
    );
    expect(errors).toEqual([
      expect.stringMatching(
        /"c" \(crystal\): `structure` must be one of "sc", "fcc".*"fluorescent"/,
      ),
      expect.stringContaining('"c" (crystal): `elements` must be an array of element symbols'),
      'block "c" (crystal): `a` must be a number, not "3.9".',
      'block "c" (crystal): `cubic` must be true or false, not "yes".',
      'block "p" (polymer): `repeatUnit` must be a string, not 5.',
      'block "p" (polymer): `name` must be a string, not null.',
      'block "x" (supercell): `repeat` must be an array of 3 whole numbers, not [2,2].',
      'block "s" (slab): `repeat` must be an array of 2 whole numbers, not [1,1,1].',
      'block "g" (adsorb): `height` must be a number, not "2".',
      'block "g" (adsorb): `grid` must be an array of 2 whole numbers, not [1].',
      'block "m" (molecule): `source` must be "smiles" or "library", not "file".',
      // Wires are still checked: the inputs are fixed whatever the settings.
      'block "x" (supercell) needs a wire into its "structure" input (Structure).',
      'block "s" (slab) needs a wire into its "bulk" input (Bulk crystal).',
      'block "g" (adsorb) needs a wire into its "surface" input (Surface).',
      'block "g" (adsorb) needs a wire into its "molecule" input (Molecule).',
    ]);
  });

  it("reports what the block itself would refuse to run with", () => {
    const errors = collectFlowErrors(
      flow(
        [
          crystal({ elements: ["Xx", "", ""] }),
          slab({ miller: [0, 0, 0] }),
          { id: "p", params: { type: "polymer", repeatUnit: "CC", length: 5 } },
        ],
        [{ source: "c", target: "s", targetHandle: "bulk" }],
      ),
      ctx,
    );
    expect(errors).toEqual([
      'block "c" (crystal): Species A: "Xx" is not an element symbol.',
      'block "s" (slab): Miller indices must be whole numbers, not all zero.',
      expect.stringContaining('block "p" (polymer): Write the repeat unit with one *'),
    ]);
  });

  it("checks a molecule's SMILES and library id", () => {
    const errors = collectFlowErrors(
      flow([
        { id: "a", params: { type: "molecule", source: "smiles", smiles: "  " } },
        { id: "b", params: { type: "molecule", source: "library", libraryId: "preset:gold" } },
        { id: "c", params: { type: "molecule", smiles: "CCO", name: "EtOH" } },
        water(),
      ]),
      ctx,
    );
    expect(errors).toEqual([
      'block "a" (molecule) reads a SMILES string, but `smiles` is empty.',
      expect.stringContaining('block "b" (molecule): "preset:gold" is not a library molecule'),
    ]);
  });

  describe("tool blocks", () => {
    const liquid = (params: Record<string, unknown> = {}) => ({
      id: "box",
      params: { type: "tool", tool: "liquid_box", ...params },
    });
    const intoBox = (src: string): Edge => ({
      source: src,
      target: "box",
      targetHandle: "components",
    });

    it("accepts a liquid box with its counts in rows", () => {
      const raw = flow(
        [
          water(),
          water("e"),
          liquid({ values: { density: 0.9 }, rows: { components: { w: { count: 10 } } } }),
        ],
        [intoBox("w"), intoBox("e")],
      );
      expect(collectFlowErrors(raw, ctx)).toEqual([]);
    });

    it("needs a connected server that has the tool", () => {
      const raw = flow([water(), liquid()], [intoBox("w")]);
      expect(collectFlowErrors(raw, noTools)).toEqual([
        expect.stringContaining(
          'block "box" (tool) calls "liquid_box", but no tool server is connected',
        ),
      ]);
      expect(collectFlowErrors(raw, { ...ctx, tools: [tools.solvate] })).toEqual([
        'block "box" (tool): the connected server has no tool "liquid_box"; its tools are "solvate".',
      ]);
      expect(collectFlowErrors(flow([{ id: "t", params: { type: "tool" } }]), ctx)).toEqual([
        'block "t" (tool) needs `tool`, the name of a tool of the connected server.',
      ]);
    });

    it("refuses a tool Flow mode cannot wire", () => {
      const listing = parseTools(TOOLS).tools;
      const picky = { ...listing[0], name: "picky", fields: null, formError: "No form." };
      const raw = flow([{ id: "t", params: { type: "tool", tool: "picky" } }]);
      expect(collectFlowErrors(raw, { ...ctx, tools: [picky] })).toEqual([
        'block "t" (tool): "picky" cannot be a Flow block: No form.',
      ]);
    });

    it("checks values and rows against the tool's form", () => {
      const raw = flow(
        [
          water(),
          liquid({
            values: { density: 9, shape: "spherical", components: [], colour: "red" },
            rows: {
              components: { w: { count: 0 }, ghost: { count: 1 } },
              density: {},
            },
          }),
        ],
        [intoBox("w")],
      );
      expect(collectFlowErrors(raw, ctx)).toEqual([
        expect.stringContaining('"components" is an input, not a setting'),
        expect.stringContaining('"liquid_box" has no setting "colour"; its settings are seed'),
        expect.stringMatching(/block "box" \(tool\): Density must be at most 5\./),
        'block "box" (tool), row of "w": Count must be at least 1.',
        'block "box" (tool): `rows.components` has a row for "ghost", which is not wired into components.',
        'block "box" (tool): `rows` has "density", which is not an input that takes many wires.',
      ]);
    });

    it("checks an enum inside a group of settings", () => {
      const field = { help: null, required: false, default: undefined, example: undefined };
      const grouped: typeof tools.liquid_box = {
        ...tools.liquid_box,
        name: "grouped",
        fields: [
          {
            ...field,
            kind: "group",
            key: "opts",
            label: "Options",
            fields: [{ ...field, kind: "enum", key: "mode", label: "Mode", options: ["a", "b"] }],
          },
        ],
      };
      const raw = (mode: string) =>
        flow([{ id: "g", params: { type: "tool", tool: "grouped", values: { opts: { mode } } } }]);
      const groupCtx = { ...ctx, tools: [grouped] };
      expect(collectFlowErrors(raw("b"), groupCtx)).toEqual([]);
      expect(collectFlowErrors(raw("z"), groupCtx)).toEqual([
        'block "g" (tool): mode must be one of "a", "b", not "z".',
      ]);
    });

    it("checks enum values, row shapes and the values object itself", () => {
      const shape = flow([water(), liquid({ values: { shape: "spherical" } })], [intoBox("w")]);
      expect(collectFlowErrors(shape, ctx)).toEqual([
        'block "box" (tool): shape must be one of "cubic", "orthorhombic", not "spherical".',
      ]);
      const rows = flow(
        [water(), water("e"), liquid({ rows: { components: { w: 5, e: { count: 2, mass: 1 } } } })],
        [intoBox("w"), intoBox("e")],
      );
      expect(collectFlowErrors(rows, ctx)).toEqual([
        'block "box" (tool): `rows.components.w` must be an object of column values.',
        'block "box" (tool): `rows.components.e` has "mass"; its columns are count.',
      ]);
      const notMap = flow([water(), liquid({ rows: { components: [1] } })], [intoBox("w")]);
      expect(collectFlowErrors(notMap, ctx)).toEqual([
        'block "box" (tool): `rows.components` must map a wired block\'s id to its row.',
      ]);
      const values = flow([water(), liquid({ values: "dense" })], [intoBox("w")]);
      expect(collectFlowErrors(values, ctx)).toEqual([
        'block "box" (tool): `values` must be an object.',
      ]);
    });
  });

  it("checks every wire against the inputs of its target", () => {
    const errors = collectFlowErrors(
      flow(
        [crystal(), water(), slab(), { id: "a", params: { type: "adsorb" } }],
        [
          { source: "c", target: "s", targetHandle: "bulk" },
          { source: "c", target: "s", targetHandle: "bulk" },
          { source: "c", target: "w", targetHandle: "in" },
          { source: "w", target: "s", targetHandle: "surface" },
          { source: "s", target: "s", targetHandle: "bulk" },
          { source: "s", target: "a", targetHandle: "surface" },
          { source: "c", target: "a", targetHandle: "surface" },
          { source: "w", target: "a", targetHandle: "molecule" },
        ],
      ),
      ctx,
    );
    expect(errors).toEqual([
      "the wire c → s (bulk) is listed twice.",
      'the wire c → w (in): block "w" (molecule) takes no inputs; it starts a structure.',
      'the wire w → s (surface): block "s" (slab) has no input "surface"; its inputs are "bulk".',
      "the wire s → s (bulk) connects a block to itself.",
      'block "a" (adsorb): its "surface" input takes one wire, but 2 (s, c) go into it.',
    ]);
  });

  it("fills in the input of a block that has only one", () => {
    const raw = flow([crystal(), slab()], [{ source: "c", target: "s" }]);
    expect(collectFlowErrors(raw, ctx)).toEqual([]);
    const two = flow(
      [crystal(), water(), { id: "a", params: { type: "adsorb" } }],
      [{ source: "c", target: "a" }],
    );
    expect(collectFlowErrors(two, ctx)).toEqual([
      "the wire c → a needs `targetHandle`, the input it goes into.",
    ]);
  });

  it("refuses a slab or supercell cut from a structure with no unit cell", () => {
    const errors = collectFlowErrors(
      flow(
        [
          { id: "p", params: { type: "polymer" } },
          slab(),
          water(),
          { id: "a", params: { type: "adsorb" } },
          { id: "x", params: { type: "supercell" } },
          { id: "d", params: { type: "document" } },
          { id: "y", params: { type: "supercell" } },
        ],
        [
          { source: "p", target: "s", targetHandle: "bulk" },
          { source: "w", target: "a", targetHandle: "surface" },
          { source: "w", target: "a", targetHandle: "molecule" },
          { source: "a", target: "x", targetHandle: "structure" },
          { source: "d", target: "y", targetHandle: "structure" },
        ],
      ),
      ctx,
    );
    expect(errors).toEqual([
      expect.stringMatching(
        /^the wire p → s \(bulk\): A slab is cut .* block "p" \(polymer\) has no unit cell/,
      ),
      expect.stringMatching(
        /^the wire a → x \(structure\): A supercell repeats .* block "a" \(adsorb\)/,
      ),
    ]);
  });

  it("reports a loop", () => {
    const raw = flow(
      [crystal(), slab(), { id: "x", params: { type: "supercell" } }],
      [
        { source: "s", target: "x", targetHandle: "structure" },
        { source: "x", target: "s", targetHandle: "bulk" },
      ],
    );
    expect(collectFlowErrors(raw, ctx)).toEqual([
      "the wires make a loop; a flow must run from blocks with no inputs down to one final block.",
    ]);
  });

  it("leaves a Manual structure block alone, whether or not one is open", () => {
    const raw = flow(
      [
        { id: "d", params: { type: "document" } },
        { id: "x", params: { type: "supercell" } },
      ],
      [{ source: "d", target: "x", targetHandle: "structure" }],
    );
    expect(collectFlowErrors(raw, noTools)).toEqual([]);
  });
});

describe("prepareGeneratedFlow", () => {
  it("completes the settings and keeps the model's layout", () => {
    const raw = flow([crystal(), slab()], [{ source: "c", target: "s", targetHandle: "bulk" }]);
    expect(prepareGeneratedFlow(raw, ctx)).toEqual({
      version: 1,
      nodes: [
        {
          id: "c",
          position: { x: 40, y: 40 },
          params: {
            type: "crystal",
            structure: "fcc",
            elements: ["Pt", "", ""],
            a: 3.92,
            covera: Math.sqrt(8 / 3),
            cubic: true,
          },
        },
        {
          id: "s",
          position: { x: 40, y: 190 },
          params: { type: "slab", miller: [1, 1, 1], layers: 4, vacuum: 10, repeat: [2, 2] },
        },
      ],
      edges: [{ source: "c", target: "s", targetHandle: "bulk" }],
    });
  });

  it("puts a setting a card could not draw back to its default", () => {
    const raw = flow([
      { id: "x", params: { type: "supercell", repeat: "2x2x2" } },
      crystal({ structure: "quasicrystal" }),
      { id: "m", params: { type: "molecule", source: "file", smiles: "O" } },
    ]);
    const nodes = prepareGeneratedFlow(raw, ctx)!.nodes;
    expect(nodes[0].params).toEqual({ type: "supercell", repeat: [2, 2, 2] });
    expect(nodes[1].params).toMatchObject({ structure: "fcc", elements: ["Pt", "", ""] });
    expect(nodes[2].params).toMatchObject({ source: "smiles", smiles: "O" });
  });

  it("leaves out wires into inputs that are not there, repeats and self-wires", () => {
    const raw = flow(
      [crystal(), slab(), water(), { id: "t", params: { type: "tool", tool: "nope" } }],
      [
        { source: "c", target: "s", targetHandle: "bulk" },
        { source: "c", target: "s", targetHandle: "bulk" },
        { source: "c", target: "s", targetHandle: "surface" },
        { source: "s", target: "s", targetHandle: "bulk" },
        { source: "w", target: "t", targetHandle: "anything" },
      ],
    );
    expect(prepareGeneratedFlow(raw, ctx)!.edges).toEqual([
      { source: "c", target: "s", targetHandle: "bulk" },
      // A tool that is not there keeps its wires; the finding names the tool.
      { source: "w", target: "t", targetHandle: "anything" },
    ]);
  });

  it("lays out blocks without a position by depth, and moves one off another", () => {
    const raw: RawFlow = {
      version: 1,
      nodes: [
        { id: "c", params: crystal().params },
        { id: "w", params: water().params },
        { id: "s", params: slab().params },
        { id: "a", position: { x: 40, y: 190 }, params: { type: "adsorb" } },
      ],
      edges: [
        { source: "c", target: "s", targetHandle: "bulk" },
        { source: "s", target: "a", targetHandle: "surface" },
        { source: "w", target: "a", targetHandle: "molecule" },
      ],
    };
    const positions = prepareGeneratedFlow(raw, ctx)!.nodes.map((n) => [n.id, n.position]);
    expect(positions).toEqual([
      ["c", { x: 40, y: 40 }],
      ["w", { x: 340, y: 40 }],
      ["s", { x: 40, y: 190 }],
      // The model put it where the slab now is: it moves down until free.
      ["a", { x: 40, y: 300 }],
    ]);
  });

  it("still places blocks that sit in a loop", () => {
    const raw: RawFlow = {
      version: 1,
      nodes: [
        { id: "x", params: { type: "supercell" } },
        { id: "y", params: { type: "supercell" } },
      ],
      edges: [
        { source: "x", target: "y", targetHandle: "structure" },
        { source: "y", target: "x", targetHandle: "structure" },
      ],
    };
    expect(prepareGeneratedFlow(raw, ctx)!.nodes).toHaveLength(2);
  });

  it("gives up on a flow it cannot hold", () => {
    expect(prepareGeneratedFlow(flow([]), ctx)).toBeNull();
    expect(prepareGeneratedFlow(flow([{ id: "a", params: { type: "warp" } }]), ctx)).toBeNull();
  });
});

describe("repair prompts", () => {
  it("lists the findings, capped, with the output shape", () => {
    const errors = Array.from({ length: MAX_REPORTED_FLOW_ERRORS + 3 }, (_, i) => `problem ${i}`);
    const prompt = buildFlowRepairPrompt(errors);
    expect(prompt).toContain("- problem 0");
    expect(prompt).not.toContain(`- problem ${MAX_REPORTED_FLOW_ERRORS}`);
    expect(prompt).toContain("- … and 3 more of the same kind");
    expect(prompt).toContain('{ "version": 1, "nodes": [...], "edges": [...] }');
    // The skeleton is not a flow, so echoing it applies nothing.
    expect(tryExtractFlow(prompt)).toBeNull();
    expect(buildFlowRepairPrompt(["one"])).not.toContain("more of the same kind");
  });

  it("asks again for a fence that holds no flow", () => {
    expect(buildUnparsableFlowPrompt()).toContain("not a usable flow");
  });
});

describe("diagnoseFlowResponse", () => {
  const good = JSON.stringify(flow([crystal()]));
  const bad = JSON.stringify(flow([slab()]));

  it("accepts a flow that checks out, and leaves prose alone", () => {
    expect(diagnoseFlowResponse(`\`\`\`json\n${good}\n\`\`\`\nBuilds Pt.`, ctx)).toBeNull();
    expect(diagnoseFlowResponse("Connect a tool server first.", ctx)).toBeNull();
  });

  it("asks for a fix with the findings", () => {
    const result = diagnoseFlowResponse(`\`\`\`json\n${bad}\n\`\`\``, ctx)!;
    expect(result.errors).toEqual([
      'block "s" (slab) needs a wire into its "bulk" input (Bulk crystal).',
    ]);
    expect(result.prompt).toContain(result.errors[0]);
  });

  it("asks again when the fence is not a flow", () => {
    const result = diagnoseFlowResponse('```json\n{"version": 1, "nodes": [}\n```', ctx)!;
    expect(result.prompt).toBe(buildUnparsableFlowPrompt());
    expect(result.errors).toEqual(["the fenced block is not valid, complete flow JSON"]);
  });
});
