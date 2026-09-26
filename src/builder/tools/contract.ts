/**
 * The client side of the Builder Tool Contract (docs/docs/dev/builder-tools.md).
 *
 * Pure functions over what an MCP server sends: which tools are Builder
 * buttons (§3), the form a tool's `inputSchema` turns into (§4.1, §4.2), and
 * the validation a `BuilderResult` must pass before anything is applied
 * (§5, §6). Section numbers refer to that page. Nothing here talks to a
 * server or touches the Builder store.
 */

/** Contract versions this Builder implements (§11). */
export const SUPPORTED_CONTRACTS: readonly number[] = [1];

/** `Tool._meta` key that turns an MCP tool into a Builder button (§3). */
export const META_KEY = "io.github.megane-labs/builder";

const WIDGET_KEY = "x-megane-widget";
const UNIT_KEY = "x-megane-unit";
const OF_KEY = "x-megane-of";

/** Largest structure Builder accepts in one result (§5.1). */
export const MAX_RESULT_ATOMS = 500_000;

export type ToolCategory = "bulk" | "molecule" | "polymer" | "surface" | "solvation" | "other";
export type ApplyMode = "new_document" | "insert";
export type DocumentUse = "none" | "optional" | "required";

const CATEGORIES: readonly ToolCategory[] = [
  "bulk",
  "molecule",
  "polymer",
  "surface",
  "solvation",
  "other",
];

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  bulk: "Bulk",
  molecule: "Molecule",
  polymer: "Polymer",
  surface: "Surface",
  solvation: "Solvation",
  other: "Other",
};

type Json = Record<string, unknown>;

/** The subset of an MCP `Tool` this module reads. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Json;
  _meta?: Json;
  annotations?: { title?: string };
}

/** A tool that is a Builder button, with its marker and its form. */
export interface BuilderToolInfo {
  name: string;
  /** Button label: `title`, else `annotations.title`, else the name. */
  label: string;
  /** First sentence of the description (the tooltip). */
  tooltip: string;
  description: string;
  category: ToolCategory;
  apply: ApplyMode;
  document: DocumentUse;
  stochastic: boolean;
  expectedSeconds: number | null;
  inputSchema: Json;
  /** The generated form, or null with `formError` when the schema is outside §4.1. */
  fields: FieldSpec[] | null;
  formError: string | null;
}

/** Tools a server offers, sorted into Builder buttons and the ones Builder skips. */
export interface ToolListing {
  tools: BuilderToolInfo[];
  /** Tools marked for a contract version Builder does not support. */
  unsupported: string[];
}

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The first sentence of a description (up to the first ". " or line break). */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^(.+?[.!?])(\s|$)/s.exec(trimmed);
  const sentence = match ? match[1] : trimmed.split("\n")[0];
  return sentence.replace(/\s+/g, " ");
}

/** Read one tool: a BuilderToolInfo, "unsupported", or null when it is not a Builder tool. */
export function parseTool(tool: McpTool): BuilderToolInfo | "unsupported" | null {
  const marker = tool._meta?.[META_KEY];
  if (!isObject(marker)) return null;
  if (typeof marker.contract !== "number" || !SUPPORTED_CONTRACTS.includes(marker.contract)) {
    return "unsupported";
  }
  const category = CATEGORIES.includes(marker.category as ToolCategory)
    ? (marker.category as ToolCategory)
    : "other";
  const apply =
    marker.apply === "insert" ? "insert" : marker.apply === "new_document" ? "new_document" : null;
  if (!apply) return "unsupported";
  const document: DocumentUse =
    marker.document === "required" || marker.document === "optional" ? marker.document : "none";
  const expected = marker.expectedSeconds;
  const description = typeof tool.description === "string" ? tool.description : "";
  const { fields, error } = formFields(tool.inputSchema ?? {});
  return {
    name: tool.name,
    label: tool.title || tool.annotations?.title || tool.name,
    tooltip: firstSentence(description),
    description,
    category,
    apply,
    document,
    stochastic: marker.stochastic === true,
    expectedSeconds: typeof expected === "number" && expected > 0 ? expected : null,
    inputSchema: tool.inputSchema ?? {},
    fields,
    formError: error,
  };
}

