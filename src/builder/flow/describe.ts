/**
 * The words, icons and colours a Flow block is shown with: its category (the
 * viewer's node categories, so a block looks like a pipeline node of the same
 * kind), its title, its one-line summary, and what its last run says.
 */

import type { ReactNode } from "react";
import { CATEGORY_ICONS } from "../../components/nodes/categoryIcons";
import type { CardStatus } from "../../components/graph/NodeCardView";
import { DATA_TYPE_COLORS, NODE_CATEGORY_COLORS, type NodeCategory } from "../../pipeline/types";
import type { LibraryMolecule } from "../library/types";
import { bulkStructureInfo } from "../../crystal/bulk";
import type { FlowParams, NodeRun } from "./types";

export { blockName, blockTitle, moleculeName } from "./titles";

/**
 * A number as a card prints it: `?` for one that is not a number (a field
 * left blank in an older flow file), so a card never reads "NaN".
 */
export function fmt(value: number): string {
  return Number.isFinite(value) ? String(value) : "?";
}

function fmtAll(values: number[], sep: string): string {
  return values.map(fmt).join(sep);
}

/**
 * The colour of what a Flow wire carries: a structure, drawn like the
 * viewer's particle data.
 */
export const STRUCTURE_COLOR = DATA_TYPE_COLORS.particle;

/** The viewer category a block is drawn as: blocks that start a structure load data, the rest change it. */
export function blockCategory(params: FlowParams): NodeCategory {
  switch (params.type) {
    case "molecule":
    case "document":
    case "crystal":
    case "polymer":
      return "data_load";
    default:
      return "modify";
  }
}

export function blockIcon(params: FlowParams): ReactNode {
  return CATEGORY_ICONS[blockCategory(params)];
}

export function blockColor(params: FlowParams): string {
  return NODE_CATEGORY_COLORS[blockCategory(params)];
}

/** A crystal block's species and prototype in a few words, e.g. `NaCl rocksalt (AB)`. */
function crystalSettings(params: Extract<FlowParams, { type: "crystal" }>): string {
  const info = bulkStructureInfo(params.structure);
  const species = params.elements.slice(0, info.species).map((e) => e.trim() || "?");
  return `${species.join("")} ${info.label}, a = ${fmt(params.a)} Å`;
}

/** What the block is set to, in a few words ("" for a tool: its result says it). */
export function blockSettings(params: FlowParams, library: LibraryMolecule[]): string {
  switch (params.type) {
    case "molecule":
      if (params.source === "library") {
        const m = library.find((x) => x.id === params.libraryId);
        return m ? `${params.name.trim() || m.name} (${m.formula})` : "No molecule chosen";
      }
      return params.smiles.trim() ? `SMILES ${params.smiles.trim()}` : "No SMILES yet";
    case "document":
      return "From Manual mode";
    case "tool":
      return "";
    case "crystal":
      return crystalSettings(params);
    case "polymer":
      return `${params.name.trim() || params.repeatUnit.trim()} × ${fmt(params.length)}`;
    case "supercell":
      return fmtAll(params.repeat, " × ");
    case "slab":
      return `(${fmtAll(params.miller, " ")}) · ${fmt(params.layers)} layer${params.layers === 1 ? "" : "s"} · ${fmtAll(params.repeat, " × ")}`;
    case "adsorb":
      return `${fmtAll(params.grid, " × ")} at ${fmt(params.height)} Å`;
  }
}

/** What the last run says, in one line. */
export function runStatusText(run: NodeRun): string {
  switch (run.status) {
    case "idle":
      return "Not run yet";
    case "stale":
      return "Changed; run again";
    case "running":
      return run.fraction !== null
        ? `Running… ${Math.round(run.fraction * 100)}%`
        : (run.message ?? "Running…");
    case "done": {
      const n = run.data?.snapshot.nAtoms ?? 0;
      return `${n} atom${n === 1 ? "" : "s"}${run.warnings.length > 0 ? " · warnings" : ""}`;
    }
    case "error":
      return run.error ?? "Failed";
  }
}

/** The card's one line: the settings, then how the last run went. */
export function blockSummary(params: FlowParams, run: NodeRun, library: LibraryMolecule[]): string {
  const settings = blockSettings(params, library);
  const result =
    run.status === "error"
      ? "Failed"
      : run.status === "idle" && blockCategory(params) === "data_load"
        ? ""
        : runStatusText(run);
  return [settings, result].filter(Boolean).join(" · ");
}

/** Colour of the result-with-warnings dot. */
export const WARNING_COLOR = "#f59e0b";

/** Colour of the stale ring: grey, drawn hollow, so it is not read as a warning. */
export const STALE_COLOR = "#94a3b8";

/** Colour of the status dot. */
export function runStatusColor(run: NodeRun): string {
  switch (run.status) {
    case "done":
      return run.warnings.length > 0 ? WARNING_COLOR : "#10b981";
    case "running":
      return "var(--megane-primary, #3b82f6)";
    case "error":
      return "var(--megane-danger, #ef4444)";
    case "stale":
      return STALE_COLOR;
    default:
      return "var(--megane-border-strong, #cbd5e1)";
  }
}

/** A stale result is drawn as a hollow ring rather than a filled dot. */
export function runStatusHollow(run: NodeRun): boolean {
  return run.status === "stale";
}

/** What the dot means, for screen readers and the tooltip's first line. */
export function runStatusLabel(run: NodeRun): string {
  switch (run.status) {
    case "idle":
      return "Not run yet";
    case "stale":
      return "Out of date: changed since the last run";
    case "running":
      return "Running";
    case "done":
      return run.warnings.length > 0 ? "Done, with warnings" : "Done";
    case "error":
      return "Failed";
  }
}

/** The card's status dot, or none for a block that never ran. */
export function runStatusDot(run: NodeRun): CardStatus | null {
  if (run.status === "idle") return null;
  return {
    color: runStatusColor(run),
    title: [runStatusText(run), ...run.warnings].join("\n"),
    testId: "builder-flow-node-status",
    hollow: runStatusHollow(run),
    ariaLabel: `${runStatusLabel(run)}: ${runStatusText(run)}`,
  };
}
