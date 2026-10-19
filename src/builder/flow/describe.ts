/**
 * The words a Flow block is shown with: its title, the line under it, and
 * what its last run says.
 */

import type { LibraryMolecule } from "../library/types";
import type { BuilderToolInfo } from "../tools/contract";
import type { FlowParams, NodeRun } from "./types";

export function blockTitle(params: FlowParams, tool: BuilderToolInfo | null): string {
  switch (params.type) {
    case "molecule":
      return "Molecule";
    case "document":
      return "Manual structure";
    case "tool":
      return tool?.label ?? (params.label || params.tool);
  }
}

/** The block's own settings in a few words. */
export function blockSubtitle(params: FlowParams, library: LibraryMolecule[]): string {
  switch (params.type) {
    case "molecule":
      if (params.source === "library") {
        const m = library.find((x) => x.id === params.libraryId);
        return m ? `${params.name.trim() || m.name} (${m.formula})` : "No molecule chosen";
      }
      return params.smiles.trim() ? `SMILES ${params.smiles.trim()}` : "No SMILES yet";
    case "document":
      return "The structure open in Manual mode";
    case "tool":
      return "Tool server";
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
