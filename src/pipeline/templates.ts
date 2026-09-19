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

/**
 * ESP template: caffeine with its electrostatic potential drawn as a
 * dual-contour isosurface — a molecule and a cube file overlaid in one scene.
 *
 *   LoadStructure(caffeine.sdf) → Symmetry → Wrap ─┬→ AddBond → Viewport (bond)
 *                                                  └────────────→ Viewport (particle)
 *   LoadVolumetric(caffeine_esp.cube) → Isosurface ──────────────→ Viewport (mesh)
 *
 * The two branches never meet inside the pipeline: the structure and the grid
 * are independent data sources that only overlap because they share a
 * coordinate frame (both fixtures come from `generate_caffeine_esp.py`).
 *
 * `showNegative` draws the second contour at −isoLevel, which is what makes
 * this an ESP map rather than a single lobe: blue is the positive potential
 * (over the methyl and imidazole hydrogens), red the negative one (over the
 * two carbonyl oxygens) — the usual chemistry convention.
 *
 * 0.03 Hartree/e is the level the potential just reaches on caffeine's van der
 * Waals surface, so the lobes hug the most polarized regions instead of
 * swelling into a shell around the whole molecule. That also keeps them inside
 * the frame: `fitCameraToView` frames the atoms, and knows nothing about
 * meshes, so a lower level (0.02 reaches 2.5 Å past the outermost atom) is
 * clipped at the viewport edges on first load.
 *
 * The Symmetry node defaults to mode "expand" (a no-op without space-group
 * operations); the Wrap node defaults to mode "none" (pass-through). Caffeine
 * carries no unit cell, so neither loader emits cell data and nothing is wired
 * to the Viewport's cell input.
 */
