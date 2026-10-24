/**
 * What the Flow assistant tells the model: the system prompt (the flow
 * schema, every block Flow mode has with its settings and inputs, the
 * library molecules and connected tools it may name, ready-made examples)
 * and each request wrapped in the flow the graph holds now.
 *
 * Everything that can be read from the code is: the block settings and their
 * defaults (`builtins.ts`), the inputs (`BUILTIN_PORTS`, the tool contract's
 * form), the crystal prototypes and reference lattice constants
 * (`crystal/bulk.ts`), the polymer presets and the templates, so the prompt
 * cannot describe a block differently from the one that runs it.
 */

import { BULK_EXAMPLES, BULK_STRUCTURES, bulkStructureInfo } from "../../../crystal/bulk";
import { historySection, type ChatTurn } from "../../../ai/editContext";
import type { LibraryMolecule } from "../../library/types";
import type { BuilderToolInfo, FieldSpec } from "../../tools/contract";
import { BUILTIN_PORTS, defaultBuiltinParams, type BuiltinType } from "../builtins";
import { MAX_POLYMER_UNITS, POLYMER_PRESETS } from "../polymer";
import { rowFields, toolPorts, type FlowPort } from "../ports";
import type { SerializedFlow } from "../store";
import { FLOW_TEMPLATES } from "../templates";
import type { FlowCheckContext } from "./check";

/** What the system prompt describes besides the blocks themselves. */
export interface FlowPromptContext extends FlowCheckContext {
  /** The host can reach tool servers at all (one may still not be connected). */
  hostHasTools: boolean;
  /** The structure open in Manual mode, or null when none is. */
  document: { name: string; atoms: number; cell: boolean } | null;
}

/** Most library molecules listed, so a large library does not crowd out the rest. */
export const MAX_LISTED_MOLECULES = 40;

/** Longest tool description quoted. */
const MAX_TOOL_DESCRIPTION = 400;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function signature(type: BuiltinType): string {
  return JSON.stringify(defaultBuiltinParams(type));
}

function inputsLine(ports: FlowPort[]): string {
  if (ports.length === 0) return "- No inputs.";
  const list = ports.map((p) => `\`${p.key}\` (${p.label.toLowerCase()}, one wire, required)`);
  return `- Inputs: ${list.join(", ")}.`;
}

function bulkSection(): string {
  const rows = BULK_STRUCTURES.map(
    (s) =>
      `    - "${s.value}": ${s.label}, ${s.species} species${s.cubic ? ", cubic cell available" : ""}${s.hexagonal ? ", uses covera" : ""}`,
  );
  const examples = BULK_EXAMPLES.map((e) => {
    const c = e.spec.covera ? `, covera ${+e.spec.covera.toFixed(3)}` : "";
    return `${e.name} a=${e.spec.a}${c}`;
  });
  const hex = bulkStructureInfo("hcp");
  return [
    "### crystal",
    "A bulk crystal from a prototype structure and a lattice constant, built in the browser. Its result has a unit cell.",
    `- Params: \`${signature("crystal")}\``,
    "  - `structure`, one of:",
    ...rows,
    '  - `elements`: element symbols of species A, B and X, in that order; only as many as the prototype has species are read, so fill the rest with "" (rocksalt NaCl: ["Na", "Cl", ""]).',
    `  - \`a\`: lattice constant in Å. Reference values: ${examples.join("; ")}.`,
    `  - \`covera\`: c/a of ${hex.label} and wurtzite (ideal ${Math.sqrt(8 / 3).toFixed(3)}); other prototypes ignore it.`,
    "  - `cubic`: true for the conventional cubic cell, false for the primitive cell, where the prototype has both. Keep true before a slab or supercell.",
    inputsLine(BUILTIN_PORTS.crystal),
  ].join("\n");
}

function polymerSection(): string {
  const presets = POLYMER_PRESETS.map((p) => `${p.label} "${p.repeatUnit}" (name "${p.name}")`);
  return [
    "### polymer",
    "A linear homopolymer chain: a repeat unit repeated `length` times, embedded in 3D by RDKit. Its result has no unit cell.",
    `- Params: \`${signature("polymer")}\``,
    "  - `repeatUnit`: SMILES of one repeat unit with exactly two `*`: one at the start (head) and one at the end (tail), on the main chain, with every ring closed inside the unit.",
    `    Presets: ${presets.join("; ")}.`,
    `  - \`length\`: number of repeat units, a whole number from 1 to ${MAX_POLYMER_UNITS}.`,
    "  - `name`: the chain's residue name, at most 4 characters.",
    inputsLine(BUILTIN_PORTS.polymer),
  ].join("\n");
}

