/**
 * The Flow assistant's self-check: what is wrong with a flow the model wrote,
 * found before the user runs it, so the model can be asked to fix it in the
 * same conversation. It is the viewer's `ai/validatePipeline.ts` for Flow
 * mode, run by the shared repair loop (`ai/generation.ts`).
 *
 * The checks are the ones a Run would hit, made without running anything (a
 * Run can take minutes and calls RDKit and the tool server): blocks and
 * settings Flow mode does not have, settings the block itself would refuse
 * (`builtinProblem`, the tool form's `validate`), wires into inputs a block
 * does not have, inputs left empty, a loop, and a supercell or slab fed a
 * structure that has no unit cell.
 *
 * Two rules, as for the viewer's self-check: a finding is always about a
 * block or wire the model wrote, and never one that only means the user has
 * not done something yet — a *Manual structure* block with nothing open in
 * Manual mode is fine, the user opens one before running. A setting the
 * model left out is not a finding either: it takes the block's default
 * (`normalizeParams`), as a template's blocks do.
 */

import { hasClosedFence, lastFencedJSON } from "../../../ai/generation";
import { BULK_STRUCTURES } from "../../../crystal/bulk";
import type { LibraryMolecule } from "../../library/types";
import type { BuilderToolInfo, FieldSpec } from "../../tools/contract";
import { initialValues, validate, type FormContext, type FormValues } from "../../tools/form";
import { BUILTIN_PORTS, builtinProblem, defaultBuiltinParams, isBuiltin } from "../builtins";
import { completeToolParams, rowFields, toolPorts, type FlowPort } from "../ports";
import type { SerializedFlow } from "../store";
import { FLOW_NODE_TYPES, type FlowNodeType, type FlowParams, type ToolParams } from "../types";

/** What the model's flow is checked against. */
export interface FlowCheckContext {
  /** The library molecules a molecule block may name. */
  library: LibraryMolecule[];
  /** The connected tool server's tools, or null when none is connected. */
  tools: BuilderToolInfo[] | null;
}

/** A fenced flow as the model wrote it: version 1 with nodes and edges, the rest unchecked. */
export interface RawFlow {
  version: 1;
  nodes: unknown[];
  edges: unknown[];
}

function isRawFlow(value: unknown): value is RawFlow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.nodes) && Array.isArray(v.edges);
}

/** The flow in the last closed fence of `text` that is one, or null. */
export function tryExtractFlow(text: string): RawFlow | null {
  return lastFencedJSON(text, isRawFlow);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isNumbers(v: unknown, length: number): boolean {
  return Array.isArray(v) && v.length === length && v.every(isNumber);
}

/** The settings each block type has, besides `type`. */
export const PARAM_KEYS: Record<FlowNodeType, readonly string[]> = {
  molecule: ["source", "smiles", "libraryId", "name"],
  document: [],
  tool: ["tool", "label", "values", "rows"],
  crystal: builtinKeys("crystal"),
  polymer: builtinKeys("polymer"),
  supercell: builtinKeys("supercell"),
  slab: builtinKeys("slab"),
  adsorb: builtinKeys("adsorb"),
};

function builtinKeys(type: Parameters<typeof defaultBuiltinParams>[0]): string[] {
  return Object.keys(defaultBuiltinParams(type)).filter((k) => k !== "type");
}

function pick(raw: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.filter((k) => k in raw).map((k) => [k, raw[k]]));
}

/**
 * A block's params as the model wrote them, with every setting it left out
 * set to the block's default and every key the block does not have dropped.
 * Values are not checked here (`collectFlowErrors` does that).
 */
