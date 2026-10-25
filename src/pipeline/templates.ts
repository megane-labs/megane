/**
 * Pipeline template definitions.
 * Each template provides a predefined pipeline configuration
 * that users can load from the Templates dropdown.
 */

import { edges, exactNode, node, type PipelineGraph } from "./graphFactory";

export interface PipelineTemplate {
  id: string;
  label: string;
  description: string;
  create: () => PipelineGraph;
}

/**
 * Molecule template: simplified caffeine visualization.
 * LoadStructure → Symmetry → Wrap → AddBond → Viewport
 *              → LoadTrajectory → Symmetry → Wrap → Viewport
 * The Symmetry node defaults to mode "expand" (a no-op without space-group
 * operations); the Wrap node defaults to mode "none" (pass-through) so
 * wrap/unwrap is a one-click toggle.
 */
function createMoleculeTemplate(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: "caffeine_water.pdb", hasCell: true }),
      exactNode("traj-1", { type: "load_trajectory", fileName: "caffeine_water_vibration.xtc" }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      node("addbond-1", "add_bond", { bondSource: "structure" }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["loader-1", "traj-1", "particle"],
      ["traj-1", "symmetry-1", "trajectory"],
      ["symmetry-1", "wrap-1", "particle"],
      ["symmetry-1", "wrap-1", "trajectory"],
      ["wrap-1", "addbond-1", "particle"],
      ["wrap-1", "viewport-1", "particle"],
      ["loader-1", "viewport-1", "cell"],
      ["addbond-1", "viewport-1", "bond"],
      ["wrap-1", "viewport-1", "trajectory"],
    ),
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
function createMolecularCrystalTemplate(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: "glycine_csd.cif", hasCell: true }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap", { mode: "wrap" }),
      node("addbond-1", "add_bond"),
      node("drawing-boundary-1", "drawing_boundary"),
      node("boundary-completion-1", "boundary_completion", { mode: "components" }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "addbond-1", "particle"],
      ["wrap-1", "drawing-boundary-1", "particle"],
      ["drawing-boundary-1", "boundary-completion-1", "particle"],
      ["addbond-1", "boundary-completion-1", "bond"],
      ["boundary-completion-1", "viewport-1", "particle"],
      ["boundary-completion-1", "viewport-1", "bond"],
      ["loader-1", "viewport-1", "cell"],
    ),
  };
}

/**
 * Solid template: perovskite SrTiO3 with coordination polyhedra.
 * LoadStructure → Symmetry → Wrap → DrawingBoundary → Coordination → Polyhedra → Viewport
 *                                                        └──────────→ Viewport (bond)
 */
function createSolidTemplate(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", {
        fileName: "perovskite_srtio3_3x3x3.xyz",
        hasCell: true,
      }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      node("drawing-boundary-1", "drawing_boundary"),
      node("coordination-1", "coordination_generator"),
      node("polyhedron-1", "polyhedron_generator"),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "drawing-boundary-1", "particle"],
      ["drawing-boundary-1", "coordination-1", "particle"],
      ["drawing-boundary-1", "viewport-1", "particle"],
      ["loader-1", "viewport-1", "cell"],
      ["coordination-1", "viewport-1", "bond"],
      ["coordination-1", "polyhedron-1", "coordination"],
      ["polyhedron-1", "viewport-1", "mesh"],
    ),
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
function createSurfaceMeshTemplate(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: "au_nanoparticle.xyz" }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      node("surface-1", "surface_mesh", { color: "#38bdf8", opacity: 0.45 }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "surface-1", "particle"],
      ["wrap-1", "viewport-1", "particle"],
      ["surface-1", "viewport-1", "mesh"],
    ),
  };
}

/**
 * Streaming template: WebSocket streaming with bonds and trajectory.
 * Streaming → Viewport (particle, bond, trajectory, cell)
 */
