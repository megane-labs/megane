/** What the Flow assistant tells the model: the system prompt and each wrapped request. */

import { describe, it, expect } from "vitest";
import {
  MAX_LISTED_MOLECULES,
  buildFlowEditRequest,
  buildFlowSystemPrompt,
  compactFlow,
  describeField,
  type FlowPromptContext,
} from "@/builder/flow/ai/prompt";
import { FLOW_TEMPLATES } from "@/builder/flow/templates";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import type { BuilderToolInfo, FieldSpec } from "@/builder/tools/contract";
import type { SerializedFlow } from "@/builder/flow/store";
import { tools } from "../helpers";

const base: FlowPromptContext = {
  library: [...PRESET_MOLECULES],
  tools: Object.values(tools),
  hostHasTools: true,
  document: null,
};

describe("buildFlowSystemPrompt", () => {
  it("describes every block with its defaults and inputs", () => {
    const prompt = buildFlowSystemPrompt(base);
    for (const type of [
      "molecule",
      "document",
      "crystal",
      "polymer",
      "supercell",
      "slab",
      "adsorb",
      "tool",
    ]) {
      expect(prompt).toContain(`### ${type}\n`);
    }
    expect(prompt).toContain(
      '`{"type":"slab","miller":[1,1,1],"layers":4,"vacuum":10,"repeat":[2,2]}`',
    );
    expect(prompt).toContain("- Inputs: `bulk` (bulk crystal, one wire, required).");
    expect(prompt).toContain("`surface` (surface, one wire, required), `molecule` (molecule");
    expect(prompt).toContain('- "rocksalt": Rocksalt (AB), 2 species, cubic cell available');
    expect(prompt).toContain("Pt (fcc) a=3.92");
    expect(prompt).toContain('Polystyrene (PS) "*CC(c1ccccc1)*"');
  });

  it("lists the library molecules by id, capped", () => {
    expect(buildFlowSystemPrompt(base)).toContain('- "preset:water": Water (H2O)');
    const many = Array.from({ length: MAX_LISTED_MOLECULES + 2 }, (_, i) => ({
      ...PRESET_MOLECULES[0],
      id: `user:${i}`,
    }));
    const prompt = buildFlowSystemPrompt({ ...base, library: many });
    expect(prompt).toContain(`"user:${MAX_LISTED_MOLECULES - 1}"`);
    expect(prompt).not.toContain(`"user:${MAX_LISTED_MOLECULES}"`);
    expect(prompt).toContain("- … and 2 more");
    expect(buildFlowSystemPrompt({ ...base, library: [] })).toContain("The library is empty");
  });

  it("says what is open in Manual mode", () => {
    expect(buildFlowSystemPrompt(base)).toContain("Manual mode has no structure open.");
    const prompt = buildFlowSystemPrompt({
      ...base,
      document: { name: "slab.cif", atoms: 96, cell: true },
    });
    expect(prompt).toContain('Manual mode has "slab.cif" open: 96 atoms, with a unit cell.');
    expect(
      buildFlowSystemPrompt({ ...base, document: { name: "m.mol", atoms: 3, cell: false } }),
    ).toContain("without a unit cell");
  });

  it("describes the connected server's tools and their inputs", () => {
    const prompt = buildFlowSystemPrompt(base);
    expect(prompt).toContain('#### "liquid_box" — Liquid box');
    expect(prompt).toMatch(
      /Input `components` \(Components, required\): any number of wires.*`count`: integer/,
    );
    expect(prompt).toContain("`density`: number in g/cm3 (> 0, ≤ 5), default 1");
    expect(prompt).toContain('`shape`: one of "cubic" | "orthorhombic", default "cubic"');
    expect(prompt).toContain(
      "Input `document` (Structure, required): one wire, the structure the tool works on.",
    );
    expect(prompt).toContain("Result: the structure wired into its document input");
    // Every template whose tools are there is an example.
    for (const t of FLOW_TEMPLATES) expect(prompt).toContain(`User request: "${t.description}"`);
  });

  it("keeps tool blocks out when no server is connected or none can be", () => {
    const none = buildFlowSystemPrompt({ ...base, tools: null });
    expect(none).toContain("No tool server is connected, so a tool block cannot run");
    expect(none).not.toContain('#### "liquid_box"');
    // Only the templates that run in the browser remain as examples.
    for (const t of FLOW_TEMPLATES) {
      expect(none.includes(`User request: "${t.description}"`), t.id).toBe(t.tools.length === 0);
    }
    expect(buildFlowSystemPrompt({ ...base, tools: null, hostHasTools: false })).toContain(
      "This Builder cannot reach tool servers: never use a tool block.",
    );
    const broken: BuilderToolInfo = { ...tools.liquid_box, fields: null, formError: "Bad." };
    expect(buildFlowSystemPrompt({ ...base, tools: [broken] })).toContain(
      "The connected tool server offers no tool Flow mode can use.",
    );
  });

  it("lists a tool with no inputs or settings, and leaves out one that cannot be a block", () => {
    const bare: BuilderToolInfo = {
      ...tools.liquid_box,
      name: "bare",
      label: "Bare",
      description: "",
      fields: [],
      apply: "new_document",
    };
    const broken: BuilderToolInfo = { ...tools.solvate, name: "broken", fields: null };
    const prompt = buildFlowSystemPrompt({ ...base, tools: [bare, broken] });
    expect(prompt).not.toContain('"broken"');
    expect(prompt).toContain(
      '#### "bare" — Bare\n- No inputs.\n- No settings.\n- Result: a new structure.',
    );
  });
});