export function normalizeParams(raw: Json, ctx: FlowCheckContext): FlowParams {
  const type = raw.type as FlowNodeType;
  const own = pick(raw, PARAM_KEYS[type]);
  switch (type) {
    case "molecule": {
      // A block that names a library molecule and no SMILES means the library.
      const library = typeof own.libraryId === "string" && own.libraryId !== "" && !own.smiles;
      return {
        smiles: "",
        libraryId: "",
        name: "",
        ...own,
        type,
        source: own.source ?? (library ? "library" : "smiles"),
      } as FlowParams;
    }
    case "document":
      return { type };
    case "tool": {
      const tool = ctx.tools?.find((t) => t.name === own.tool);
      return {
        ...own,
        type,
        label: typeof own.label === "string" ? own.label : (tool?.label ?? String(own.tool ?? "")),
        values: isObject(own.values) ? own.values : {},
        rows: isObject(own.rows) ? own.rows : {},
      } as FlowParams;
    }
    default:
      return { ...defaultBuiltinParams(type), ...own, type } as FlowParams;
  }
}

/** `block "n2" (slab)`, the way every finding names a block. */
function at(id: string, type: string): string {
  return `block "${id}" (${type})`;
}

interface CheckedNode {
  id: string;
  raw: Json;
  params: FlowParams;
  position: { x: number; y: number } | null;
}

interface CheckedEdge {
  source: string;
  target: string;
  targetHandle: string;
}

/**
 * The structural findings (blocks Flow mode cannot hold at all, wires to
 * blocks that are not there) and, when there are none, the flow's blocks and
 * wires in a shape the rest of the check can read.
 */