/** One form field of a tool, in a line. */
export function describeField(field: FieldSpec): string {
  let type: string;
  switch (field.kind) {
    case "number": {
      const range: string[] = [];
      if (field.min !== null) range.push(`${field.exclusiveMin ? ">" : "≥"} ${field.min}`);
      if (field.max !== null) range.push(`${field.exclusiveMax ? "<" : "≤"} ${field.max}`);
      type = `${field.integer ? "integer" : "number"}${field.unit ? ` in ${field.unit}` : ""}${range.length ? ` (${range.join(", ")})` : ""}`;
      break;
    }
    case "enum":
      type = `one of ${field.options.map((o) => JSON.stringify(o)).join(" | ")}`;
      break;
    case "string":
      type = "string";
      break;
    case "boolean":
      type = "true or false";
      break;
    case "vector":
      type = `array of ${field.length} ${field.integer ? "integers" : "numbers"}${field.unit ? ` in ${field.unit}` : ""}`;
      break;
    case "table":
      type = `array of rows { ${field.columns.map(describeField).join("; ")} }`;
      break;
    case "group":
      type = `object { ${field.fields.map(describeField).join("; ")} }`;
      break;
    case "widget":
      type =
        field.widget === "element"
          ? "atomic number"
          : field.widget === "seed"
            ? "integer random seed"
            : field.widget === "cell"
              ? "[a, b, c] box lengths in Å"
              : field.widget === "atom"
                ? "atom index"
                : field.widget;
      break;
  }
  const preset = field.default !== undefined ? field.default : field.example;
  const dflt = preset !== undefined && preset !== null ? `, default ${JSON.stringify(preset)}` : "";
  const help = field.help ? ` — ${clip(field.help, 120)}` : "";
  return `\`${field.key}\`: ${type}${field.required ? ", required" : ""}${dflt}${help}`;
}

/** A tool Flow mode can use (`toolPorts` finds no problem), with its inputs and settings. */
function toolBlock(tool: BuilderToolInfo): string {
  const { ports, fields } = toolPorts(tool);
  const lines = [`#### "${tool.name}" — ${tool.label}`];
  if (tool.description) lines.push(clip(tool.description, MAX_TOOL_DESCRIPTION));
  if (ports.length === 0) lines.push("- No inputs.");
  for (const port of ports) {
    const kind = port.multiple
      ? `any number of wires, one row each; each row's other columns go in \`rows.${port.key}.<source id>\`: ${rowFields(tool, port).map(describeField).join("; ") || "none"}`
      : `one wire, ${port.kind === "document" ? "the structure the tool works on" : "a molecule"}`;
    lines.push(
      `- Input \`${port.key}\` (${port.label}${port.required ? ", required" : ""}): ${kind}.`,
    );
  }
  if (fields.length === 0) lines.push("- No settings.");
  else lines.push("- Settings (`values`):", ...fields.map((f) => `  - ${describeField(f)}`));
  lines.push(
    `- Result: ${tool.apply === "insert" ? "the structure wired into its document input with the tool's atoms added" : "a new structure"}.`,
  );
  return lines.join("\n");
}

function toolSection(ctx: FlowPromptContext): string {
  const head = [
    "### tool",
    "A tool of the connected tool server (packmol liquid boxes, solvation, …), called with its settings when the flow runs.",
    '- Params: `{"type":"tool","tool":"<name>","label":"<its label>","values":{…},"rows":{…}}`',
    "  - `values`: the tool's settings below; leave out the ones to keep at their defaults.",
    '  - `rows`: per-wire settings of an input that takes many wires, keyed by the input and then by the id of the block on the wire, e.g. `{"components":{"n1":{"count":300}}}`.',
  ];
  if (!ctx.hostHasTools) {
    return [...head, "", "This Builder cannot reach tool servers: never use a tool block."].join(
      "\n",
    );
  }
  if (!ctx.tools) {
    return [
      ...head,
      "",
      "No tool server is connected, so a tool block cannot run: do not use one. If the request needs one (a packed liquid box, solvation), reply in one or two plain sentences, with no JSON, asking the user to connect a tool server from the Add menu first.",
    ].join("\n");
  }
  const usable = ctx.tools.filter((t) => !toolPorts(t).problem);
  if (usable.length === 0) {
    return [...head, "", "The connected tool server offers no tool Flow mode can use."].join("\n");
  }
  return [
    ...head,
    "",
    "The connected server's tools:",
    "",
    usable.map(toolBlock).join("\n\n"),
  ].join("\n");
}

