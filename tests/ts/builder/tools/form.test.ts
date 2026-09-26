import { describe, it, expect } from "vitest";
import {
  buildArguments,
  findMolecule,
  initialValues,
  randomSeed,
  validate,
  type FormContext,
} from "@/builder/tools/form";
import { formFields, parseTools, type FieldSpec } from "@/builder/tools/contract";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import { structureToSnapshot } from "@/builder/tools/payload";
import { TOOLS } from "./fixtures";

const library = PRESET_MOLECULES;
const water = library.find((m) => m.id === "preset:water")!;
const ethanol = library.find((m) => m.id === "preset:ethanol")!;
const shown = structureToSnapshot({
  elements: [6],
  positions: [1, 2, 3],
  cell: [12, 0, 0, 0, 13, 0, 0, 0, 14],
  bonds: [],
});
const ctx: FormContext = { library, shown, selected: [0] };
const none: FormContext = { library: [], shown: null, selected: [] };
const tools = Object.fromEntries(parseTools(TOOLS).tools.map((t) => [t.name, t.fields!]));

function fieldsOf(properties: Record<string, unknown>, required: string[] = []): FieldSpec[] {
  return formFields({ type: "object", properties, required }).fields!;
}

describe("initial values", () => {
  it("prefills the reference tools", () => {
    const liquid = initialValues(tools.liquid_box, ctx);
    expect(liquid.components).toEqual([{ molecule: library[0].id, count: 100 }]);
    expect(liquid.density).toBe(1);
    expect(liquid.shape).toBe("cubic");
    expect(liquid.aspect).toEqual([1, 1, 1]);
    expect(Number.isInteger(liquid.seed)).toBe(true);
    const polymer = initialValues(tools.polymer_chain, ctx);
    expect([polymer.head, polymer.tail, polymer.length]).toEqual([0, 1, 10]);
    expect("document" in initialValues(tools.solvate, ctx)).toBe(false);
  });

  it("covers every kind", () => {
    const fields = fieldsOf({
      n: { type: "number" },
      i: { type: "integer" },
      m: { type: "number", minimum: 2.5 },
      k: { type: "integer", exclusiveMinimum: 0.5 },
      e: { type: "string", enum: ["a", "b"], default: "zzz" },
      s: { type: "string" },
      t: { type: "string", examples: ["hi"] },
      b: { type: "boolean" },
      v: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      v2: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, default: [3, 4] },
      g: { type: "object", properties: { x: { type: "boolean", default: true } } },
      rows: {
        type: "array",
        items: { type: "object", properties: { x: { type: "integer" } } },
        minItems: 2,
      },
      el: { type: "integer", "x-megane-widget": "element" },
      at: { type: "integer", "x-megane-widget": "atom", examples: [3] },
      c: { type: "array", "x-megane-widget": "cell" },
      sel: { type: "array", "x-megane-widget": "selection" },
    });
    const v = initialValues(fields, ctx);
    expect(v).toMatchObject({
      n: 0,
      i: 1,
      m: 2.5,
      k: 1,
      e: "a",
      s: "",
      t: "hi",
      b: false,
      v: [0, 0],
      v2: [3, 4],
    });
    expect(v.g).toEqual({ x: true });
    expect(v.rows).toEqual([{ x: 1 }, { x: 1 }]);
    expect(v).toMatchObject({ el: 6, at: 3, c: [12, 13, 14] });
    expect("sel" in v).toBe(false);
    expect(
      initialValues(
        fieldsOf({
          c: { type: "array", "x-megane-widget": "cell" },
          mol: { "x-megane-widget": "molecule" },
        }),
        none,
      ),
    ).toEqual({
      c: [20, 20, 20],
      mol: "",
    });
  });

  it("draws seeds in range", () => {
    const s = randomSeed();
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 31);
  });
});

