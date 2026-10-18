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
 * Surface mesh template: a faceted gold nanoparticle wrapped in an OVITO-style
 * alpha-shape surface mesh.
 * LoadStructure → Symmetry → Wrap → SurfaceMesh → Viewport (mesh)
 *                                → Viewport (particle)
 *
 * `au_nanoparticle.xyz` is a 1385-atom Wulff-shaped fcc Au cluster (see
 * `generate_au_nanoparticle.py`): eight hexagonal {111} and six square {100}
 * facets. An alpha-shape is a free-surface construction, so an isolated
 * particle is what it is for — the flat facets come back as flat polygons. A
 * 3.0 Å probe sits just above the 2.88 Å Au–Au nearest-neighbour distance:
 * small enough to follow the facet edges, large enough not to fall between
 * surface atoms.
 *
 * The particle carries no unit cell, so nothing is wired to the Viewport's
 * cell input. The Symmetry node defaults to mode "expand" (a no-op without
 * space-group operations); the Wrap node defaults to mode "none"
 * (pass-through).
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
            fileName: "au_nanoparticle.xyz",
            hasTrajectory: false,
            hasCell: false,
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
            color: "#38bdf8",
            opacity: 0.45,
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
 * Protein template: HIV-1 protease with the inhibitor indinavir bound (1HSG).
 *
 *   LoadStructure → Symmetry → Wrap ─┬─ Filter(polymer)     → Modify(opacity 0) → Representation(both) ─┐
 *                                    ├─ Filter(MK1)  ─────────────────────────────────────────────────────┤
 *                                    ├─ Filter(contact HOH) → Modify(scale 0.7) ──────────────────────────┤
 *                                    ├─ Filter(bulk HOH)    → Modify(opacity 0) ──────────────────────────┤
 *                                    └─ AddBond → Filter(bonds outside MK1) → Modify(opacity 0) ── bond ──┴─→ Viewport
 *
 * The protease is a C2-symmetric homodimer of two mostly-β monomers, drawn as
 * a cartoon colored by the file's HELIX/SHEET records. Polymer atoms are
 * hidden (opacity 0) so only the ribbon shows; indinavir (residue MK1) keeps
 * its element colors and is drawn ball-and-stick in the binding cleft under
 * the two flaps. `within 3.5 of (resname == "MK1")` splits the crystal waters
 * into the seven in contact with the drug — among them the structural "flap
 * water" (HOH B308) that bridges the inhibitor to the Ile50 amides of both
 * flaps — and the bulk, which is hidden. The four particle branches are disjoint, so no atom gets
 * two competing treatments. Representation "both" makes the global viewport
 * mode draw atoms + cartoon, which is what each branch needs.
 *
 * Bonds: 1HSG's CONECT records cover only MK1 and the loader infers the
 * protein's from distances. A bond does not inherit its atoms' opacity, so the
 * polymer's bonds are hidden on the bond stream itself — the same
 * Filter(bond_query) → Modify(opacity 0) pattern as hiding any species. The
 * bond DSL selects by atom index, not residue: 1HSG lists its 1514 protein
 * atoms first, so `atom_index >= 1514` is the HETATM block (MK1, then the
 * waters, which carry no bonds).
 *
 * The fixture is 1HSG without its CRYST1 cell (see `generate_1hsg.py`): the
 * viewer frames the camera on a structure's cell, and 1HSG's 59.6 × 87.1 ×
 * 46.7 Å box holds the dimer in one corner. With no cell, nothing is wired to
 * the Viewport's cell input. The Symmetry node defaults to mode "expand" (a
 * no-op: PDB input carries no symmetry operations); the Wrap node defaults to
 * mode "none" (pass-through).
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
        position: { x: 595, y: 0 },
        data: {
          params: {
            type: "load_structure",
            fileName: "1hsg.pdb",
            hasTrajectory: false,
            hasCell: false,
          },
          enabled: true,
        },
      },
      {
        id: "symmetry-1",
        type: "symmetry",
        position: { x: 595, y: 130 },
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
        position: { x: 595, y: 305 },
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
        position: { x: 0, y: 505 },
        data: {
          params: {
            type: "filter",
            query: 'resname != "HOH" and resname != "MK1"',
          },
          enabled: true,
        },
      },
      {
        id: "protein-modify",
        type: "modify",
        position: { x: 0, y: 665 },
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
        position: { x: 0, y: 825 },
        data: {
          params: {
            type: "representation",
            mode: "both",
          },
          enabled: true,
        },
      },
      {
        id: "ligand-filter",
        type: "filter",
        position: { x: 340, y: 505 },
        data: {
          params: {
            type: "filter",
            query: 'resname == "MK1"',
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
            query: 'resname == "HOH" and within 3.5 of (resname == "MK1")',
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
            scale: 0.7,
            opacity: 1,
          },
          enabled: true,
        },
      },
      {
        id: "bulk-water-filter",
        type: "filter",
        position: { x: 1020, y: 505 },
        data: {
          params: {
            type: "filter",
            query: 'resname == "HOH" and not within 3.5 of (resname == "MK1")',
          },
          enabled: true,
        },
      },
      {
        id: "bulk-water-modify",
        type: "modify",
        position: { x: 1020, y: 665 },
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
        id: "addbond-1",
        type: "add_bond",
        position: { x: 1360, y: 505 },
        data: {
          params: {
            type: "add_bond",
            bondSource: "structure",
          },
          enabled: true,
        },
      },
      {
        id: "bond-filter",
        type: "filter",
        position: { x: 1360, y: 665 },
        data: {
          params: {
            type: "filter",
            query: "",
            bond_query: "not both atom_index >= 1514",
          },
          enabled: true,
        },
      },
      {
        id: "bond-modify",
        type: "modify",
        position: { x: 1360, y: 825 },
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
        id: "viewport-1",
        type: "viewport",
        position: { x: 595, y: 1005 },
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
        target: "ligand-filter",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e8",
        source: "ligand-filter",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e9",
        source: "wrap-1",
        target: "water-filter",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e10",
        source: "water-filter",
        target: "water-modify",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e11",
        source: "water-modify",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e12",
        source: "wrap-1",
        target: "bulk-water-filter",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        id: "e13",
        source: "bulk-water-filter",
        target: "bulk-water-modify",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e14",
        source: "bulk-water-modify",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
      {
        id: "e15",
        source: "wrap-1",
        target: "addbond-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
      {
        id: "e16",
        source: "addbond-1",
        target: "bond-filter",
        sourceHandle: "bond",
        targetHandle: "in",
      },
      {
        id: "e17",
        source: "bond-filter",
        target: "bond-modify",
        sourceHandle: "out",
        targetHandle: "in",
      },
      {
        id: "e18",
        source: "bond-modify",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "bond",
      },
    ],
  };
}

