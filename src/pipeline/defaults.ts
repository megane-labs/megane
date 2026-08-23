/**
 * Default pipeline configuration.
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";

/**
 * Create the default pipeline: caffeine with bonds and trajectory.
 * LoadStructure → Symmetry → Wrap → Replicate → AddBond → Viewport
 *              → LoadTrajectory → Symmetry → Wrap → Replicate → Viewport
 * The Symmetry node defaults to mode "expand" (a no-op for structures without
 * space-group operations) so a loaded CIF fills its unit cell; the Wrap node
 * defaults to mode "none" (pass-through) so wrap/unwrap is a one-click toggle
 * without changing what renders by default.
 */
export function createDefaultPipeline(): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  return {
    nodes: [
      {
        id: "loader-1",
        type: "load_structure",
        position: { x: 425, y: 0 },
        data: {
          params: {
            type: "load_structure",
            fileName: "caffeine_water.pdb",
            hasTrajectory: false,
            hasCell: true,
          },
          enabled: true,
        },
      },
      {
        id: "traj-1",
        type: "load_trajectory",
        position: { x: 85, y: 155 },
        data: {
          params: {
            type: "load_trajectory",
            fileName: "caffeine_water_vibration.xtc",
          },
          enabled: true,
        },
      },
      {
        id: "symmetry-1",
        type: "symmetry",
        position: { x: 425, y: 155 },
        data: {
          params: {
            type: "symmetry",
            mode: "expand",
          },
          enabled: true,
        },
      },
      {
        id: "wrap-1",
        type: "wrap",
        position: { x: 425, y: 360 },
        data: {
          params: {
            type: "wrap",
            mode: "none",
          },
          enabled: true,
        },
      },
      {
        id: "replicate-1",
        type: "replicate",
        position: { x: 425, y: 565 },
        data: {
          params: {
            type: "replicate",
            nx: 1,
            ny: 1,
            nz: 1,
          },
          enabled: true,
        },
      },
      {
        id: "addbond-1",
        type: "add_bond",
        position: { x: 425, y: 770 },
        data: {
          params: {
            type: "add_bond",
            bondSource: "structure",
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 1025 },
        data: {
          params: {
            type: "viewport",
            perspective: false,
            cellAxesVisible: true,
            pivotMarkerVisible: true,
          },
          enabled: true,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "loader-1",
        target: "symmetry-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e2",
        source: "loader-1",
        target: "replicate-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e3",
        source: "loader-1",
        target: "traj-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e4",
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e5",
        source: "wrap-1",
        target: "replicate-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e6",
        source: "replicate-1",
        target: "addbond-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e7",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e8",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e9",
        source: "addbond-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e10",
        source: "traj-1",
        target: "symmetry-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e11",
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e12",
        source: "wrap-1",
        target: "replicate-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e13",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
    ],
  };
}

/**
 * Create a minimal pipeline for hosting an externally-loaded structure file.
 *
 * The shape mirrors `createDefaultPipeline` (LoadStructure → Symmetry → Wrap
 * → Replicate → AddBond → Viewport with a LoadTrajectory branch), but every
 * `fileName` is left empty so that
 * `usePipelineStore.openFile` (or another caller) can populate it from the
 * actually-clicked file. Used as the seed graph by `openFile` whenever the
 * current pipeline has no `load_structure` node or `mode: "replace"` is
 * requested.
 */
export function createMinimalStructurePipeline(): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  return {
    nodes: [
      {
        id: "loader-1",
        type: "load_structure",
        position: { x: 425, y: 0 },
        data: {
          params: {
            type: "load_structure",
            fileName: "",
            hasTrajectory: false,
            hasCell: false,
          },
          enabled: true,
        },
      },
      {
        id: "traj-1",
        type: "load_trajectory",
        position: { x: 85, y: 155 },
        data: {
          params: {
            type: "load_trajectory",
            fileName: "",
          },
          enabled: true,
        },
      },
      {
        id: "symmetry-1",
        type: "symmetry",
        position: { x: 425, y: 155 },
        data: {
          params: {
            type: "symmetry",
            mode: "expand",
          },
          enabled: true,
        },
      },
      {
        id: "wrap-1",
        type: "wrap",
        position: { x: 425, y: 360 },
        data: {
          params: {
            type: "wrap",
            mode: "none",
          },
          enabled: true,
        },
      },
      {
        id: "replicate-1",
        type: "replicate",
        position: { x: 425, y: 565 },
        data: {
          params: {
            type: "replicate",
            nx: 1,
            ny: 1,
            nz: 1,
          },
          enabled: true,
        },
      },
      {
        id: "addbond-1",
        type: "add_bond",
        position: { x: 425, y: 770 },
        data: {
          params: {
            type: "add_bond",
            bondSource: "structure",
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 1025 },
        data: {
          params: {
            type: "viewport",
            perspective: false,
            cellAxesVisible: true,
            pivotMarkerVisible: true,
          },
          enabled: true,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "loader-1",
        target: "symmetry-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e2",
        source: "loader-1",
        target: "replicate-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e3",
        source: "loader-1",
        target: "traj-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e4",
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e5",
        source: "wrap-1",
        target: "replicate-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e6",
        source: "replicate-1",
        target: "addbond-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e7",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e8",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e9",
        source: "addbond-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e10",
        source: "traj-1",
        target: "symmetry-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e11",
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e12",
        source: "wrap-1",
        target: "replicate-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e13",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
    ],
  };
}

/**
 * Create a basic pipeline with LoadStructure → Symmetry → Wrap → Replicate →
 * AddBond → Viewport.
 * Used as the default in the VSCode extension where files are loaded externally.
 * The LoadStructure node reads from the pipeline store's snapshot (set by the
 * webview after parsing), so the molecule renders with bonds automatically.
 * The Symmetry node defaults to mode "expand" (a no-op for structures without
 * space-group operations) so a loaded CIF fills its unit cell; the Wrap node
 * defaults to mode "none" (pass-through) so wrap/unwrap is a one-click toggle
 * without changing what renders by default.
 */
export function createEmptyPipeline(): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  return {
    nodes: [
      {
        id: "loader-1",
        type: "load_structure",
        position: { x: 425, y: 0 },
        data: {
          params: {
            type: "load_structure",
            fileName: "",
            hasTrajectory: false,
            hasCell: false,
          },
          enabled: true,
        },
      },
      {
        id: "symmetry-1",
        type: "symmetry",
        position: { x: 425, y: 200 },
        data: {
          params: {
            type: "symmetry",
            mode: "expand",
          },
          enabled: true,
        },
      },
      {
        id: "wrap-1",
        type: "wrap",
        position: { x: 425, y: 400 },
        data: {
          params: {
            type: "wrap",
            mode: "none",
          },
          enabled: true,
        },
      },
      {
        id: "replicate-1",
        type: "replicate",
        position: { x: 425, y: 600 },
        data: {
          params: {
            type: "replicate",
            nx: 1,
            ny: 1,
            nz: 1,
          },
          enabled: true,
        },
      },
      {
        id: "addbond-1",
        type: "add_bond",
        position: { x: 425, y: 800 },
        data: {
          params: {
            type: "add_bond",
            bondSource: "structure",
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 1055 },
        data: {
          params: {
            type: "viewport",
            perspective: false,
            cellAxesVisible: true,
            pivotMarkerVisible: true,
          },
          enabled: true,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "loader-1",
        target: "symmetry-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e2",
        source: "loader-1",
        target: "replicate-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e3",
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e4",
        source: "wrap-1",
        target: "replicate-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e5",
        source: "replicate-1",
        target: "addbond-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e6",
        source: "addbond-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e7",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e8",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e9",
        source: "loader-1",
        target: "symmetry-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e10",
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e11",
        source: "wrap-1",
        target: "replicate-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e12",
        source: "replicate-1",
        target: "viewport-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
    ],
  };
}

/**
 * Create a demo pipeline showcasing filter and modify nodes.
 */
export function createDemoPipeline(): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  return {
    nodes: [
      {
        id: "loader-1",
        type: "load_structure",
        position: { x: 425, y: 0 },
        data: {
          params: {
            type: "load_structure",
            fileName: "protein.pdb",
            hasTrajectory: false,
            hasCell: false,
          },
          enabled: true,
        },
      },
      {
        id: "addbond-1",
        type: "add_bond",
        position: { x: 425, y: 255 },
        data: {
          params: {
            type: "add_bond",
            bondSource: "structure",
          },
          enabled: true,
        },
      },
      {
        id: "filter-1",
        type: "filter",
        position: { x: 85, y: 425 },
        data: {
          params: {
            type: "filter",
            query: 'element == "C"',
          },
          enabled: true,
        },
      },
      {
        id: "modify-1",
        type: "modify",
        position: { x: 85, y: 765 },
        data: {
          params: {
            type: "modify",
            scale: 1.5,
            opacity: 0.8,
          },
          enabled: true,
        },
      },
      {
        id: "filter-2",
        type: "filter",
        position: { x: 765, y: 425 },
        data: {
          params: {
            type: "filter",
            query: 'element == "N"',
          },
          enabled: true,
        },
      },
      {
        id: "modify-2",
        type: "modify",
        position: { x: 765, y: 765 },
        data: {
          params: {
            type: "modify",
            scale: 0.5,
            opacity: 0.6,
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 1190 },
        data: {
          params: {
            type: "viewport",
            perspective: false,
            cellAxesVisible: true,
            pivotMarkerVisible: true,
          },
          enabled: true,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "loader-1",
        target: "filter-1",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      { id: "e2", source: "filter-1", target: "modify-1", sourceHandle: "out", targetHandle: "in" },
      {
        id: "e3",
        source: "loader-1",
        target: "filter-2",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      { id: "e4", source: "filter-2", target: "modify-2", sourceHandle: "out", targetHandle: "in" },
      {
        id: "e5",
        source: "modify-1",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e6",
        source: "modify-2",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e7",
        source: "loader-1",
        target: "addbond-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e8",
        source: "addbond-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
    ],
  };
}