describe("describeField", () => {
  const field = (extra: Partial<FieldSpec> & { kind: FieldSpec["kind"] }) =>
    ({
      key: "k",
      label: "K",
      help: null,
      required: false,
      default: undefined,
      example: undefined,
      ...extra,
    }) as FieldSpec;

  it("says each kind of field in a line", () => {
    expect(
      describeField(
        field({
          kind: "number",
          integer: true,
          min: 0,
          max: 10,
          exclusiveMin: true,
          exclusiveMax: true,
          unit: null,
        } as Partial<FieldSpec> & { kind: "number" }),
      ),
    ).toBe("`k`: integer (> 0, < 10)");
    expect(describeField(field({ kind: "string", maxLength: null, required: true }))).toBe(
      "`k`: string, required",
    );
    expect(describeField(field({ kind: "boolean", default: true }))).toBe(
      "`k`: true or false, default true",
    );
    expect(
      describeField(
        field({ kind: "vector", length: 3, integer: true, unit: "Å", example: [1, 1, 1] }),
      ),
    ).toBe("`k`: array of 3 integers in Å, default [1,1,1]");
    expect(
      describeField(
        field({
          kind: "table",
          columns: [field({ kind: "boolean", key: "on" })],
          minItems: 0,
          maxItems: null,
        }),
      ),
    ).toBe("`k`: array of rows { `on`: true or false }");
    expect(
      describeField(field({ kind: "group", fields: [field({ kind: "boolean", key: "x" })] })),
    ).toBe("`k`: object { `x`: true or false }");
    const widget = (w: string) =>
      describeField(field({ kind: "widget", widget: w, of: null, unit: null } as never));
    expect(widget("element")).toBe("`k`: atomic number");
    expect(widget("seed")).toBe("`k`: integer random seed");
    expect(widget("cell")).toBe("`k`: [a, b, c] box lengths in Å");
    expect(widget("atom")).toBe("`k`: atom index");
    expect(widget("molecule")).toBe("`k`: molecule");
    expect(describeField(field({ kind: "boolean", help: `${"long ".repeat(40)}end` }))).toMatch(
      /— (long ){23}long…$/,
    );
  });
});

describe("buildFlowEditRequest", () => {
  const flow: SerializedFlow = {
    version: 1,
    nodes: [
      {
        id: "n1",
        position: { x: 40.4, y: 39.6 },
        params: { type: "supercell", repeat: [2, 2, 2] },
      },
      { id: "n2", position: { x: 40, y: 190 }, params: { type: "document" } },
    ],
    edges: [{ source: "n2", target: "n1", targetHandle: "structure" }],
  };

  it("sends a request with nothing around it as it is", () => {
    expect(
      buildFlowEditRequest("make NaCl", { flow: null, selectedNodeIds: [], history: [] }),
    ).toBe("make NaCl");
    expect(
      buildFlowEditRequest("make NaCl", {
        flow: { version: 1, nodes: [], edges: [] },
        selectedNodeIds: [],
        history: [],
      }),
    ).toBe("make NaCl");
  });

  it("restates the conversation, the flow and the selection", () => {
    const text = buildFlowEditRequest("make it 3", {
      flow,
      selectedNodeIds: ["n1"],
      history: [
        { role: "user", content: "a supercell of my structure" },
        { role: "assistant", content: "Repeats it 2 × 2 × 2." },
      ],
    });
    expect(text).toContain(
      "## Conversation so far\n\nUser: a supercell of my structure\nYou: Repeats it 2 × 2 × 2.",
    );
    expect(text).toContain("## Current flow");
    expect(text).toContain(JSON.stringify(compactFlow(flow)));
    expect(text).toContain('"position":{"x":40,"y":40}');
    expect(text).toContain("Selected in the graph: `n1` (supercell).");
    expect(text.endsWith("## Request\n\nmake it 3")).toBe(true);
  });

  it("leaves out the selection line when nothing is selected", () => {
    const text = buildFlowEditRequest("go", { flow, selectedNodeIds: [], history: [] });
    expect(text).not.toContain("Selected in the graph");
  });
});
