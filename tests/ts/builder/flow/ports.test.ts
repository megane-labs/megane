/** Which tool arguments become wires in Flow mode, and how wires fill the form. */

import { describe, it, expect } from "vitest";
import {
  asLibraryMolecule,
  blockPorts,
  completeToolParams,
  initialToolParams,
  rowFields,
  toolForm,
  toolPorts,
} from "@/builder/flow/ports";
import type { BuilderToolInfo, FieldSpec } from "@/builder/tools/contract";
import { tools, waterData } from "./helpers";

const field = (f: Partial<FieldSpec> & Pick<FieldSpec, "kind" | "key">): FieldSpec =>
  ({
    label: f.key,
    help: null,
    required: false,
    default: undefined,
    example: undefined,
    ...f,
  }) as FieldSpec;

describe("toolPorts", () => {
  it("makes a liquid box's components a table input", () => {
    const { ports, fields, problem } = toolPorts(tools.liquid_box);
    expect(problem).toBeNull();
    expect(ports).toEqual([
      {
        key: "components",
        label: "Components",
        multiple: true,
        required: true,
        kind: "molecule",
        column: "molecule",
      },
    ]);
    expect(fields.map((f) => f.key)).toEqual(["seed", "density", "shape", "aspect", "tolerance"]);
    expect(rowFields(tools.liquid_box, ports[0]).map((f) => f.key)).toEqual(["count"]);
  });

  it("makes solvate's structure and solvent single inputs", () => {
    const { ports } = toolPorts(tools.solvate);
    expect(ports.map((p) => [p.key, p.kind, p.multiple])).toEqual([
      ["document", "document", false],
      ["solvent", "molecule", false],
    ]);
    expect(rowFields(tools.solvate, ports[0])).toEqual([]);
  });

  it("keeps a polymer's atom fields as settings", () => {
    const { ports, fields } = toolPorts(tools.polymer_chain);
    expect(ports.map((p) => p.key)).toEqual(["monomer"]);
    expect(fields.map((f) => f.key)).toContain("head");
  });

  it("says why a tool cannot be a block", () => {
    const noForm = { ...tools.liquid_box, fields: null, formError: "oneOf" } as BuilderToolInfo;
    expect(toolPorts(noForm).problem).toBe("oneOf");
    expect(toolPorts({ ...noForm, formError: null }).problem).toBe("The tool has no form.");
    const grouped: BuilderToolInfo = {
      ...tools.liquid_box,
      fields: [
        field({
          kind: "group",
          key: "g",
          label: "Group",
          fields: [
            field({ kind: "widget", key: "m", widget: "molecule", of: null, unit: null } as never),
          ],
        } as never),
      ],
    };
    expect(toolPorts(grouped).problem).toContain("inside a group");
  });
});

describe("toolForm", () => {
  it("binds wires to the molecule column and keeps per-wire rows", () => {
    const params = {
      ...initialToolParams(tools.liquid_box),
      rows: { components: { a: { count: 5 } } },
    };
    const { ctx, values } = toolForm(
      tools.liquid_box,
      params,
      { components: ["a", "b"] },
      { a: waterData("water"), b: null },
    );
    expect(ctx.library.map((m) => m.id)).toEqual(["a"]);
    expect(values.components).toEqual([
      { count: 5, molecule: "a" },
      { count: 100, molecule: "b" },
    ]);
  });

  it("binds a single molecule input and the document input", () => {
    const params = initialToolParams(tools.solvate);
    const doc = waterData("doc");
    const { ctx, values } = toolForm(
      tools.solvate,
      params,
      { document: ["d"], solvent: ["s"] },
      { d: doc, s: waterData("water") },
    );
    expect(ctx.shown).toBe(doc.snapshot);
    expect(values.solvent).toBe("s");
    const empty = toolForm(tools.solvate, params, {}, {});
    expect(empty.values.solvent).toBe("");
    expect(empty.ctx.shown).toBeNull();
  });

  it("lists a molecule wired to two inputs once", () => {
    const { ctx } = toolForm(
      tools.liquid_box,
      initialToolParams(tools.liquid_box),
      { components: ["a", "a"] },
      { a: waterData() },
    );
    expect(ctx.library).toHaveLength(1);
  });
});

describe("asLibraryMolecule / initialToolParams / blockPorts", () => {
  it("turns a wire's structure into a library molecule", () => {
    const m = asLibraryMolecule("n1", waterData("water"));
    expect(m).toMatchObject({ id: "n1", name: "water", formula: "H2O", elements: [8, 1, 1] });
  });

  it("starts a tool block with its defaults", () => {
    const p = initialToolParams(tools.liquid_box);
    expect(p).toMatchObject({ type: "tool", tool: "liquid_box", label: "Liquid box", rows: {} });
    expect(p.values.density).toBe(1);
    expect(p.values).not.toHaveProperty("components");
  });

  it("gives tool blocks their inputs, and keeps wired ones without a server", () => {
    expect(blockPorts({ type: "document" }, null, [])).toEqual([]);
    const params = initialToolParams(tools.liquid_box);
    expect(blockPorts(params, tools.liquid_box, []).map((p) => p.key)).toEqual(["components"]);
    expect(blockPorts(params, null, ["components", "components"])).toEqual([
      expect.objectContaining({ key: "components", multiple: true }),
    ]);
  });
});

describe("built-in ports and tool defaults", () => {
  it("gives a built-in block its fixed inputs", () => {
    expect(
      blockPorts({ type: "adsorb", height: 2, grid: [1, 1] }, null, ["nope"]).map((p) => p.key),
    ).toEqual(["surface", "molecule"]);
    expect(blockPorts({ type: "document" }, null, ["x"])).toEqual([]);
  });

  it("fills only the settings a tool block lacks", () => {
    const sparse = {
      type: "tool" as const,
      tool: "liquid_box",
      label: "",
      values: { density: 0.8 },
      rows: {},
    };
    const filled = completeToolParams(sparse, tools.liquid_box);
    expect(filled.values).toMatchObject({ density: 0.8, shape: "cubic", tolerance: 2 });
    expect(typeof filled.values.seed).toBe("number");
    expect(completeToolParams(filled, tools.liquid_box)).toBe(filled);
  });
});
