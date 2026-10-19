/** Shared fixtures for the Flow mode tests: a molecule, the recorded tools, fake deps. */
import { vi } from "vitest";
import { parseResult, parseTools, type BuilderToolInfo } from "@/builder/tools/contract";
import type { CallOutcome } from "@/builder/tools/client";
import type { FlowDeps } from "@/builder/flow/engine";
import type { FlowData } from "@/builder/flow/types";
import type { LibraryMolecule } from "@/builder/library/types";
import type { Snapshot } from "@/types";
import { CALLS, TOOLS } from "../tools/fixtures";

export const tools = Object.fromEntries(parseTools(TOOLS).tools.map((t) => [t.name, t])) as Record<
  string,
  BuilderToolInfo
>;

export function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

export function waterData(name = "water"): FlowData {
  return { name, snapshot: water(), labels: null };
}

export const LIB_WATER: LibraryMolecule = {
  id: "preset:water",
  name: "water",
  formula: "H2O",
  origin: "preset",
  elements: [8, 1, 1],
  positions: [0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0],
  bonds: [
    [0, 1],
    [0, 2],
  ],
};

export const recorded = (name: string): CallOutcome => ({
  ok: true,
  result: parseResult(CALLS[name].result.structuredContent),
  summary: `${name} done.`,
});

export function fakeDeps(overrides: Partial<FlowDeps> = {}): FlowDeps & {
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    embedSmiles: vi.fn(async () => water()),
    library: () => [LIB_WATER],
    document: () => null,
    tool: (name) => tools[name] ?? null,
    call: vi.fn(async (tool, args) => {
      calls.push({ name: tool.name, args });
      return recorded(tool.name);
    }),
    ...overrides,
  };
}