function readFlow(
  flow: RawFlow,
  ctx: FlowCheckContext,
): { errors: string[]; nodes: CheckedNode[]; edges: CheckedEdge[] } {
  const errors: string[] = [];
  const nodes: CheckedNode[] = [];
  const ids = new Set<string>();
  flow.nodes.forEach((n, i) => {
    if (!isObject(n) || typeof n.id !== "string" || n.id === "") {
      errors.push(`nodes[${i}] needs a string \`id\` (e.g. "n${i + 1}").`);
      return;
    }
    if (ids.has(n.id)) {
      errors.push(`two blocks have the id "${n.id}"; every block needs its own id.`);
      return;
    }
    ids.add(n.id);
    const params = n.params;
    const type = isObject(params) ? params.type : undefined;
    if (!isObject(params) || !(FLOW_NODE_TYPES as readonly unknown[]).includes(type)) {
      errors.push(
        `block "${n.id}" has ${isObject(params) ? `the unknown type ${JSON.stringify(type)}` : "no `params` object"}; ` +
          `\`params.type\` must be one of: ${FLOW_NODE_TYPES.join(", ")}.`,
      );
      return;
    }
    const pos = n.position;
    const position =
      isObject(pos) && isNumber(pos.x) && isNumber(pos.y) ? { x: pos.x, y: pos.y } : null;
    nodes.push({ id: n.id, raw: params, params: normalizeParams(params, ctx), position });
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: CheckedEdge[] = [];
  flow.edges.forEach((e, i) => {
    if (!isObject(e) || typeof e.source !== "string" || typeof e.target !== "string") {
      errors.push(`edges[${i}] needs string \`source\`, \`target\` and \`targetHandle\`.`);
      return;
    }
    const missing = [e.source, e.target].filter((id) => !ids.has(id));
    if (missing.length > 0) {
      errors.push(
        `the wire ${e.source} → ${e.target} names ${missing.map((id) => `"${id}"`).join(" and ")}, which is not a block of the flow.`,
      );
      return;
    }
    let handle = e.targetHandle;
    if (typeof handle !== "string") {
      // A block with one input can only mean that one.
      const ports = byId.has(e.target) ? inputsOf(byId.get(e.target)!.params, ctx) : null;
      if (ports?.length !== 1) {
        errors.push(
          `the wire ${e.source} → ${e.target} needs \`targetHandle\`, the input it goes into.`,
        );
        return;
      }
      handle = ports[0].key;
    }
    edges.push({ source: e.source, target: e.target, targetHandle: handle as string });
  });
  return { errors, nodes, edges };
}

/** The inputs of a block, or null when they cannot be known (a tool that is not there). */
function inputsOf(params: FlowParams, ctx: FlowCheckContext): FlowPort[] | null {
  if (isBuiltin(params)) return BUILTIN_PORTS[params.type];
  if (params.type !== "tool") return [];
  const tool = ctx.tools?.find((t) => t.name === params.tool);
  return tool ? toolPorts(tool).ports : null;
}

/** What is wrong with the value of `key` on a built-in or molecule block, or null. */
function settingProblem(params: Json, key: string): string | null {
  const v = params[key];
  const fail = (what: string) => `\`${key}\` must be ${what}, not ${JSON.stringify(v)}`;
  switch (`${params.type}.${key}`) {
    case "molecule.source":
      return v === "smiles" || v === "library" ? null : fail('"smiles" or "library"');
    case "crystal.structure":
      return BULK_STRUCTURES.some((s) => s.value === v)
        ? null
        : fail(`one of ${BULK_STRUCTURES.map((s) => `"${s.value}"`).join(", ")}`);
    case "crystal.elements":
      return Array.isArray(v) && v.every((x) => typeof x === "string")
        ? null
        : fail('an array of element symbols (e.g. ["Na", "Cl", ""])');
    case "crystal.cubic":
      return typeof v === "boolean" ? null : fail("true or false");
    case "supercell.repeat":
    case "slab.miller":
      return isNumbers(v, 3) ? null : fail("an array of 3 whole numbers");
    case "slab.repeat":
    case "adsorb.grid":
      return isNumbers(v, 2) ? null : fail("an array of 2 whole numbers");
    case "molecule.smiles":
    case "molecule.libraryId":
    case "molecule.name":
    case "polymer.repeatUnit":
    case "polymer.name":
      return typeof v === "string" ? null : fail("a string");
    default:
      return isNumber(v) ? null : fail("a number");
  }
}

const NO_FORM: FormContext = { library: [], shown: null, selected: [] };

/** An enum field set to a value it does not offer, among `fields` (and their groups). */
function enumProblem(fields: FieldSpec[], values: FormValues): string | null {
  for (const field of fields) {
    const v = values[field.key];
    if (field.kind === "enum" && v !== undefined && !field.options.includes(String(v))) {
      return `${field.key} must be one of ${field.options.map((o) => `"${o}"`).join(", ")}, not ${JSON.stringify(v)}.`;
    }
    if (field.kind === "group" && isObject(v)) {
      const inner = enumProblem(field.fields, v);
      if (inner) return inner;
    }
  }
  return null;
}

/** The findings for a tool block's settings: the tool, its `values`, its `rows`. */
function toolProblems(
  id: string,
  raw: Json,
  params: ToolParams,
  sources: Map<string, string[]>,
  ctx: FlowCheckContext,
): string[] {
  const name = at(id, "tool");
  if (typeof params.tool !== "string" || params.tool === "") {
    return [`${name} needs \`tool\`, the name of a tool of the connected server.`];
  }
  if (!ctx.tools) {
    return [
      `${name} calls "${params.tool}", but no tool server is connected, so it cannot run; ` +
        "build the model from the built-in blocks, or reply in prose asking the user to connect a tool server.",
    ];
  }
  const tool = ctx.tools.find((t) => t.name === params.tool);
  if (!tool) {
    const names = ctx.tools.map((t) => `"${t.name}"`).join(", ") || "none";
    return [`${name}: the connected server has no tool "${params.tool}"; its tools are ${names}.`];
  }
  const { ports, fields, problem } = toolPorts(tool);
  if (problem) return [`${name}: "${tool.name}" cannot be a Flow block: ${problem}`];
  for (const key of ["values", "rows"]) {
    if (key in raw && !isObject(raw[key])) return [`${name}: \`${key}\` must be an object.`];
  }

  const out: string[] = [];
  const fieldKeys = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(params.values)) {
    const port = ports.find((p) => p.key === key);
    if (port) {
      out.push(
        `${name}: "${key}" is an input, not a setting: wire blocks into it instead of setting it in \`values\`` +
          (port.multiple ? ", and put each wire's other columns in `rows`." : "."),
      );
    } else if (!fieldKeys.has(key)) {
      out.push(
        `${name}: "${tool.name}" has no setting "${key}"; its settings are ${[...fieldKeys].join(", ") || "none"}.`,
      );
    }
  }
  const complete = completeToolParams(params, tool);
  const invalid =
    validate(fields, complete.values, NO_FORM) ?? enumProblem(fields, complete.values);
  if (invalid) out.push(`${name}: ${invalid}`);

  for (const [key, byId] of Object.entries(params.rows)) {
    const port = ports.find((p) => p.key === key && p.multiple);
    if (!port) {
      out.push(`${name}: \`rows\` has "${key}", which is not an input that takes many wires.`);
      continue;
    }
    if (!isObject(byId)) {
      out.push(`${name}: \`rows.${key}\` must map a wired block's id to its row.`);
      continue;
    }
    const columns = rowFields(tool, port);
    const columnKeys = new Set(columns.map((c) => c.key));
    const wired = sources.get(key) ?? [];
    for (const [src, row] of Object.entries(byId)) {
      if (!wired.includes(src)) {
        out.push(
          `${name}: \`rows.${key}\` has a row for "${src}", which is not wired into ${key}.`,
        );
        continue;
      }
      if (!isObject(row)) {
        out.push(`${name}: \`rows.${key}.${src}\` must be an object of column values.`);
        continue;
      }
      const unknown = Object.keys(row).filter((k) => !columnKeys.has(k));
      if (unknown.length > 0) {
        out.push(
          `${name}: \`rows.${key}.${src}\` has ${unknown.map((k) => `"${k}"`).join(", ")}; its columns are ${[...columnKeys].join(", ") || "none"}.`,
        );
        continue;
      }
      const rowProblem = validate(columns, { ...initialValues(columns, NO_FORM), ...row }, NO_FORM);
      if (rowProblem) out.push(`${name}, row of "${src}": ${rowProblem}`);
    }
  }
  return out;
}

/** The findings for one block's settings. */
function blockProblems(
  node: CheckedNode,
  sources: Map<string, string[]>,
  ctx: FlowCheckContext,
): string[] {
  const { id, raw, params } = node;
  const name = at(id, params.type);
  const unknown = Object.keys(raw).filter(
    (k) => k !== "type" && !PARAM_KEYS[params.type].includes(k),
  );
  const out = unknown.map(
    (k) =>
      `${name} has no setting "${k}"; ` +
      (PARAM_KEYS[params.type].length > 0
        ? `its settings are ${PARAM_KEYS[params.type].join(", ")}.`
        : "it has no settings."),
  );
  if (params.type === "tool") return [...out, ...toolProblems(id, raw, params, sources, ctx)];
  if (params.type === "document") return out;

  const shape = PARAM_KEYS[params.type]
    .map((k) => settingProblem(params as unknown as Json, k))
    .filter((p): p is string => p !== null);
  if (shape.length > 0) return [...out, ...shape.map((p) => `${name}: ${p}.`)];

  if (params.type === "molecule") {
    if (params.source === "smiles" && params.smiles.trim() === "") {
      out.push(`${name} reads a SMILES string, but \`smiles\` is empty.`);
    }
    if (params.source === "library" && !ctx.library.some((m) => m.id === params.libraryId)) {
      out.push(
        `${name}: "${params.libraryId}" is not a library molecule; use an id listed under ` +
          'Library molecules, or `source: "smiles"` with a SMILES string.',
      );
    }
    return out;
  }
  if (isBuiltin(params)) {
    const problem = builtinProblem(params);
    if (problem) out.push(`${name}: ${problem}`);
  }
  return out;
}

/** Whether a block's result has a unit cell: true, false, or null when it depends on what runs. */
function cellOf(
  id: string,
  byId: Map<string, CheckedNode>,
  inputs: Map<string, Map<string, string[]>>,
  seen = new Set<string>(),
): boolean | null {
  const params = byId.get(id)?.params;
  if (!params || seen.has(id)) return null;
  seen.add(id);
  switch (params.type) {
    case "molecule":
    case "polymer":
      return false;
    case "crystal":
    case "supercell":
    case "slab":
      return true;
    case "adsorb": {
      const surface = inputs.get(id)?.get("surface")?.[0];
      return surface ? cellOf(surface, byId, inputs, seen) : null;
    }
    default:
      return null;
  }
}

/** True when the wires make a loop. */
function hasLoop(nodes: CheckedNode[], edges: CheckedEdge[]): boolean {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indegree.set(e.target, indegree.get(e.target)! + 1);
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen++;
    for (const e of edges) {
      if (e.source !== id) continue;
      indegree.set(e.target, indegree.get(e.target)! - 1);
      if (indegree.get(e.target) === 0) queue.push(e.target);
    }
  }
  return seen < nodes.length;
}