describe("validation", () => {
  it("accepts the prefilled reference forms", () => {
    for (const name of ["liquid_box", "polymer_chain", "solvate"]) {
      expect(validate(tools[name], initialValues(tools[name], ctx), ctx)).toBeNull();
    }
  });

  it("reports the first problem", () => {
    const poly = tools.polymer_chain;
    const base = { ...initialValues(poly, ctx), monomer: ethanol.id };
    expect(validate(poly, { ...base, monomer: "nope" }, ctx)).toContain("Choose a molecule");
    expect(validate(poly, { ...base, head: 99 }, ctx)).toContain("must be an atom");
    expect(validate(poly, { ...base, seed: 1.5 }, ctx)).toContain("whole number");
    expect(validate(poly, { ...base, length: 0 }, ctx)).toContain("at least 1");
    expect(validate(poly, { ...base, length: 5000 }, ctx)).toContain("at most 200");
    expect(
      validate(tools.solvate, initialValues(tools.solvate, ctx), { ...ctx, shown: null }),
    ).toContain("open structure");

    const fields = fieldsOf(
      {
        x: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
        i: { type: "integer" },
        s: { type: "string" },
        v: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        c: { type: "array", "x-megane-widget": "cell" },
        rows: {
          type: "array",
          items: { type: "object", properties: { y: { type: "integer" } } },
          minItems: 1,
          maxItems: 1,
        },
        g: { type: "object", properties: { z: { type: "number" } } },
      },
      ["s"],
    );
    const ok = { x: 0.5, i: 1, s: "a", v: [1, 2], c: [1, 1, 1], rows: [{ y: 1 }], g: { z: 1 } };
    expect(validate(fields, ok, ctx)).toBeNull();
    expect(validate(fields, { ...ok, x: "no" }, ctx)).toContain("must be a number");
    expect(validate(fields, { ...ok, x: 0 }, ctx)).toContain("greater than 0");
    expect(validate(fields, { ...ok, x: 1 }, ctx)).toContain("less than 1");
    expect(validate(fields, { ...ok, i: 1.5 }, ctx)).toContain("whole number");
    expect(validate(fields, { ...ok, s: " " }, ctx)).toContain("required");
    expect(validate(fields, { ...ok, v: [1, Number.NaN] }, ctx)).toContain("needs numbers");
    expect(validate(fields, { ...ok, c: [1, 0, 1] }, ctx)).toContain("three positive");
    expect(validate(fields, { ...ok, rows: [] }, ctx)).toContain("at least 1");
    expect(validate(fields, { ...ok, rows: [{ y: 1 }, { y: 2 }] }, ctx)).toContain("at most 1");
    expect(validate(fields, { ...ok, rows: [{ y: 0.5 }] }, ctx)).toContain("whole number");
    expect(validate(fields, { ...ok, g: { z: "x" } }, ctx)).toContain("must be a number");
    expect(validate(fields, { ...ok, g: undefined, rows: undefined }, ctx)).toContain("at least 1");
  });

  it("checks an atom against the chosen molecule only when there is one", () => {
    const fields = fieldsOf({
      a: { type: "integer", "x-megane-widget": "atom", "x-megane-of": "m" },
    });
    expect(validate(fields, { a: 50 }, ctx)).toBeNull();
    expect(validate(fields, { a: -1 }, ctx)).toContain("must be an atom");
  });
});

describe("arguments", () => {
  it("fills widgets from the Builder", () => {
    const args = buildArguments(
      tools.solvate,
      { ...initialValues(tools.solvate, ctx), solvent: water.id },
      ctx,
    );
    expect(args.solvent).toMatchObject({ name: "Water" });
    expect((args.solvent as { molblock: string }).molblock).toContain("V2000");
    expect(args.document).toMatchObject({ elements: [6], cell: [12, 0, 0, 0, 13, 0, 0, 0, 14] });
    expect(
      buildArguments(tools.solvate, initialValues(tools.solvate, none), none),
    ).not.toHaveProperty("document");

    const fields = fieldsOf({
      sel: { type: "array", "x-megane-widget": "selection" },
      c: { type: "array", "x-megane-widget": "cell" },
      el: { type: "integer", "x-megane-widget": "element" },
      mol: { "x-megane-widget": "molecule" },
      g: { type: "object", properties: { x: { type: "integer" } } },
      rows: {
        type: "array",
        items: { type: "object", properties: { m: { "x-megane-widget": "molecule" } } },
      },
      n: { type: "number" },
    });
    const args2 = buildArguments(
      fields,
      { c: [1, 2, 3], el: 8, mol: "missing", g: { x: 2 }, rows: [{ m: water.id }], n: undefined },
      ctx,
    );
    expect(args2).toEqual({
      sel: [0],
      c: [1, 0, 0, 0, 2, 0, 0, 0, 3],
      el: 8,
      g: { x: 2 },
      rows: [{ m: expect.objectContaining({ name: "Water" }) }],
    });
    expect(buildArguments(fields, {}, ctx)).toEqual({ sel: [0], g: {}, rows: [] });
    expect(findMolecule(ctx, water.id)).toBe(water);
  });
});
