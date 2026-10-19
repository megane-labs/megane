/**
 * Which inputs a Flow block has, and how a tool block's inputs become the
 * tool's form values.
 *
 * A tool's `inputSchema` (Builder Tool Contract §4) already says which of its
 * arguments are structures: a `molecule` widget is a molecule from the
 * library, a `document` widget is the open structure. In Flow mode those
 * arguments are wires instead of form controls:
 *
 * - a top-level `molecule` field is a single input;
 * - a `document` field is a single input (the structure to add to);
 * - a table whose rows hold a `molecule` column (a liquid box's
 *   `components`) is a multiple input: each wire is a row, and the row's
 *   other columns (the count) are edited per wire on the block.
 *
 * Everything else stays a form field. The upstream structures are handed to
 * the existing form code as a pretend library whose molecule ids are the
 * upstream block ids, so `validate` and `buildArguments` (`tools/form.ts`)
 * build the call exactly as the Tools menu's form does.
 */

import type { LibraryMolecule } from "../library/types";
import { formulaOf, geometryFromSnapshot } from "../library/fragment";
import type { BuilderToolInfo, FieldSpec } from "../tools/contract";
import { initialValues, type FormContext, type FormValues } from "../tools/form";
import { BUILTIN_PORTS, isBuiltin } from "./builtins";
import type { FlowData, FlowParams, ToolParams } from "./types";

export interface FlowPort {
  /** Handle id: the tool argument the wire fills. */
  key: string;
  label: string;
  /** True for a table input: any number of wires, one row each. */
  multiple: boolean;
  required: boolean;
  kind: "molecule" | "document";
  /** For a table input, the key of its `molecule` column. */
  column: string | null;
}

export interface ToolPorts {
  ports: FlowPort[];
  /** The form fields that are not inputs. */
  fields: FieldSpec[];
  /** Why the tool cannot be a block, or null. */
  problem: string | null;
}

function isMolecule(field: FieldSpec): boolean {
  return field.kind === "widget" && field.widget === "molecule";
}

/** Split a tool's fields into inputs (wires) and form fields. */
export function toolPorts(tool: BuilderToolInfo): ToolPorts {
  if (!tool.fields) {
    return { ports: [], fields: [], problem: tool.formError ?? "The tool has no form." };
  }
  const ports: FlowPort[] = [];
  const fields: FieldSpec[] = [];
  let problem: string | null = null;
  for (const field of tool.fields) {
    if (field.kind === "widget" && (field.widget === "molecule" || field.widget === "document")) {
      ports.push({
        key: field.key,
        label: field.label,
        multiple: false,
        required: field.required,
        kind: field.widget,
        column: null,
      });
    } else if (field.kind === "widget" && field.widget === "selection") {
      problem ??= `${field.label} needs atoms picked in the 3D view; use this tool in Manual mode.`;
    } else if (field.kind === "table" && field.columns.some(isMolecule)) {
      ports.push({
        key: field.key,
        label: field.label,
        multiple: true,
        required: field.minItems > 0,
        kind: "molecule",
        column: field.columns.find(isMolecule)!.key,
      });
    } else if (field.kind === "group" && field.fields.some(isMolecule)) {
      problem ??= `${field.label} holds a molecule inside a group, which Flow mode cannot wire.`;
    } else {
      fields.push(field);
    }
  }
  return { ports, fields, problem };
}

/** The columns of a table input other than its molecule column. */
export function rowFields(tool: BuilderToolInfo, port: FlowPort): FieldSpec[] {
  const table = tool.fields?.find((f) => f.key === port.key);
  if (!table || table.kind !== "table") return [];
  return table.columns.filter((c) => c.key !== port.column);
}

/** A structure on a wire as the library molecule a `molecule` argument is built from. */
export function asLibraryMolecule(id: string, data: FlowData): LibraryMolecule {
  const geometry = geometryFromSnapshot(data.snapshot);
  return {
    id,
    name: data.name,
    formula: formulaOf(geometry.elements),
    origin: "file",
    ...geometry,
  };
}

/** Upstream block ids per input, in wire order. */
export type PortSources = Record<string, string[]>;

/**
 * The form context and values for a tool block: the upstream structures as a
 * library (ids = upstream block ids), the `document` input as the shown
 * structure, and every input field bound to its wires. `data` holds the
 * upstream results known so far; a missing one simply leaves its molecule
 * out of the library, which `validate` then reports.
 */
export function toolForm(
  tool: BuilderToolInfo,
  params: ToolParams,
  sources: PortSources,
  data: Record<string, FlowData | null | undefined>,
): { ctx: FormContext; values: FormValues; fields: FieldSpec[] } {
  const { ports } = toolPorts(tool);
  const library: LibraryMolecule[] = [];
  const seen = new Set<string>();
  let shown: FormContext["shown"] = null;
  for (const port of ports) {
    for (const id of sources[port.key] ?? []) {
      const d = data[id];
      if (!d) continue;
      if (port.kind === "document") shown = d.snapshot;
      else if (!seen.has(id)) {
        seen.add(id);
        library.push(asLibraryMolecule(id, d));
      }
    }
  }
  const ctx: FormContext = { library, shown, selected: [] };
  const values: FormValues = { ...params.values };
  for (const port of ports) {
    const ids = sources[port.key] ?? [];
    if (port.multiple) {
      const columns = rowFields(tool, port);
      values[port.key] = ids.map((id) => ({
        ...initialValues(columns, ctx),
        ...(params.rows[port.key]?.[id] ?? {}),
        [port.column!]: id,
      }));
    } else if (port.kind === "molecule") {
      values[port.key] = ids[0] ?? "";
    }
  }
  return { ctx, values, fields: tool.fields ?? [] };
}

/** Initial `values` for a new tool block: the defaults of its form fields. */
export function initialToolParams(tool: BuilderToolInfo): ToolParams {
  const { fields } = toolPorts(tool);
  return {
    type: "tool",
    tool: tool.name,
    label: tool.label,
    values: initialValues(fields, { library: [], shown: null, selected: [] }),
    rows: {},
  };
}

/**
 * A tool block's params with every form field the tool has and the block
 * lacks set to its default (a template's block, or one saved before the tool
 * grew a field), or the same object when nothing is missing.
 */
export function completeToolParams(params: ToolParams, tool: BuilderToolInfo): ToolParams {
  const defaults = initialToolParams(tool).values;
  const missing = Object.keys(defaults).filter((k) => !(k in params.values));
  if (missing.length === 0) return params;
  const values = { ...params.values };
  for (const k of missing) values[k] = defaults[k];
  return { ...params, values };
}

/**
 * The inputs a block shows. A built-in block's are fixed. A tool block whose
 * server is not connected keeps the inputs its wires use, so the wires stay
 * drawn until the server is back.
 */
export function blockPorts(
  params: FlowParams,
  tool: BuilderToolInfo | null,
  wiredHandles: string[],
): FlowPort[] {
  if (isBuiltin(params)) return BUILTIN_PORTS[params.type];
  if (params.type !== "tool") return [];
  if (tool) return toolPorts(tool).ports;
  return [...new Set(wiredHandles)].map((key) => ({
    key,
    label: key,
    multiple: true,
    required: false,
    kind: "molecule" as const,
    column: null,
  }));
}