function createEspTemplate(): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  return {
    nodes: [
      {
        id: "loader-1",
        type: "load_structure",
        position: { x: 170, y: 0 },
        data: {
          params: {
            type: "load_structure",
            fileName: "caffeine.sdf",
            hasTrajectory: false,
            hasCell: false,
          },
          enabled: true,
        },
      },
      {
        id: "symmetry-1",
        type: "symmetry",
        position: { x: 170, y: 155 },
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
        position: { x: 170, y: 360 },
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
        position: { x: 170, y: 615 },
        data: {
          params: {
            type: "add_bond",
            bondSource: "structure",
          },
          enabled: true,
        },
      },
      {
        id: "volumetric-1",
        type: "load_volumetric",
        position: { x: 680, y: 155 },
        data: {
          params: {
            type: "load_volumetric",
            fileName: "caffeine_esp.cube",
          },
          enabled: true,
        },
      },
      {
        id: "isosurface-1",
        type: "isosurface",
        position: { x: 680, y: 440 },
        data: {
          params: {
            type: "isosurface",
            isoLevel: 0.03,
            color: "#3b82f6",
            opacity: 0.55,
            showNegative: true,
            negativeColor: "#ef4444",
            colorMode: "solid",
            colormap: "rwb",
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
        target: "addbond-1",
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
        source: "addbond-1",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
      },
      {
        id: "e6",
        source: "volumetric-1",
        target: "isosurface-1",
        sourceHandle: "volumetric",
        targetHandle: "volumetric",
      },
      {
        id: "e7",
        source: "isosurface-1",
        target: "viewport-1",
        sourceHandle: "mesh",
        targetHandle: "mesh",
      },
    ],
  };
}

/**
 * Coarse-grained overlay template: ubiquitin before and after coarse-graining,
 * superimposed — the all-atom model ghosted behind one bead per residue.
 *
 *   LoadStructure(1ubq.pdb) → Symmetry → Wrap ─┬→ Filter(resname != "HOH") → Modify(opacity 0.3) ─┐
 *                                              └→ Filter(resname == "HOH") → Modify(opacity 0)   ─┤
 *                                                                          Viewport (particle) ←─┘
 *
 *   LoadStructure(1ubq_cg.pdb) ─┬→ Modify(scale 3.2) → Color → Viewport (particle)
 *                               └→ AddBond(structure) ───────→ Viewport (bond)
 *
 * Two `load_structure` nodes feed one Viewport. The pipeline never merges them
 * — they render as separate structure layers that line up because
 * `generate_1ubq_cg.py` places every bead at its residue's center of mass in
 * 1ubq.pdb's own coordinate frame.
 *
 * Why each node is here:
 *  - The two water filters make the models correspond one-to-one: the CG file
 *    has beads for the 76 amino acids only, not the 58 crystallographic
 *    waters. Both branches are needed, not just the protein one — a Modify
 *    behind a Filter writes its opacity **only** at the selected indices and
 *    leaves the rest at 1.0, so filtering the water out of the ghost branch
 *    would leave the waters rendering fully opaque over it. The second branch
 *    hides them at opacity 0, the way the Protein template hides its atoms.
 *  - Scale 3.2 draws each bead at ~1.6 Å, comfortably under the 3.9 Å closest
 *    approach of two non-bonded beads, so the chain reads as beads on a string
 *    rather than a fused tube. Color makes them read against the ghost, which
 *    is otherwise the same grey carbon.
 *  - The CG beads take their bonds from the file's CONECT records
 *    (`bondSource: "structure"`), which join consecutive residues. The
 *    all-atom side gets no AddBond: 1UBQ is an X-ray entry with no CONECT for
 *    the protein, and opening a `.pdb` sets every AddBond reachable from that
 *    loader to `"structure"` (`syncAddBondSourceForLoader`), so a bond node
 *    here would only ever show "No bonds found". The ghost is what the user
 *    asked for anyway: the all-atom model, semi-transparent.
 *
 * 1ubq.pdb's crystallographic cell is deliberately left unwired: it belongs to
 * the all-atom model only and its box would dwarf the comparison.
 */
function createCoarseGrainedTemplate(): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  return {
    nodes: [
      {
        id: "loader-aa",
        type: "load_structure",
        position: { x: 170, y: 0 },
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
        position: { x: 170, y: 130 },
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
        position: { x: 170, y: 305 },
        data: {
          params: {
            type: "wrap",
            mode: "none",
          },
          enabled: true,
        },
      },
      {
        id: "aa-filter",
        type: "filter",
        position: { x: 170, y: 480 },
        data: {
          params: {
            type: "filter",
            query: 'resname != "HOH"',
          },
          enabled: true,
        },
      },
      {
        id: "aa-modify",
        type: "modify",
        position: { x: 170, y: 640 },
        data: {
          params: {
            type: "modify",
            scale: 1,
            opacity: 0.3,
          },
          enabled: true,
        },
      },
      {
        id: "water-filter",
        type: "filter",
        position: { x: 425, y: 480 },
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
        position: { x: 425, y: 640 },
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
        id: "loader-cg",
        type: "load_structure",
        position: { x: 850, y: 0 },
        data: {
          params: {
            type: "load_structure",
            fileName: "1ubq_cg.pdb",
            hasTrajectory: false,
            hasCell: false,
          },
          enabled: true,
        },
      },
      {
        id: "cg-modify",
        type: "modify",
        position: { x: 680, y: 305 },
        data: {
          params: {
            type: "modify",
            scale: 3.2,
            opacity: 1,
          },
          enabled: true,
        },
      },
      {
        id: "cg-color",
        type: "color",
        position: { x: 680, y: 480 },
        data: {
          params: {
            type: "color",
            mode: "uniform",
            uniformColor: "#f97316",
          },
          enabled: true,
        },
      },
      {
        id: "cg-addbond",
        type: "add_bond",
        position: { x: 1020, y: 305 },
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
        position: { x: 510, y: 980 },
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
        source: "loader-aa",
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
        target: "aa-filter",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e4",
        source: "aa-filter",
        target: "aa-modify",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e5",
        source: "aa-modify",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e6",
        source: "wrap-1",
        target: "water-filter",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e7",
        source: "water-filter",
        target: "water-modify",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e8",
        source: "water-modify",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e9",
        source: "loader-cg",
        target: "cg-modify",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e10",
        source: "cg-modify",
        target: "cg-color",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e11",
        source: "cg-color",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e12",
        source: "loader-cg",
        target: "cg-addbond",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e13",
        source: "cg-addbond",
        target: "viewport-1",
        sourceHandle: "bond",
        targetHandle: "bond",
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
    id: "esp",
    label: "ESP Isosurface",
    description: "Caffeine overlaid with its electrostatic potential from a cube file",
    create: createEspTemplate,
  },
  {
    id: "coarse_grained",
    label: "Coarse-Grained Overlay",
    description: "Ubiquitin before and after coarse-graining, all-atom ghosted behind the beads",
    create: createCoarseGrainedTemplate,
  },
  {
    id: "streaming",
    label: "Streaming",
    description: "WebSocket streaming with bonds",
    create: createStreamingTemplate,
  },
];