/**
 * ESP template: caffeine's electron-density surface painted by its
 * electrostatic potential — the standard "ESP map", from a real DFT
 * calculation.
 *
 *   LoadStructure(caffeine_b3lyp.sdf) → Symmetry → Wrap ─┬→ AddBond → Viewport (bond)
 *                                                        └────────────→ Viewport (particle)
 *   LoadVolumetric(caffeine_b3lyp_density.cube) → Isosurface ────→ Viewport (mesh)
 *   LoadVolumetric(caffeine_b3lyp_esp.cube) ──────↗ (colorVolumetric)
 *
 * The structure and both cubes come from `generate_caffeine_dft_esp.py`: one
 * B3LYP/6-31G* calculation on caffeine (PubChem CID 2519), written in a frame
 * whose ring plane faces the default camera — the PubChem conformer lies in
 * xy and would be seen edge-on — so the three files line up without any
 * alignment step. The
 * Isosurface node contours the density at 0.002 e/Bohr³ — the conventional
 * molecular-surface level — and, in colorMode "volume", samples the second
 * grid at every vertex: red where the potential is negative (the two carbonyl
 * oxygens, the imidazole N9 lone pair), blue where it is positive (the methyl
 * and C8–H hydrogens). The potential on that surface spans about ±0.06
 * Hartree/e; the fixed ±0.04 colorRange saturates only the extremes and keeps
 * the map comparable between molecules instead of stretching to whichever
 * extreme this one reaches.
 *
 * At opacity 0.8 the colors still read cleanly while the ball-and-stick
 * molecule shows through.
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
            fileName: "caffeine_b3lyp.sdf",
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
        position: { x: 680, y: 0 },
        data: {
          params: {
            type: "load_volumetric",
            fileName: "caffeine_b3lyp_density.cube",
          },
          enabled: true,
        },
      },
      {
        id: "volumetric-esp",
        type: "load_volumetric",
        position: { x: 1020, y: 0 },
        data: {
          params: {
            type: "load_volumetric",
            fileName: "caffeine_b3lyp_esp.cube",
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
            isoLevel: 0.002,
            color: "#e5e7eb",
            opacity: 0.8,
            showNegative: false,
            negativeColor: "#ef4444",
            colorMode: "volume",
            colormap: "rwb",
            colorRange: [-0.04, 0.04],
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
        source: "volumetric-esp",
        target: "isosurface-1",
        sourceHandle: "volumetric",
        targetHandle: "colorVolumetric",
      },
      {
        id: "e8",
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
    description: "Faceted gold nanoparticle in an OVITO-style alpha-shape surface envelope",
    create: createSurfaceMeshTemplate,
  },
  {
    id: "protein",
    label: "Protein",
    description: "HIV-1 protease dimer with the drug indinavir bound in its active site",
    create: createProteinTemplate,
  },
  {
    id: "esp",
    label: "ESP Map",
    description: "Caffeine's DFT electron-density surface colored by its electrostatic potential",
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