function librarySection(library: LibraryMolecule[]): string {
  const shown = library.slice(0, MAX_LISTED_MOLECULES);
  const lines = shown.map((m) => `- "${m.id}": ${m.name} (${m.formula})`);
  if (library.length > shown.length) lines.push(`- … and ${library.length - shown.length} more`);
  return [
    "## Library molecules",
    "",
    'The ids a molecule block with `source: "library"` may name. Anything else is written as SMILES.',
    "",
    ...(lines.length > 0 ? lines : ["(The library is empty: use SMILES.)"]),
  ].join("\n");
}

function documentLine(ctx: FlowPromptContext): string {
  const doc = ctx.document;
  if (!doc) {
    return "Manual mode has no structure open. A document block still works: it reads whatever the user opens before running.";
  }
  return `Manual mode has "${doc.name}" open: ${doc.atoms} atoms, ${doc.cell ? "with" : "without"} a unit cell.`;
}

function examplesSection(ctx: FlowPromptContext): string {
  const names = new Set((ctx.tools ?? []).map((t) => t.name));
  const usable = FLOW_TEMPLATES.filter((t) => t.tools.every((name) => names.has(name)));
  const blocks = usable.map(
    (t) => `User request: "${t.description}"\n\n\`\`\`json\n${JSON.stringify(t.create())}\n\`\`\``,
  );
  return ["## Examples", ...blocks].join("\n\n");
}

/** The Flow assistant's system prompt for what `ctx` says is there. */
export function buildFlowSystemPrompt(ctx: FlowPromptContext): string {
  return `You are the assistant of Megane Builder's Flow mode, which builds atomistic models for simulations.
A flow is a graph of blocks connected by wires. Each block makes a structure or changes the ones wired into it, and each wire carries one block's result into an input of another. Running the flow builds every block in order, and the result of the output block — the last block that no wire leaves — becomes the structure the user edits in Manual mode. The user presses Run; you only build the graph.

## Output Format

Output the flow as a single JSON code block FIRST, then write ONE short
sentence in plain language (no markdown, no lists) describing what it builds —
that sentence is shown to the user as your reply, so keep it friendly and
concise. The JSON code block MUST come first, and the sentence MUST come
immediately after it as the last thing in your response. Example:

\`\`\`json
{ "version": 1, "nodes": [...], "edges": [...] }
\`\`\`

Cuts a Pt(111) slab and lays a 3 × 3 layer of water on it.

When the request cannot be built with the blocks below, write no JSON at all:
reply with one or two plain sentences saying what is missing.

## Flow Schema

\`\`\`typescript
interface SerializedFlow {
  version: 1;
  nodes: Array<{
    id: string;                          // unique, e.g. "n1", "n2"
    position: { x: number; y: number };  // grid: x = 40 + 300 * column, y = 40 + 150 * row
    params: BlockParams;                 // { "type": "<block type>", ...its settings }
  }>;
  edges: Array<{
    source: string;       // id of the block whose result the wire carries
    target: string;       // id of the block it goes into
    targetHandle: string; // which input of the target (see each block's inputs)
  }>;
}
\`\`\`

Every block has exactly one output, so a wire only names the input it goes into.
Put each block one row below the blocks it takes inputs from. A setting you
leave out takes the default shown in the block's Params.

## Blocks

### molecule
A single molecule: written as SMILES (embedded in 3D with hydrogens by RDKit) or taken from the molecule library. Its result has no unit cell.
- Params: \`{"type":"molecule","source":"smiles","smiles":"","libraryId":"","name":""}\`
  - \`source\`: "smiles" reads \`smiles\` (e.g. "CCO", hydrogens implicit); "library" reads \`libraryId\`, one of the ids under Library molecules.
  - \`name\`: what the molecule is called, also its residue name when a tool packs copies of it (at most 4 characters is best); "" uses the SMILES or the library name.
- No inputs.

### document
The structure open in Manual mode, as it is when the flow runs. Use it when the request is about "my structure", "this structure" or "the open structure". ${documentLine(ctx)}
- Params: \`{"type":"document"}\`
- No inputs.

${bulkSection()}

${polymerSection()}

### supercell
Repeats the input structure along its cell vectors a, b and c.
- Params: \`${signature("supercell")}\` — \`repeat\`: whole numbers from 1 to 20.
${inputsLine(BUILTIN_PORTS.supercell)} It must have a unit cell (a crystal, a slab, a packed box, a periodic Manual structure).

### slab
Cuts a (h k l) surface slab from the input bulk crystal, with vacuum above and below.
- Params: \`${signature("slab")}\`
  - \`miller\`: the Miller indices [h, k, l], whole numbers, not all zero.
  - \`layers\`: repeats of the surface cell along the normal, 1 to 50. \`vacuum\`: Å on each side along the normal (0 keeps the slab periodic). \`repeat\`: repeats in plane along a and b, 1 to 20.
${inputsLine(BUILTIN_PORTS.slab)} It must have a unit cell: wire a crystal block in.

### adsorb
Lays copies of the molecule on a grid above the surface, each \`height\` Å above the surface's top atom.
- Params: \`${signature("adsorb")}\` — \`height\`: Å; \`grid\`: copies along the surface cell's a and b, 1 to 20 each.
${inputsLine(BUILTIN_PORTS.adsorb)} The surface is usually a slab block; the molecule a molecule block.

${toolSection(ctx)}

${librarySection(ctx.library)}

## Rules

1. Wire only into the inputs a block lists; a block with no inputs starts a structure and takes no wires.
2. An input that takes one wire gets exactly one; every required input gets one.
3. Supercell and slab need a structure with a unit cell: never wire a molecule or a polymer into them.
4. No loops: wires run from blocks with no inputs down to one final block, the output.
5. Use only the block types, settings and tools described above; never invent one.
6. One block makes one structure. To place a molecule on a surface use adsorb; to pack many molecules into a box use a tool block, which needs a connected tool server.

${examplesSection(ctx)}
`;
}

