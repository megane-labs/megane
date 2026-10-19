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
import type { BuilderToolInfo } from "../tools/contract";
import { bulkStructureInfo } from "../../crystal/bulk";
import type { FlowParams, NodeRun } from "./types";

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

export function blockTitle(params: FlowParams, tool: BuilderToolInfo | null): string {
  switch (params.type) {
    case "molecule":
      return "Molecule";
    case "document":
      return "Manual structure";
    case "tool":
      return tool?.label ?? (params.label || params.tool);
    case "crystal":
      return "Bulk crystal";
    case "polymer":
      return "Polymer chain";
    case "supercell":
      return "Supercell";
    case "slab":
      return "Slab";
    case "adsorb":
      return "Place on surface";
  }
}

/** A crystal block's species and prototype in a few words, e.g. `NaCl rocksalt (AB)`. */
function crystalSettings(params: Extract<FlowParams, { type: "crystal" }>): string {
  const info = bulkStructureInfo(params.structure);
  const species = params.elements.slice(0, info.species).map((e) => e.trim() || "?");
  return `${species.join("")} ${info.label}, a = ${params.a} Å`;
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
      return `${params.name.trim() || params.repeatUnit.trim()} × ${params.length}`;
    case "supercell":
      return params.repeat.join(" × ");
    case "slab":
      return `(${params.miller.join(" ")}) · ${params.layers} layer${params.layers === 1 ? "" : "s"} · ${params.repeat.join(" × ")}`;
    case "adsorb":
      return `${params.grid.join(" × ")} at ${params.height} Å`;
  }
}

/**
 * The name the block's structure goes by before it has run: the molecule's
 * name, else its SMILES or library entry; the block's title otherwise.
 */
export function blockName(
  params: FlowParams,
  tool: BuilderToolInfo | null,
  library: LibraryMolecule[],
): string {
  if (params.type === "molecule") {
    if (params.name.trim()) return params.name.trim();
    if (params.source === "smiles" && params.smiles.trim()) return params.smiles.trim();
    const m = library.find((x) => x.id === params.libraryId);
    if (params.source === "library" && m) return m.name;
  }
  if (params.type === "polymer" && params.name.trim()) return params.name.trim();
  return blockTitle(params, tool);
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

/** Colour of the status dot. */
export function runStatusColor(run: NodeRun): string {
  switch (run.status) {
    case "done":
      return run.warnings.length > 0 ? "#f59e0b" : "#10b981";
    case "running":
      return "var(--megane-primary, #3b82f6)";
    case "error":
      return "var(--megane-danger, #ef4444)";
    case "stale":
      return "#f59e0b";
    default:
      return "var(--megane-border-strong, #cbd5e1)";
  }
}

/** The card's status dot, or none for a block that never ran. */
export function runStatusDot(run: NodeRun): CardStatus | null {
  if (run.status === "idle") return null;
  return {
    color: runStatusColor(run),
    title: [runStatusText(run), ...run.warnings].join("\n"),
    testId: "builder-flow-node-status",
  };
}
