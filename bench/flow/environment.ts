/**
 * The Builder a Flow benchmark case runs in: what the assistant is told
 * (`FlowPromptContext`) and what a Run reaches (`FlowDeps`), built in Node.
 *
 * Everything that can be the production code is: the library is the
 * Builder's preset molecules, the tool listing is the reference tool
 * server's recorded `tools/list` (`tests/fixtures/builder-tools/`), a Manual
 * structure is built by the Builder's own crystal code, and SMILES are
 * embedded by the same `megane-rdkit` WebAssembly build with the options
 * `embedSketch` passes. Only two things differ, because Node has neither:
 * the embedding runs in-process rather than in a Web Worker, and its mol
 * block is read by a small V2000 reader rather than the WASM MOL parser.
 *
 * A tool call is answered with the reference server's recorded result for
 * that tool, whatever the arguments: the benchmark has no packmol. What the
 * call was *asked* to do is recorded (`ToolCall`) and graded instead.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadRDKit, type RDKit } from "megane-rdkit";
import { bulkSnapshot } from "@/crystal/bulk";
import { elementFromSymbol } from "@/crystal/bulk";
import { crystalSpec, defaultBuiltinParams } from "@/builder/flow/builtins";
import type { FlowDeps } from "@/builder/flow/engine";
import type { FlowPromptContext } from "@/builder/flow/ai/prompt";
import type { CrystalParams, FlowData } from "@/builder/flow/types";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import { interpretCall, type RawCallResult } from "@/builder/tools/client";
import { parseTools, type BuilderToolInfo, type McpTool } from "@/builder/tools/contract";
import { structureToSnapshot } from "@/builder/tools/payload";
import type { Snapshot } from "@/types";
import type { FlowSetup, ManualStructure } from "./types";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "builder-tools");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

/** The reference tool server's tools, as the Builder lists them. */
export function referenceTools(): BuilderToolInfo[] {
  return parseTools(fixture<{ tools: McpTool[] }>("tools-list.json").tools).tools;
}

/** The reference server's recorded result for `tool`, or null when none was recorded. */
export function recordedResult(tool: string): RawCallResult | null {
  try {
    return fixture<{ result: RawCallResult }>(`call-${tool}.json`).result;
  } catch {
    return null;
  }
}

/** The structures a case can have open in Manual mode, built by the Builder's crystal code. */
export function manualStructure(kind: ManualStructure): FlowData {
  const base = defaultBuiltinParams("crystal") as CrystalParams;
  const params: CrystalParams =
    kind === "nacl-cell"
      ? { ...base, structure: "rocksalt", elements: ["Na", "Cl", ""], a: 5.64 }
      : { ...base, elements: ["Cu", "", ""], a: 3.61 };
  const name = kind === "nacl-cell" ? "NaCl.cif" : "Cu.cif";
  return { name, snapshot: bulkSnapshot(crystalSpec(params)), labels: null };
}

// ─── RDKit in Node ────────────────────────────────────────────────────

let rdkit: Promise<RDKit> | null = null;

/** The `megane-rdkit` module, loaded once per process from the installed package. */
export function getRDKit(): Promise<RDKit> {
  if (!rdkit) {
    const wasm = createRequire(join(process.cwd(), "package.json")).resolve(
      "megane-rdkit/dist/megane-rdkit.wasm",
    );
    rdkit = loadRDKit({ locateFile: () => wasm }).catch((err: unknown) => {
      rdkit = null;
      throw err;
    });
  }
  return rdkit;
}

/**
 * The atoms, positions and bonds of a V2000 mol block, as the structure a
 * tool or the MOL parser would hand back. Charges and isotopes are not read:
 * nothing the benchmark grades depends on them.
 */
export function readMolblock(molblock: string): Snapshot {
  const lines = molblock.split("\n");
  const counts = lines.findIndex((l) => l.includes("V2000"));
  if (counts < 0) throw new Error("Not a V2000 mol block.");
  const nAtoms = Number(lines[counts].slice(0, 3));
  const nBonds = Number(lines[counts].slice(3, 6));
  const elements: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < nAtoms; i++) {
    const line = lines[counts + 1 + i];
    positions.push(
      Number(line.slice(0, 10)),
      Number(line.slice(10, 20)),
      Number(line.slice(20, 30)),
    );
    const z = elementFromSymbol(line.slice(31, 34).trim());
    if (z === null) throw new Error(`Unknown element in mol block: ${line.slice(31, 34)}`);
    elements.push(z);
  }
  const bonds: [number, number][] = [];
  const bondOrders: number[] = [];
  for (let b = 0; b < nBonds; b++) {
    const line = lines[counts + 1 + nAtoms + b];
    bonds.push([Number(line.slice(0, 3)) - 1, Number(line.slice(3, 6)) - 1]);
    bondOrders.push(Number(line.slice(6, 9)));
  }
  return structureToSnapshot({ elements, positions, cell: null, bonds, bondOrders });
}

/** Embed a SMILES string as the Builder does (`embedSketch`'s options), in-process. */
export async function embedSmilesInNode(smiles: string): Promise<Snapshot> {
  const module = await getRDKit();
  const result = module.embed(smiles, {
    format: "auto",
    sanitize: true,
    addHs: true,
    removeHs: false,
    numConfs: 1,
    forceField: "MMFF94s",
  });
  return readMolblock(result.molblocks[0]);
}

// ─── The case's Builder ───────────────────────────────────────────────

/** One call a Run made to the tool server, with the arguments it built. */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** What one case runs against. */
export interface FlowEnvironment {
  /** What the system prompt and the self-check are given, as the Flow panel builds it. */
  prompt: FlowPromptContext;
  /** What a Run reaches. */
  deps: FlowDeps;
  /** Every tool call a Run made, in order. */
  calls: ToolCall[];
}

/** The Builder a case describes. */
export function environmentFor(setup: FlowSetup): FlowEnvironment {
  const tools = setup.tools ? referenceTools() : null;
  const document = setup.document ? manualStructure(setup.document) : null;
  const calls: ToolCall[] = [];
  const library = [...PRESET_MOLECULES];
  return {
    calls,
    prompt: {
      library,
      tools,
      hostHasTools: true,
      document: document
        ? {
            name: document.name,
            atoms: document.snapshot.nAtoms,
            cell: !!document.snapshot.box,
          }
        : null,
    },
    deps: {
      embedSmiles: embedSmilesInNode,
      library: () => library,
      document: () => (document ? { data: document, key: `doc-${setup.document}` } : null),
      tool: (name) => tools?.find((t) => t.name === name) ?? null,
      call: async (tool, args) => {
        calls.push({ tool: tool.name, args });
        const recorded = recordedResult(tool.name);
        if (!recorded) return { ok: false, error: `No recorded result for ${tool.name}.` };
        return interpretCall(recorded);
      },
    },
  };
}
