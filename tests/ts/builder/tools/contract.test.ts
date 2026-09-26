import { describe, it, expect } from "vitest";
import {
  META_KEY,
  callTimeoutMs,
  firstSentence,
  formFields,
  parseResult,
  parseTool,
  parseTools,
  resolveRef,
  sanitizeName,
  unitLabel,
  validateStructure,
  ResultError,
  type BuilderToolInfo,
  type FieldSpec,
  type McpTool,
} from "@/builder/tools/contract";
import { CALLS, TOOLS } from "./fixtures";

const marker = (over: Record<string, unknown> = {}) => ({
  [META_KEY]: {
    contract: 1,
    category: "bulk",
    apply: "new_document",
    document: "none",
    stochastic: false,
    ...over,
  },
});

function tool(over: Partial<McpTool> = {}): McpTool {
  return {
    name: "t",
    description: "Does it. More text.",
    inputSchema: { type: "object", properties: {} },
    _meta: marker(),
    ...over,
  };
}

describe("parseTools on the reference server", () => {
  const listing = parseTools(TOOLS);
  const byName = Object.fromEntries(listing.tools.map((t) => [t.name, t])) as Record<
    string,
    BuilderToolInfo
  >;

  it("finds the three tools with their markers", () => {
    expect(listing.tools.map((t) => t.name)).toEqual(["liquid_box", "polymer_chain", "solvate"]);
    expect(listing.unsupported).toEqual([]);
    expect(byName.liquid_box).toMatchObject({
      label: "Liquid box",
      category: "bulk",
      apply: "new_document",
      stochastic: true,
    });
    expect(byName.solvate).toMatchObject({
      apply: "insert",
      document: "required",
      category: "solvation",
    });
    expect(byName.polymer_chain.expectedSeconds).toBe(60);
    expect(byName.liquid_box.tooltip).toBe(
      "Fill a periodic box with molecules at a target density using packmol.",
    );
  });

  it("builds every form", () => {
    for (const t of listing.tools) expect(t.formError).toBeNull();
    const components = byName.liquid_box.fields!.find((f) => f.key === "components")!;
    expect(components.kind).toBe("table");
    const columns = (components as Extract<FieldSpec, { kind: "table" }>).columns;
    expect(columns.map((c) => [c.key, c.kind])).toEqual([
      ["molecule", "widget"],
      ["count", "number"],
    ]);
    expect(columns[1].example).toBe(100);
    const head = byName.polymer_chain.fields!.find((f) => f.key === "head")!;
    expect(head).toMatchObject({ kind: "widget", widget: "atom", of: "monomer" });
    const monomer = byName.polymer_chain.fields!.find((f) => f.key === "monomer")!;
    expect(monomer.help).toBeNull();
    const density = byName.liquid_box.fields!.find((f) => f.key === "density")!;
    expect(density).toMatchObject({
      kind: "number",
      unit: "g/cm3",
      exclusiveMin: true,
      min: 0,
      default: 1,
    });
    const doc = byName.solvate.fields!.find((f) => f.key === "document")!;
    expect(doc).toMatchObject({ kind: "widget", widget: "document", required: true });
  });
});

describe("parseTool", () => {
  it("skips plain tools and flags unsupported contracts", () => {
    expect(parseTool(tool({ _meta: undefined }))).toBeNull();
    expect(parseTool(tool({ _meta: { [META_KEY]: "x" } }))).toBeNull();
    expect(parseTool(tool({ _meta: marker({ contract: 2 }) }))).toBe("unsupported");
    expect(parseTool(tool({ _meta: marker({ apply: "replace" }) }))).toBe("unsupported");
    const listing = parseTools([
      tool({ name: "a" }),
      tool({ name: "b", _meta: marker({ contract: 9 }) }),
      tool({ name: "c", _meta: {} }),
    ]);
    expect(listing.tools.map((t) => t.name)).toEqual(["a"]);
    expect(listing.unsupported).toEqual(["b"]);
  });

  it("falls back for labels, categories and document use", () => {
    const info = parseTool(
      tool({
        title: undefined,
        annotations: { title: "Annotated" },
        _meta: marker({ category: "weird", document: "x", expectedSeconds: -1 }),
      }),
    ) as BuilderToolInfo;
    expect(info.label).toBe("Annotated");
    expect(info.category).toBe("other");
    expect(info.document).toBe("none");
    expect(info.expectedSeconds).toBeNull();
    const bare = parseTool(
      tool({
        description: undefined,
        inputSchema: undefined as never,
        _meta: marker({ apply: "insert" }),
      }),
    ) as BuilderToolInfo;
    expect(bare.label).toBe("t");
    expect(bare.apply).toBe("insert");
    expect(bare.formError).toBe("the input schema is not an object");
  });
});

