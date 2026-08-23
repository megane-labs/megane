/**
 * Pipeline template definitions.
 * Each template provides a predefined pipeline configuration
 * that users can load from the Templates dropdown.
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";

export interface PipelineTemplate {
  id: string;
  label: string;
  description: string;
  create: () => { nodes: Node<PipelineNodeData>[]; edges: Edge[] };
}

/**
 * Molecule template: simplified caffeine visualization.
 * LoadStructure → Symmetry → Wrap → AddBond → Viewport
 *              → LoadTrajectory → Symmetry → Wrap → Viewport
 * The Symmetry node defaults to mode "expand" (a no-op without space-group
 * operations); the Wrap node defaults to mode "none" (pass-through) so
 * wrap/unwrap is a one-click toggle.
 */
function createMoleculeTemplate(): {
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
        id: "addbond-1",
        type: "add_bond",
        position: { x: 425, y: 615 },
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
        position: { x: 425, y: 920 },
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
        target: "traj-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e3",
        source: "traj-1",
        target: "symmetry-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
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
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e6",
        source: "wrap-1",
        target: "addbond-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e7",
        source: "wrap-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e8",
        source: "loader-1",
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
        source: "wrap-1",
        target: "viewport-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
    ],
  };
}

/**
 * Molecular crystal template: glycine molecules completed across periodic
 * boundaries.
 *
 *                                    ┌→ AddBond ───────────────┐
 * LoadStructure → Symmetry → Wrap ───┤                         ├→ BoundaryCompletion → Viewport
 *                                    └→ DrawingBoundary ──────┘
 *
 * Symmetry expansion first fills the unit cell from the CIF's asymmetric
 * unit; wrapping then gives Drawing Boundary a normalized home-cell
 * structure. Boundary Completion follows the periodic bond topology and adds
 * whole finite molecules that intersect the selected drawing range.
 */
function createMolecularCrystalTemplate(): {
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
            fileName: "glycine_csd.cif",
            hasTrajectory: false,
            hasCell: true,
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
        position: { x: 425, y: 340 },
        data: {
          params: {
            type: "wrap",
            mode: "wrap",
          },
          enabled: true,
        },
      },
      {
        id: "addbond-1",
        type: "add_bond",
        position: { x: 170, y: 525 },
        data: {
          params: {
            type: "add_bond",
            bondSource: "distance",
          },
          enabled: true,
        },
      },
      {
        id: "drawing-boundary-1",
        type: "drawing_boundary",
        position: { x: 680, y: 525 },
        data: {
          params: {
            type: "drawing_boundary",
            xMin: 0,
            xMax: 1,
            yMin: 0,
            yMax: 1,
            zMin: 0,
            zMax: 1,
          },
          enabled: true,
        },
      },
      {
        id: "boundary-completion-1",
        type: "boundary_completion",
        position: { x: 425, y: 735 },
        data: {
          params: {
            type: "boundary_completion",
            mode: "components",
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 980 },
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
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e3",
        source: "wrap-1",
        target: "addbond-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e4",
        source: "wrap-1",
        target: "drawing-boundary-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e5",
        source: "drawing-boundary-1",
        target: "boundary-completion-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e6",
        source: "addbond-1",
        target: "boundary-completion-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e7",
        source: "boundary-completion-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e8",
        source: "boundary-completion-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e9",
        source: "loader-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
    ],
  };
}

/**
 * Solid template: perovskite SrTiO3 with coordination polyhedra.
 * LoadStructure → Symmetry → Wrap → DrawingBoundary → Coordination → Polyhedra → Viewport
 *                                                        └──────────→ Viewport (bond)
 */
function createSolidTemplate(): {
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
            fileName: "perovskite_srtio3_3x3x3.xyz",
            hasTrajectory: false,
            hasCell: true,
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
        position: { x: 425, y: 330 },
        data: {
          params: {
            type: "wrap",
            mode: "none",
          },
          enabled: true,
        },
      },
      {
        id: "drawing-boundary-1",
        type: "drawing_boundary",
        position: { x: 425, y: 505 },
        data: {
          params: {
            type: "drawing_boundary",
            xMin: 0,
            xMax: 1,
            yMin: 0,
            yMax: 1,
            zMin: 0,
            zMax: 1,
          },
          enabled: true,
        },
      },
      {
        id: "coordination-1",
        type: "coordination_generator",
        position: { x: 425, y: 685 },
        data: {
          params: {
            type: "coordination_generator",
            excludedCenters: [],
            excludedLigands: [],
            cutoffTolerance: 1.15,
            boundaryMode: "complete",
          },
          enabled: true,
        },
      },
      {
        id: "polyhedron-1",
        type: "polyhedron_generator",
        position: { x: 680, y: 860 },
        data: {
          params: {
            type: "polyhedron_generator",
            opacity: 0.5,
            showEdges: false,
            edgeColor: "#dddddd",
            edgeWidth: 3,
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 1075 },
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
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e3",
        source: "wrap-1",
        target: "drawing-boundary-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e4",
        source: "drawing-boundary-1",
        target: "coordination-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e5",
        source: "drawing-boundary-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e6",
        source: "loader-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e7",
        source: "coordination-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e8",
        source: "coordination-1",
        target: "polyhedron-1",
        sourceHandle: "coordination",
        targetHandle: "coordination",
      },
      {
        id: "e9",
        source: "polyhedron-1",
        target: "viewport-1",
        sourceHandle: "mesh",
        targetHandle: "mesh",
      },
    ],
  };
}