function createStreamingTemplate(): PipelineGraph {
  return {
    nodes: [node("streaming-1", "streaming"), node("viewport-1", "viewport")],
    edges: edges(
      ["streaming-1", "viewport-1", "particle"],
      ["streaming-1", "viewport-1", "bond"],
      ["streaming-1", "viewport-1", "trajectory"],
      ["streaming-1", "viewport-1", "cell"],
    ),
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
function createProteinTemplate(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: "1hsg.pdb" }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      exactNode("protein-filter", {
        type: "filter",
        query: 'resname != "HOH" and resname != "MK1"',
      }),
      node("protein-modify", "modify", { opacity: 0 }),
      node("protein-rep", "representation", { mode: "both" }),
      exactNode("ligand-filter", { type: "filter", query: 'resname == "MK1"' }),
      exactNode("water-filter", {
        type: "filter",
        query: 'resname == "HOH" and within 3.5 of (resname == "MK1")',
      }),
      node("water-modify", "modify", { scale: 0.7 }),
      exactNode("bulk-water-filter", {
        type: "filter",
        query: 'resname == "HOH" and not within 3.5 of (resname == "MK1")',
      }),
      node("bulk-water-modify", "modify", { opacity: 0 }),
      node("addbond-1", "add_bond", { bondSource: "structure" }),
      node("bond-filter", "filter", { bond_query: "not both atom_index >= 1514" }),
      node("bond-modify", "modify", { opacity: 0 }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "protein-filter", "particle", "in"],
      ["protein-filter", "protein-modify", "out", "in"],
      ["protein-modify", "protein-rep", "out", "in"],
      ["protein-rep", "viewport-1", "out", "particle"],
      ["wrap-1", "ligand-filter", "particle", "in"],
      ["ligand-filter", "viewport-1", "out", "particle"],
      ["wrap-1", "water-filter", "particle", "in"],
      ["water-filter", "water-modify", "out", "in"],
      ["water-modify", "viewport-1", "out", "particle"],
      ["wrap-1", "bulk-water-filter", "particle", "in"],
      ["bulk-water-filter", "bulk-water-modify", "out", "in"],
      ["bulk-water-modify", "viewport-1", "out", "particle"],
      ["wrap-1", "addbond-1", "particle"],
      ["addbond-1", "bond-filter", "bond", "in"],
      ["bond-filter", "bond-modify", "out", "in"],
      ["bond-modify", "viewport-1", "out", "bond"],
    ),
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
function createEspTemplate(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: "caffeine_b3lyp.sdf" }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      node("addbond-1", "add_bond", { bondSource: "structure" }),
      node("volumetric-1", "load_volumetric", { fileName: "caffeine_b3lyp_density.cube" }),
      node("volumetric-esp", "load_volumetric", { fileName: "caffeine_b3lyp_esp.cube" }),
      node("isosurface-1", "isosurface", {
        isoLevel: 0.002,
        color: "#e5e7eb",
        opacity: 0.8,
        negativeColor: "#ef4444",
        colorMode: "volume",
        colorRange: [-0.04, 0.04],
      }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "addbond-1", "particle"],
      ["wrap-1", "viewport-1", "particle"],
      ["addbond-1", "viewport-1", "bond"],
      ["volumetric-1", "isosurface-1", "volumetric"],
      ["volumetric-esp", "isosurface-1", "volumetric", "colorVolumetric"],
      ["isosurface-1", "viewport-1", "mesh"],
    ),
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
 *    all-atom side gets no AddBond: the ghost is what the user asked for, the
 *    all-atom model, semi-transparent.
 *
 * 1ubq.pdb's crystallographic cell is deliberately left unwired: it belongs to
 * the all-atom model only and its box would dwarf the comparison.
 */
function createCoarseGrainedTemplate(): PipelineGraph {
  return {
    nodes: [
      node("loader-aa", "load_structure", { fileName: "1ubq.pdb", hasCell: true }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      exactNode("aa-filter", { type: "filter", query: 'resname != "HOH"' }),
      node("aa-modify", "modify", { opacity: 0.3 }),
      exactNode("water-filter", { type: "filter", query: 'resname == "HOH"' }),
      node("water-modify", "modify", { opacity: 0 }),
      node("loader-cg", "load_structure", { fileName: "1ubq_cg.pdb" }),
      node("cg-modify", "modify", { scale: 3.2 }),
      node("cg-color", "color", { uniformColor: "#f97316" }),
      node("cg-addbond", "add_bond", { bondSource: "structure" }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-aa", "symmetry-1", "particle"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "aa-filter", "particle", "in"],
      ["aa-filter", "aa-modify", "out", "in"],
      ["aa-modify", "viewport-1", "out", "particle"],
      ["wrap-1", "water-filter", "particle", "in"],
      ["water-filter", "water-modify", "out", "in"],
      ["water-modify", "viewport-1", "out", "particle"],
      ["loader-cg", "cg-modify", "particle", "in"],
      ["cg-modify", "cg-color", "out", "in"],
      ["cg-color", "viewport-1", "out", "particle"],
      ["loader-cg", "cg-addbond", "particle"],
      ["cg-addbond", "viewport-1", "bond"],
    ),
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