describe("formFields", () => {
  const form = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    formFields({ type: "object", properties, ...extra });

  it("maps the supported subset", () => {
    const { fields, error } = form(
      {
        n: { type: "integer", minimum: 2, maximum: 9, title: "N", description: "help" },
        e: { type: "string", enum: ["a", "b"] },
        s: { type: "string", maxLength: 4 },
        b: { type: "boolean", default: true },
        v: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
          "x-megane-unit": "angstrom",
        },
        g: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        rows: { type: "array", items: { $ref: "#/$defs/Row" }, minItems: 1, maxItems: 4 },
        w: { type: "integer", "x-megane-widget": "seed" },
      },
      {
        required: ["n"],
        $defs: { Row: { type: "object", properties: { k: { type: "integer" } } } },
      },
    );
    expect(error).toBeNull();
    const byKey = Object.fromEntries(fields!.map((f) => [f.key, f]));
    expect(byKey.n).toMatchObject({
      kind: "number",
      integer: true,
      min: 2,
      max: 9,
      label: "N",
      help: "help",
      required: true,
    });
    expect(byKey.e).toMatchObject({ kind: "enum", options: ["a", "b"] });
    expect(byKey.s).toMatchObject({ kind: "string", maxLength: 4 });
    expect(byKey.b).toMatchObject({ kind: "boolean", default: true, required: false });
    expect(byKey.v).toMatchObject({ kind: "vector", length: 3, unit: "angstrom" });
    expect(byKey.g).toMatchObject({ kind: "group" });
    expect(byKey.rows).toMatchObject({ kind: "table", minItems: 1, maxItems: 4 });
    expect(byKey.w).toMatchObject({ kind: "widget", widget: "seed", of: null });
    expect(form({ s: { type: "string" } }).fields![0]).toMatchObject({ maxLength: null });
    expect(form({ x: { type: "number", exclusiveMaximum: 3 } }).fields![0]).toMatchObject({
      max: 3,
      exclusiveMax: true,
      min: null,
    });
  });

  it.each([
    [{ anyOf: [{ type: "string" }, { type: "null" }] }, "uses anyOf"],
    [{ type: "array", items: { type: "number" }, minItems: 2 }, "fixed length"],
    [{ type: "array", items: { type: "number" }, minItems: 12, maxItems: 12 }, "fixed length"],
    [{ type: "array", items: { type: "string" } }, "array of string"],
    [{ type: "array" }, "array of unknown"],
    [
      { type: "object", properties: { inner: { type: "object", properties: {} } } },
      "nests objects",
    ],
    [
      {
        type: "array",
        items: { type: "object", properties: { t: { type: "array", items: { type: "object" } } } },
      },
      "nests tables",
    ],
    [{ type: "null" }, "unsupported type"],
  ])("refuses %j", (prop, message) => {
    const { fields, error } = form({ p: prop });
    expect(fields).toBeNull();
    expect(error).toContain(message);
  });

  it("rethrows unexpected errors", () => {
    const evil = {
      type: "object",
      get properties(): never {
        throw new TypeError("boom");
      },
    };
    expect(() => formFields(evil)).toThrow("boom");
  });
});