/**
 * Surface mesh template: quartz SiO2 wrapped in an OVITO-style alpha-shape
 * surface mesh.
 * LoadStructure → Symmetry → Wrap → SurfaceMesh → Viewport (mesh)
 *                                → Viewport (particle)
 *              → Viewport (cell)
 * The Symmetry node defaults to mode "expand" (a no-op without space-group
 * operations); the Wrap node defaults to mode "none" (pass-through).
 */
function createSurfaceMeshTemplate(): {
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
            fileName: "quartz_sio2_2x2x2.xyz",
            hasTrajectory: false,
            hasCell: true,
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
        id: "surface-1",
        type: "surface_mesh",
        position: { x: 680, y: 615 },
        data: {
          params: {
            type: "surface_mesh",
            alphaRadius: 3.0,
            color: "#4488ff",
            opacity: 0.5,
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 920 },
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
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e3",
        source: "wrap-1",
        target: "surface-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e4",
        source: "wrap-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e5",
        source: "loader-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
      {
        id: "e6",
        source: "surface-1",
        target: "viewport-1",
        sourceHandle: "mesh",
        targetHandle: "mesh",
      },
    ],
  };
}

/**
 * Streaming template: WebSocket streaming with bonds and trajectory.
 * Streaming → Viewport (particle, bond, trajectory, cell)
 */
function createStreamingTemplate(): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  return {
    nodes: [
      {
        id: "streaming-1",
        type: "streaming",
        position: { x: 425, y: 0 },
        data: {
          params: {
            type: "streaming",
            connected: false,
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 310 },
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
        source: "streaming-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e2",
        source: "streaming-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e3",
        source: "streaming-1",
        target: "viewport-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
      {
        id: "e4",
        source: "streaming-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
    ],
  };
}

/**
 * Protein template: ubiquitin (1UBQ) as a ribbon with semi-transparent
 * all-atom water.
 *
 *   LoadStructure → Symmetry → Wrap ─┬─ Filter(resname != "HOH") → Modify(opacity 0)   → Representation(both) ─┐
 *                                    ├─ Filter(resname == "HOH") → Modify(opacity 0.5) ───────────────────────┤
 *                 └────────────────────────── cell ───────────────────────────────────────────────────────────┴─→ Viewport
 *
 * The Symmetry node defaults to mode "expand" (a no-op without space-group
 * operations); the Wrap node defaults to mode "none" (pass-through).
 *
 * Protein atoms are hidden (opacity 0) so only the cartoon ribbon shows;
 * water atoms render as translucent spheres because they have no Cα and
 * therefore inherit no ribbon. Representation "both" makes the global
 * viewport mode draw atoms + cartoon, which is what each branch needs.
 */
function createProteinTemplate(): {
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
            fileName: "1ubq.pdb",
            hasTrajectory: false,
            hasCell: true,
          },
          enabled: true,
        },
      },
      {
        id: "symmetry-1",
        type: "symmetry",
        position: { x: 425, y: 130 },
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
        position: { x: 425, y: 305 },
        data: {
          params: {
            type: "wrap",
            mode: "none",
          },
          enabled: true,
        },
      },
      {
        id: "protein-filter",
        type: "filter",
        position: { x: 170, y: 505 },
        data: {
          params: {
            type: "filter",
            query: 'resname != "HOH"',
          },
          enabled: true,
        },
      },
      {
        id: "protein-modify",
        type: "modify",
        position: { x: 170, y: 665 },
        data: {
          params: {
            type: "modify",
            scale: 1,
            opacity: 0,
          },
          enabled: true,
        },
      },
      {
        id: "protein-rep",
        type: "representation",
        position: { x: 170, y: 825 },
        data: {
          params: {
            type: "representation",
            mode: "both",
          },
          enabled: true,
        },
      },
      {
        id: "water-filter",
        type: "filter",
        position: { x: 680, y: 505 },
        data: {
          params: {
            type: "filter",
            query: 'resname == "HOH"',
          },
          enabled: true,
        },
      },
      {
        id: "water-modify",
        type: "modify",
        position: { x: 680, y: 665 },
        data: {
          params: {
            type: "modify",
            scale: 1,
            opacity: 0.5,
          },
          enabled: true,
        },
      },
      {
        id: "viewport-1",
        type: "viewport",
        position: { x: 425, y: 1005 },
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
        source: "symmetry-1",
        target: "wrap-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e3",
        source: "wrap-1",
        target: "protein-filter",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e4",
        source: "protein-filter",
        target: "protein-modify",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e5",
        source: "protein-modify",
        target: "protein-rep",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e6",
        source: "protein-rep",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e7",
        source: "wrap-1",
        target: "water-filter",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e8",
        source: "water-filter",
        target: "water-modify",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e9",
        source: "water-modify",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e10",
        source: "loader-1",
        target: "viewport-1",
        sourceHandle: "cell",
        targetHandle: "cell",
      },
    ],
  };
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "molecule",
    label: "Molecule",
    description: "Caffeine with bonds and trajectory",
    create: createMoleculeTemplate,
  },
  {
    id: "molecular_crystal",
    label: "Molecular Crystal",
    description: "Glycine crystal with complete molecules across cell boundaries",
    create: createMolecularCrystalTemplate,
  },
  {
    id: "solid",
    label: "Solid",
    description: "Perovskite with coordination polyhedra",
    create: createSolidTemplate,
  },
  {
    id: "surface_mesh",
    label: "Surface Mesh",
    description: "Quartz SiO2 with OVITO-style alpha-shape surface envelope",
    create: createSurfaceMeshTemplate,
  },
  {
    id: "protein",
    label: "Protein",
    description: "Ubiquitin ribbon with semi-transparent water",
    create: createProteinTemplate,
  },
  {
    id: "streaming",
    label: "Streaming",
    description: "WebSocket streaming with bonds",
    create: createStreamingTemplate,
  },
];