/** Inputs whose blocks need a structure with a unit cell, by block type. */
const NEEDS_CELL: Partial<Record<FlowNodeType, { input: string; what: string }>> = {
  supercell: { input: "structure", what: "A supercell repeats a structure's unit cell" },
  slab: { input: "bulk", what: "A slab is cut from a bulk crystal's unit cell" },
};

/** The findings for the wires: inputs that are not there, doubled, missing, a loop, a cell. */
function wireProblems(nodes: CheckedNode[], edges: CheckedEdge[], ctx: FlowCheckContext): string[] {
  const out: string[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inputs = new Map<string, Map<string, string[]>>();
  const seen = new Set<string>();
  // The wires that are not findings themselves: only they can make a loop worth naming.
  const valid: CheckedEdge[] = [];
  for (const e of edges) {
    const target = byId.get(e.target)!;
    const wire = `the wire ${e.source} → ${e.target} (${e.targetHandle})`;
    const key = `${e.source}|${e.target}|${e.targetHandle}`;
    if (seen.has(key)) {
      out.push(`${wire} is listed twice.`);
      continue;
    }
    seen.add(key);
    if (e.source === e.target) {
      out.push(`${wire} connects a block to itself.`);
      continue;
    }
    const ports = inputsOf(target.params, ctx);
    if (ports && !ports.some((p) => p.key === e.targetHandle)) {
      out.push(
        `${wire}: ${at(target.id, target.params.type)} ` +
          (ports.length === 0
            ? "takes no inputs; it starts a structure."
            : `has no input "${e.targetHandle}"; its inputs are ${ports.map((p) => `"${p.key}"`).join(", ")}.`),
      );
      continue;
    }
    valid.push(e);
    const handles = inputs.get(e.target) ?? new Map<string, string[]>();
    inputs.set(e.target, handles);
    handles.set(e.targetHandle, [...(handles.get(e.targetHandle) ?? []), e.source]);
  }

  for (const node of nodes) {
    const ports = inputsOf(node.params, ctx) ?? [];
    for (const port of ports) {
      const wired = inputs.get(node.id)?.get(port.key) ?? [];
      if (!port.multiple && wired.length > 1) {
        out.push(
          `${at(node.id, node.params.type)}: its "${port.key}" input takes one wire, but ${wired.length} (${wired.join(", ")}) go into it.`,
        );
      }
      if (port.required && wired.length === 0) {
        out.push(
          `${at(node.id, node.params.type)} needs a wire into its "${port.key}" input (${port.label}).`,
        );
      }
    }
    const cell = NEEDS_CELL[node.params.type];
    const src = cell ? inputs.get(node.id)?.get(cell.input)?.[0] : undefined;
    if (cell && src && cellOf(src, byId, inputs) === false) {
      out.push(
        `the wire ${src} → ${node.id} (${cell.input}): ${cell.what}, but ${at(src, byId.get(src)!.params.type)} ` +
          "has no unit cell; wire in a crystal block (or a slab or supercell of one).",
      );
    }
  }

  if (hasLoop(nodes, valid)) {
    out.push(
      "the wires make a loop; a flow must run from blocks with no inputs down to one final block.",
    );
  }
  return out;
}

/**
 * Everything wrong with the flow the model wrote, as findings to send back
 * to it; empty when there is nothing to fix. Structural findings come alone:
 * the settings and wires of a flow whose blocks cannot even be read would
 * only repeat them in worse words.
 */
export function collectFlowErrors(flow: RawFlow, ctx: FlowCheckContext): string[] {
  const { errors, nodes, edges } = readFlow(flow, ctx);
  if (errors.length > 0) return errors;
  if (nodes.length === 0) return ["the flow has no blocks."];
  const sources = (id: string) => {
    const out = new Map<string, string[]>();
    for (const e of edges) {
      if (e.target === id) out.set(e.targetHandle, [...(out.get(e.targetHandle) ?? []), e.source]);
    }
    return out;
  };
  return [
    ...nodes.flatMap((n) => blockProblems(n, sources(n.id), ctx)),
    ...wireProblems(nodes, edges, ctx),
  ];
}

/**
 * `params` with every setting a block could not even draw (a repeat that is
 * not three numbers, a structure Flow mode has no prototype for) put back to
 * the block's default, so an applied flow never breaks its card or its
 * form. The finding about the setting still goes to the model.
 */
function safeParams(params: FlowParams): FlowParams {
  if (params.type === "tool" || params.type === "document") return params;
  const defaults: Json =
    params.type === "molecule"
      ? { source: "smiles", smiles: "", libraryId: "", name: "" }
      : (defaultBuiltinParams(params.type) as unknown as Json);
  const out = { ...params } as unknown as Json;
  for (const key of PARAM_KEYS[params.type]) {
    if (settingProblem(out, key)) out[key] = defaults[key];
  }
  return out as unknown as FlowParams;
}

/** Horizontal and vertical step of the grid blocks are laid out on (the templates' grid). */
const GRID_X = 300;
const GRID_Y = 150;
/** Vertical step that moves a block off one it would cover (the Flow panel's `freePosition`). */
const STACK_STEP = 110;

/**
 * The flow the model wrote, ready for `applyGenerated`, or null when it
 * cannot be held at all (a block of an unknown type, two blocks with one id,
 * a wire to a block that is not there). Settings are completed with the
 * blocks' defaults and stripped of keys the blocks do not have; wires into
 * inputs the target does not have, and repeated ones, are left out (the
 * findings name them). A block without a usable position goes on the grid by
 * how deep it sits, and one that would cover another is moved down, so the
 * graph is never a pile of cards on one spot.
 */
export function prepareGeneratedFlow(flow: RawFlow, ctx: FlowCheckContext): SerializedFlow | null {
  const { errors, nodes, edges } = readFlow(flow, ctx);
  if (errors.length > 0 || nodes.length === 0) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const kept = edges.filter((e) => {
    const key = `${e.source}|${e.target}|${e.targetHandle}`;
    if (seen.has(key) || e.source === e.target) return false;
    seen.add(key);
    const ports = inputsOf(byId.get(e.target)!.params, ctx);
    return !ports || ports.some((p) => p.key === e.targetHandle);
  });

  // Depth of each block: the longest chain of wires above it (a loop stops counting).
  const depth = new Map<string, number>();
  const depthOf = (id: string, stack: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const ups = kept.filter((e) => e.target === id).map((e) => depthOf(e.source, stack) + 1);
    stack.delete(id);
    const d = Math.max(0, ...ups);
    depth.set(id, d);
    return d;
  };
  const columns = new Map<number, number>();
  const placed: { x: number; y: number }[] = [];
  const out = nodes.map((n) => {
    let position = n.position;
    if (!position) {
      const d = depthOf(n.id, new Set());
      const col = columns.get(d) ?? 0;
      columns.set(d, col + 1);
      position = { x: 40 + col * GRID_X, y: 40 + d * GRID_Y };
    }
    const p = { ...position };
    while (placed.some((q) => Math.abs(q.x - p.x) < 40 && Math.abs(q.y - p.y) < 40)) {
      p.y += STACK_STEP;
    }
    placed.push(p);
    return { id: n.id, position: p, params: safeParams(n.params) };
  });
  return { version: 1, nodes: out, edges: kept };
}

/**
 * The output contract restated for a follow-up turn, as a literal skeleton
 * (see `OUTPUT_SHAPE_REMINDER` in `ai/validatePipeline.ts`). The skeleton is
 * not valid JSON, so a reply that echoes it is never applied.
 */
const OUTPUT_SHAPE_REMINDER = [
  "Reply in exactly this shape — the fenced JSON block first, then one short",
  "sentence, and nothing else:",
  "",
  "```json",
  '{ "version": 1, "nodes": [...], "edges": [...] }',
  "```",
  "Builds the structure.",
].join("\n");

/** Cap on how many findings one repair message carries. */
export const MAX_REPORTED_FLOW_ERRORS = 12;

/** The follow-up for a reply whose fenced block is not a flow at all. */
export function buildUnparsableFlowPrompt(): string {
  return [
    "The code block you just produced is not a usable flow — it either is not",
    "valid JSON, or it is missing the required `version: 1` / `nodes` / `edges`",
    "fields. Nothing could be applied.",
    "",
    "Send the flow again, checking that every brace and bracket is closed and",
    "that no comments or trailing commas are present.",
    "",
    OUTPUT_SHAPE_REMINDER,
  ].join("\n");
}

/**
 * The follow-up asking the model to fix the findings in the flow it just
 * produced, inside the same conversation (its flow is one turn above, so it
 * is not repeated).
 */
export function buildFlowRepairPrompt(errors: string[]): string {
  const shown = errors.slice(0, MAX_REPORTED_FLOW_ERRORS);
  const omitted = errors.length - shown.length;
  return [
    "The flow you just produced has the problems listed below. They were found",
    "by checking it against the blocks Flow mode has and the inputs each one",
    "takes, so each one is real — fix them all and return the corrected flow.",
    "",
    "Problems:",
    ...shown.map((e) => `- ${e}`),
    ...(omitted > 0 ? [`- … and ${omitted} more of the same kind`] : []),
    "",
    "Change only what is needed to resolve them; keep everything that already",
    "matches the request, and follow the block schema from the system prompt exactly.",
    "",
    OUTPUT_SHAPE_REMINDER,
  ].join("\n");
}

/**
 * Whether a reply needs another round, and with what prompt (the
 * `diagnose` of the shared repair loop): null for a flow that checks out
 * and for a reply with no fence at all (prose, e.g. saying a tool server is
 * needed); the unparsable prompt for a fence that holds no flow; the repair
 * prompt for a flow with findings.
 */
export function diagnoseFlowResponse(
  text: string,
  ctx: FlowCheckContext,
): { prompt: string; errors: string[] } | null {
  const flow = tryExtractFlow(text);
  if (!flow) {
    if (!hasClosedFence(text)) return null;
    return {
      prompt: buildUnparsableFlowPrompt(),
      errors: ["the fenced block is not valid, complete flow JSON"],
    };
  }
  const errors = collectFlowErrors(flow, ctx);
  return errors.length > 0 ? { prompt: buildFlowRepairPrompt(errors), errors } : null;
}