/** Sort a `tools/list` result into Builder buttons (in server order) and skipped tools. */
export function parseTools(tools: McpTool[]): ToolListing {
  const out: ToolListing = { tools: [], unsupported: [] };
  for (const tool of tools) {
    const parsed = parseTool(tool);
    if (parsed === "unsupported") out.unsupported.push(tool.name);
    else if (parsed) out.tools.push(parsed);
  }
  return out;
}

// ── Forms (§4.1, §4.2) ──

export type Widget = "molecule" | "atom" | "element" | "cell" | "selection" | "seed" | "document";

interface FieldBase {
  /** Property name. */
  key: string;
  label: string;
  help: string | null;
  required: boolean;
  default: unknown;
  /** First JSON Schema example, if any. */
  example: unknown;
}

export type FieldSpec =
  | (FieldBase & {
      kind: "number";
      integer: boolean;
      min: number | null;
      max: number | null;
      exclusiveMin: boolean;
      exclusiveMax: boolean;
      unit: string | null;
    })
  | (FieldBase & { kind: "enum"; options: string[] })
  | (FieldBase & { kind: "string"; maxLength: number | null })
  | (FieldBase & { kind: "boolean" })
  | (FieldBase & { kind: "vector"; length: number; integer: boolean; unit: string | null })
  | (FieldBase & { kind: "table"; columns: FieldSpec[]; minItems: number; maxItems: number | null })
  | (FieldBase & { kind: "group"; fields: FieldSpec[] })
  | (FieldBase & { kind: "widget"; widget: Widget; of: string | null; unit: string | null });

const WIDGETS: readonly Widget[] = [
  "molecule",
  "atom",
  "element",
  "cell",
  "selection",
  "seed",
  "document",
];

const UNSUPPORTED_KEYWORDS = ["oneOf", "anyOf", "allOf", "if", "not"];

/** Follow a local `$ref` (`#/$defs/...`), keeping the referring schema's own keys. */
export function resolveRef(schema: Json, root: Json): Json {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  let target: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    target = isObject(target) ? target[part] : undefined;
  }
  const rest = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$ref"));
  const merged = { ...(isObject(target) ? target : {}), ...rest };
  return isObject(target) && typeof target.$ref === "string" ? resolveRef(merged, root) : merged;
}

class FormError extends Error {}

