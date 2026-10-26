/**
 * One-line, human-readable summary of a node's parameters, shown in place of
 * the full form when the node is collapsed in the pipeline editor. It names
 * what the node is set to do so the graph reads at a glance without
 * expanding every card.
 */

import type { PipelineNodeParams } from "./types";

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function file(name: string | null | undefined, empty = "No file"): string {
  return name ? name : empty;
}

const BOND_SOURCE_LABELS = {
  structure: "From structure",
  file: "From file",
  distance: "By distance",
  none: "None",
} as const;

export function summarizeNodeParams(params: PipelineNodeParams): string {
  switch (params.type) {
    case "load_structure": {
      const edits = params.edits?.length ?? 0;
      return edits > 0 ? `${file(params.fileName)} · ${edits} edits` : file(params.fileName);
    }
    case "load_trajectory":
      return params.source === "structure"
        ? "Frames from structure"
        : file(params.fileName, "No trajectory");
    case "load_volumetric": {
      if (params.parseError) return `${file(params.fileName)} · load failed`;
      const grid = params.volumetricData;
      return grid
        ? `${file(params.fileName)} · ${grid.nx}×${grid.ny}×${grid.nz} voxels`
        : file(params.fileName);
    }
    case "load_vector":
    case "load_spectrum":
      return file(params.fileName);
    case "streaming":
      return params.connected ? "Connected" : "Disconnected";
    case "add_bond": {
      const label = BOND_SOURCE_LABELS[params.bondSource];
      if (params.bondSource === "file") return `${label}: ${file(params.bondFileName)}`;
      if (params.bondSource === "distance" && params.vdwScale !== undefined) {
        return `${label} ×${fmt(params.vdwScale)}`;
      }
      return label;
    }
    case "coordination_generator": {
      const parts = [`Tolerance ${fmt(params.cutoffTolerance)}`, params.boundaryMode];
      const neighbors = params.neighborQuery?.trim();
      if (neighbors) parts.unshift(`neighbors: ${neighbors}`);
      const centers = params.centerQuery?.trim();
      if (centers) parts.unshift(`centers: ${centers}`);
      return parts.join(" · ");
    }
    case "viewport":
      return params.perspective ? "Perspective" : "Orthographic";
    case "filter": {
      const atoms = params.query.trim() || "All atoms";
      const bonds = params.bond_query?.trim();
      return bonds ? `${atoms} · bonds: ${bonds}` : atoms;
    }
    case "modify":
      return `Scale ${fmt(params.scale)} · Opacity ${pct(params.opacity)}`;
    case "symmetry":
    case "wrap":
    case "representation":
    case "boundary_completion":
      return params.mode;
    case "replicate":
      return `${params.nx} × ${params.ny} × ${params.nz}`;
    case "drawing_boundary":
      return (
        `a ${fmt(params.xMin)}–${fmt(params.xMax)}, ` +
        `b ${fmt(params.yMin)}–${fmt(params.yMax)}, ` +
        `c ${fmt(params.zMin)}–${fmt(params.zMax)}`
      );
    case "color":
      return params.mode === "uniform" ? `uniform ${params.uniformColor}` : params.mode;
    case "label_generator":
      return `Label by ${params.source}`;
    case "polyhedron_generator":
      return `Opacity ${pct(params.opacity)}${params.showEdges ? " · edges" : ""}`;
    case "surface_mesh":
      return `Probe ${fmt(params.alphaRadius)} Å · Opacity ${pct(params.opacity)}`;
    case "vector_overlay":
      return `Scale ${fmt(params.scale)}`;
    case "isosurface":
      return `Level ${fmt(params.isoLevel)}${params.showNegative ? " ±" : ""} · ${params.colorMode}`;
    case "spectrum_plot":
      return params.reverseX ? "Reversed x axis" : "Normal x axis";
  }
}