/** The flow a request edits, with what the model does not need left out. */
export function compactFlow(flow: SerializedFlow): unknown {
  return {
    version: flow.version,
    nodes: flow.nodes.map((n) => ({
      id: n.id,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      params: n.params,
    })),
    edges: flow.edges,
  };
}

export interface FlowEditContext {
  /** The flow in the graph now, or null when it has no blocks. */
  flow: SerializedFlow | null;
  /** Ids of the blocks selected in the graph. */
  selectedNodeIds: string[];
  /** Earlier turns of this conversation, oldest first. */
  history: ChatTurn[];
}

/**
 * `request` with the conversation so far, the flow in the graph and the
 * selected blocks (the Flow version of `ai/editContext.ts`'s
 * `buildEditRequest`). With no context at all it is sent as-is.
 */
export function buildFlowEditRequest(request: string, ctx: FlowEditContext): string {
  const sections: string[] = [];
  const history = historySection(ctx.history);
  if (history) sections.push(history);

  if (ctx.flow && ctx.flow.nodes.length > 0) {
    let section =
      "## Current flow\n\n" +
      "The graph already holds this flow. Treat the request as an edit of it: " +
      "keep every block, id, wire, and setting the request does not ask to change, " +
      "and output the COMPLETE updated flow (all blocks and wires, not a diff). " +
      "Only build a new flow from scratch when the request clearly asks for " +
      "something unrelated to this one.\n\n" +
      "```json\n" +
      JSON.stringify(compactFlow(ctx.flow)) +
      "\n```";
    const selected = ctx.flow.nodes.filter((n) => ctx.selectedNodeIds.includes(n.id));
    if (selected.length > 0) {
      const names = selected.map((n) => `\`${n.id}\` (${n.params.type})`).join(", ");
      section +=
        `\n\nSelected in the graph: ${names}. When the request says "this", ` +
        '"the selected block", or does not name a block, it means these.';
    }
    sections.push(section);
  }

  if (sections.length === 0) return request;
  sections.push(`## Request\n\n${request}`);
  return sections.join("\n\n");
}