function fieldFrom(
  key: string,
  raw: Json,
  root: Json,
  required: boolean,
  depth: number,
): FieldSpec {
  const schema = resolveRef(raw, root);
  const examples = Array.isArray(schema.examples) ? schema.examples : [];
  const base: FieldBase = {
    key,
    label: typeof schema.title === "string" ? schema.title : key,
    // A `$ref`'d definition's description documents the type, not this field.
    help:
      typeof raw.description === "string"
        ? raw.description
        : raw.$ref === undefined && typeof schema.description === "string"
          ? schema.description
          : null,
    required,
    default: schema.default,
    example: examples.length > 0 ? examples[0] : undefined,
  };
  const unit = typeof schema[UNIT_KEY] === "string" ? (schema[UNIT_KEY] as string) : null;
  const widget = schema[WIDGET_KEY];
  if (typeof widget === "string" && WIDGETS.includes(widget as Widget)) {
    const of = typeof schema[OF_KEY] === "string" ? (schema[OF_KEY] as string) : null;
    return { ...base, kind: "widget", widget: widget as Widget, of, unit };
  }
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in schema) throw new FormError(`"${key}" uses ${keyword}`);
  }
  const type = schema.type;
  if (type === "number" || type === "integer") {
    const exMin = typeof schema.exclusiveMinimum === "number";
    const exMax = typeof schema.exclusiveMaximum === "number";
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      ...base,
      kind: "number",
      integer: type === "integer",
      min: exMin ? (schema.exclusiveMinimum as number) : num(schema.minimum),
      max: exMax ? (schema.exclusiveMaximum as number) : num(schema.maximum),
      exclusiveMin: exMin,
      exclusiveMax: exMax,
      unit,
    };
  }
  if (type === "string") {
    if (Array.isArray(schema.enum)) {
      return { ...base, kind: "enum", options: schema.enum.map(String) };
    }
    return {
      ...base,
      kind: "string",
      maxLength: typeof schema.maxLength === "number" ? schema.maxLength : null,
    };
  }
  if (type === "boolean") return { ...base, kind: "boolean" };
  if (type === "array") {
    const items = resolveRef(isObject(schema.items) ? schema.items : {}, root);
    if (items.type === "number" || items.type === "integer") {
      const n = schema.minItems;
      if (typeof n !== "number" || n !== schema.maxItems || n > 9) {
        throw new FormError(`"${key}" is a number array without a fixed length of at most 9`);
      }
      return { ...base, kind: "vector", length: n, integer: items.type === "integer", unit };
    }
    if (items.type === "object") {
      if (depth >= 1) throw new FormError(`"${key}" nests tables`);
      return {
        ...base,
        kind: "table",
        columns: objectFields(items, root, depth + 1),
        minItems: typeof schema.minItems === "number" ? schema.minItems : 0,
        maxItems: typeof schema.maxItems === "number" ? schema.maxItems : null,
      };
    }
    throw new FormError(`"${key}" is an array of ${String(items.type ?? "unknown")}`);
  }
  if (type === "object") {
    if (depth >= 1) throw new FormError(`"${key}" nests objects more than one level`);
    return { ...base, kind: "group", fields: objectFields(schema, root, depth + 1) };
  }
  throw new FormError(`"${key}" has an unsupported type ${String(type)}`);
}

function objectFields(schema: Json, root: Json, depth: number): FieldSpec[] {
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(props).map(([key, prop]) =>
    fieldFrom(key, isObject(prop) ? prop : {}, root, required.has(key), depth),
  );
}

/** The form for a tool's `inputSchema`, or an error naming what Builder cannot render. */
export function formFields(inputSchema: Json): {
  fields: FieldSpec[] | null;
  error: string | null;
} {
  if (inputSchema.type !== "object") {
    return { fields: null, error: "the input schema is not an object" };
  }
  try {
    return { fields: objectFields(inputSchema, inputSchema, 0), error: null };
  } catch (err) {
    if (err instanceof FormError) return { fields: null, error: err.message };
    throw err;
  }
}

/** Display suffix for a canonical unit (§4.4); unknown units are shown verbatim. */
export function unitLabel(unit: string | null): string {
  switch (unit) {
    case null:
    case "count":
      return "";
    case "angstrom":
      return "Å";
    case "degree":
      return "°";
    case "g/cm3":
      return "g/cm³";
    case "kelvin":
      return "K";
    default:
      return unit;
  }
}

// ── Results (§5) ──

/** The structure payload (§5.1), validated. */
export interface StructurePayload {
  elements: number[];
  positions: number[];
  cell: number[] | null;
  bonds: [number, number][];
  bondOrders?: number[];
  molecules?: number[];
  residueNames?: string[];
  residueIds?: number[];
  atomNames?: string[];
  chainIds?: string[];
  formalCharges?: number[];
  scalars?: Record<string, number[]>;
}

export interface BuilderResult {
  contract: number;
  name: string;
  structure: StructurePayload;
  warnings: string[];
  provenance: Json;
}

export class ResultError extends Error {}

function fail(message: string): never {
  throw new ResultError(message);
}

function numberArray(v: unknown, what: string): number[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    fail(`${what} must be an array of numbers`);
  }
  return v as number[];
}

function perAtom<T>(
  v: unknown,
  n: number,
  what: string,
  check: (x: unknown) => boolean,
): T[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length !== n || !v.every(check)) {
    fail(`${what} must have one valid entry per atom`);
  }
  return v as T[];
}