describe("helpers", () => {
  it("resolves chained local refs and ignores remote ones", () => {
    const root = { $defs: { A: { $ref: "#/$defs/B", title: "A" }, B: { type: "integer" } } };
    expect(resolveRef({ $ref: "#/$defs/A", description: "d" }, root)).toEqual({
      type: "integer",
      title: "A",
      description: "d",
    });
    expect(resolveRef({ $ref: "https://x/y" }, root)).toEqual({ $ref: "https://x/y" });
    expect(resolveRef({ $ref: "#/$defs/Missing" }, root)).toEqual({});
  });

  it("labels units and sentences", () => {
    expect(
      [null, "count", "angstrom", "degree", "g/cm3", "kelvin", "mol/L"].map(unitLabel),
    ).toEqual(["", "", "Å", "°", "g/cm³", "K", "mol/L"]);
    expect(firstSentence("  One two. Three.")).toBe("One two.");
    expect(firstSentence("No period\nsecond line")).toBe("No period");
  });

  it("computes timeouts and names", () => {
    expect(callTimeoutMs(null)).toBe(60_000);
    expect(callTimeoutMs(60)).toBe(300_000);
    expect(callTimeoutMs(10_000)).toBe(1_800_000);
    expect(sanitizeName("water / ethanol")).toBe("water-ethanol");
    expect(sanitizeName("***")).toBe("result");
  });
});

describe("results", () => {
  const water = {
    elements: [8, 1, 1],
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    cell: null,
    bonds: [
      [0, 1],
      [0, 2],
    ],
  };

  it("accepts the recorded results", () => {
    for (const call of Object.values(CALLS)) {
      const r = parseResult(call.result.structuredContent);
      expect(r.contract).toBe(1);
      expect(r.structure.elements.length).toBeGreaterThan(0);
    }
    const r = parseResult({ contract: 1, name: " ", structure: water, warnings: ["w", 3] });
    expect(r.name).toBe("result");
    expect(r.warnings).toEqual(["w"]);
    expect(r.provenance).toEqual({});
  });

  it.each([
    [null, "no structured result"],
    [{ contract: 7, structure: water }, "unsupported result contract"],
    [{ contract: 1 }, "structure is missing"],
  ])("rejects %j", (raw, message) => {
    expect(() => parseResult(raw)).toThrow(message);
  });

  it.each([
    [{ elements: "x" }, "elements must be an array"],
    [{ elements: [0, 1, 1] }, "atomic numbers"],
    [{ positions: [0] }, "positions has 1"],
    [{ cell: [1] }, "cell must have 9"],
    [{ bonds: "x" }, "bonds must be an array"],
    [{ bonds: [[0, 0]] }, "does not join"],
    [{ bonds: [[0, 5]] }, "does not join"],
    [{ bondOrders: [1] }, "bondOrders"],
    [{ bondOrders: [1, 7] }, "bondOrders"],
    [{ molecules: [0, 0] }, "molecules"],
    [{ molecules: [0, 0, -1] }, "molecules"],
    [{ chainIds: ["A", "A", "BB"] }, "chainIds"],
    [{ scalars: [] }, "scalars must be an object"],
    [{ scalars: { q: [1] } }, "scalar channel q"],
  ])("validates structure field %j", (over, message) => {
    expect(() => validateStructure({ ...water, ...over })).toThrow(message);
  });

  it("keeps optional channels and drops absent ones", () => {
    const s = validateStructure({
      ...water,
      cell: [5, 0, 0, 0, 5, 0, 0, 0, 5],
      bondOrders: [1, 2],
      molecules: [0, 0, 0],
      residueNames: ["W", "W", "W"],
      residueIds: [1, 1, 1],
      atomNames: ["O", "H1", "H2"],
      chainIds: ["A", "A", "A"],
      formalCharges: [0, 0, 0],
      scalars: { q: [-0.8, 0.4, 0.4] },
    });
    expect(Object.keys(s).sort()).toEqual(
      [
        "atomNames",
        "bondOrders",
        "bonds",
        "cell",
        "chainIds",
        "elements",
        "formalCharges",
        "molecules",
        "positions",
        "residueIds",
        "residueNames",
        "scalars",
      ].sort(),
    );
    expect(Object.keys(validateStructure(water)).sort()).toEqual([
      "bonds",
      "cell",
      "elements",
      "positions",
    ]);
  });

  it("caps the size", () => {
    const big = { elements: new Array(500_001).fill(1), positions: [], cell: null, bonds: [] };
    expect(() => validateStructure(big)).toThrow(ResultError);
  });
});