/** Validate a `Structure` payload (§5.1). Throws ResultError naming the first problem. */
export function validateStructure(raw: unknown): StructurePayload {
  if (!isObject(raw)) fail("structure is missing");
  const elements = numberArray(raw.elements, "elements");
  const n = elements.length;
  if (n > MAX_RESULT_ATOMS) fail(`${n} atoms exceeds the limit of ${MAX_RESULT_ATOMS}`);
  if (!elements.every((z) => Number.isInteger(z) && z >= 1 && z <= 118)) {
    fail("elements must be atomic numbers 1..118");
  }
  const positions = numberArray(raw.positions, "positions");
  if (positions.length !== 3 * n)
    fail(`positions has ${positions.length} values, expected ${3 * n}`);
  let cell: number[] | null = null;
  if (raw.cell !== null && raw.cell !== undefined) {
    cell = numberArray(raw.cell, "cell");
    if (cell.length !== 9) fail("cell must have 9 values");
  }
  if (!Array.isArray(raw.bonds)) fail("bonds must be an array");
  const bonds = raw.bonds as unknown[];
  for (const b of bonds) {
    if (
      !Array.isArray(b) ||
      b.length !== 2 ||
      !b.every((k) => Number.isInteger(k) && k >= 0 && k < n) ||
      b[0] === b[1]
    ) {
      fail(`bond ${JSON.stringify(b)} does not join two distinct atoms`);
    }
  }
  const out: StructurePayload = { elements, positions, cell, bonds: bonds as [number, number][] };
  if (raw.bondOrders !== undefined && raw.bondOrders !== null) {
    const orders = numberArray(raw.bondOrders, "bondOrders");
    if (orders.length !== bonds.length || !orders.every((o) => [1, 2, 3, 4].includes(o))) {
      fail("bondOrders must be 1..4, one per bond");
    }
    out.bondOrders = orders;
  }
  const isInt = (x: unknown) => Number.isInteger(x);
  const isStr = (x: unknown) => typeof x === "string";
  out.molecules = perAtom(raw.molecules, n, "molecules", (x) => isInt(x) && (x as number) >= 0);
  out.residueNames = perAtom(raw.residueNames, n, "residueNames", isStr);
  out.residueIds = perAtom(raw.residueIds, n, "residueIds", isInt);
  out.atomNames = perAtom(raw.atomNames, n, "atomNames", isStr);
  out.chainIds = perAtom(
    raw.chainIds,
    n,
    "chainIds",
    (x) => isStr(x) && (x as string).length === 1,
  );
  out.formalCharges = perAtom(raw.formalCharges, n, "formalCharges", isInt);
  if (raw.scalars !== undefined && raw.scalars !== null) {
    if (!isObject(raw.scalars)) fail("scalars must be an object");
    const scalars: Record<string, number[]> = {};
    for (const [name, values] of Object.entries(raw.scalars)) {
      const arr = numberArray(values, `scalar channel ${name}`);
      if (arr.length !== n) fail(`scalar channel ${name} must have one value per atom`);
      scalars[name] = arr;
    }
    out.scalars = scalars;
  }
  for (const key of Object.keys(out) as (keyof StructurePayload)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/** Validate `structuredContent` as a BuilderResult (§5). */
export function parseResult(raw: unknown): BuilderResult {
  if (!isObject(raw)) fail("the tool returned no structured result");
  if (typeof raw.contract !== "number" || !SUPPORTED_CONTRACTS.includes(raw.contract)) {
    fail(`unsupported result contract ${String(raw.contract)}`);
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "result";
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(isString) : [];
  return {
    contract: raw.contract,
    name,
    structure: validateStructure(raw.structure),
    warnings,
    provenance: isObject(raw.provenance) ? raw.provenance : {},
  };
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

/** Timeout for a call (§6): max(60 s, 5 × expected), at most 30 minutes. */
export function callTimeoutMs(expectedSeconds: number | null): number {
  const seconds = Math.min(Math.max(60, 5 * (expectedSeconds ?? 0)), 30 * 60);
  return seconds * 1000;
}

/** A file-name friendly form of a result name. */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "result").slice(0, 64);
}
