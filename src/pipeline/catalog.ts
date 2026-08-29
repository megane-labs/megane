/**
 * Node catalog — the single source of truth for pipeline node *documentation*.
 *
 * `src/pipeline/types.ts` holds the structural metadata (ports, param shapes,
 * defaults, categories). This file adds the prose that used to be duplicated by
 * hand in the AI system prompt (`src/ai/prompt.ts`) and the docs
 * (`docs/docs/guide/pipeline/*.md`): the purpose description, per-parameter
 * documentation, and prompt-specific port annotations.
 *
 * Two consumers render from this catalog:
 *   - `renderNodeSchemaSection()` in `src/ai/prompt.ts` (the LLM node schema).
 *   - `scripts/generate-node-reference.mjs` (the docs Node Reference page).
 *
 * The explicit `Record<PipelineNodeType, NodeCatalogEntry>` annotation makes
 * adding a new node type without a catalog entry a compile error.
 *
 * NOTE: this module must stay runtime-dependency-free (it only imports types +
 * pure data from `./types`) so the docs generator can bundle it with esbuild
 * without pulling in Three.js / xyflow.
 */
import type { PipelineNodeType } from "./types";

/** Documentation for a single serialized parameter of a node. */
export interface ParamDoc {
  /** Serialized JSON key, e.g. `"bondSource"`. */
  jsonKey: string;
  /** Whether the key is optional in the serialized signature (`key?: T`). */
  optional?: boolean;
  /** Display type string used in the schema signature, e.g. `string | null`. */
  tsType: string;
  /** Default value display string for the docs table (omit if none). */
  default?: string;
  /** One-line description for the docs parameter table. */
  doc?: string;
}

export interface NodeCatalogEntry {
  /** Purpose prose. May span multiple lines (rendered verbatim in the prompt). */
  description: string;
  /** Structured parameter docs. Drives the inline signature + docs table. */
  params: ParamDoc[];
  /**
   * Optional verbatim fenced parameter block for the prompt, used instead of
   * the derived inline `{ ... }` signature. The string is the block body.
   */
  promptParamsFenced?: string;
  /**
   * Extra prompt sub-bullets rendered under the Parameters line as `  - <note>`.
   * Verbatim; an entry may contain embedded newlines for wrapped bullets.
   */
  promptNotes?: string[];
  /** Exact text after `- Inputs: ` in the prompt (omit when the node has no inputs). */
  promptInputs?: string;
  /** Exact text after `- Outputs: ` in the prompt (omit when the node has no outputs). */
  promptOutputs?: string;
  /** Whether this node is surfaced to the LLM. Only `streaming` is false. */
  inPrompt: boolean;
  /** Python class name in `python.megane`, or null when unavailable (surface_mesh). */
  pythonClass: string | null;
}

/**
 * Node catalog. Authoring order matches the prompt's node order; `streaming`
 * (which is not shown to the LLM) is placed last.
 *
 * The explicit `Record<PipelineNodeType, NodeCatalogEntry>` annotation forces an
 * entry for every node type — adding a node type without one is a compile error.
 */
export const NODE_CATALOG: Record<PipelineNodeType, NodeCatalogEntry> = {
  load_structure: {
    description: "Loads a molecular structure file. This is the primary data source.",
    params: [
      {
        jsonKey: "fileName",
        tsType: "string | null",
        default: "null",
        doc: "Path/name of the structure file.",
      },
      {
        jsonKey: "hasTrajectory",
        tsType: "boolean",
        default: "false",
        doc: "Whether the file carries multiple frames.",
      },
      {
        jsonKey: "hasCell",
        tsType: "boolean",
        default: "false",
        doc: "Whether the file carries a unit cell.",
      },
    ],
    promptOutputs: "`particle` (always), `trajectory` (if hasTrajectory), `cell` (if hasCell)",
    inPrompt: true,
    pythonClass: "LoadStructure",
  },
  load_trajectory: {
    description: "Loads trajectory data from an external file (e.g. XTC).",
    params: [
      {
        jsonKey: "fileName",
        tsType: "string | null",
        default: "null",
        doc: "Path/name of the trajectory file (XTC, DCD, NetCDF, LAMMPS dump).",
      },
      {
        jsonKey: "source",
        tsType: '"file" | "structure"',
        default: '"file"',
        doc:
          '"file" plays a separately loaded trajectory file; "structure" forwards the frames ' +
          "embedded in the structure file itself (multi-frame XYZ/PDB/.traj), set by the load " +
          "path when such a file is opened.",
      },
    ],
    promptInputs: "`particle` (particle data type)",
    promptOutputs: "`trajectory` (trajectory data type)",
    inPrompt: true,
    pythonClass: "LoadTrajectory",
  },
  load_vector: {
    description: "Loads per-atom vector data (forces, velocities).",
    params: [
      {
        jsonKey: "fileName",
        tsType: "string | null",
        default: "null",
        doc: "Path/name of the per-atom vector file.",
      },
    ],
    promptOutputs: "`vector` (vector data type)",
    inPrompt: true,
    pythonClass: "LoadVector",
  },
  load_volumetric: {
    description:
      "Loads volumetric scalar-field data (e.g. a Gaussian/VASP CUBE file with\nelectron density or electrostatic potential).",
    params: [
      {
        jsonKey: "fileName",
        tsType: "string | null",
        default: "null",
        doc: "Path/name of the CUBE (volumetric) file.",
      },
    ],
    promptOutputs: "`volumetric` (volumetric data type)",
    inPrompt: true,
    pythonClass: "LoadVolumetric",
  },
  load_spectrum: {
    description:
      "Loads a JCAMP-DX spectrum (.jdx / .jcamp) -- IR, NMR, MS, or UV/Vis.\nA spectrum has no 3D coordinates, so it feeds the Spectrum Plot node\nrather than the Viewport.",
    params: [
      {
        jsonKey: "fileName",
        tsType: "string | null",
        default: "null",
        doc: "Path/name of the JCAMP-DX file.",
      },
    ],
    promptOutputs: "`spectrum` (spectrum data type)",
    inPrompt: true,
    pythonClass: "LoadSpectrum",
  },
  spectrum_plot: {
    description:
      "Draws a spectrum as a 2D line chart. Terminal node -- a spectrum has no\ngeometry, so it does not reach the 3D renderer.",
    params: [
      {
        jsonKey: "reverseX",
        tsType: "boolean",
        default: "true",
        doc: "Draw the abscissa high-to-low, the convention for IR and NMR.",
      },
      {
        jsonKey: "color",
        tsType: "string",
        default: '"#84cc16"',
        doc: "Hex stroke colour of the trace.",
      },
    ],
    promptInputs: "`spectrum`",
    inPrompt: true,
    pythonClass: "SpectrumPlot",
  },
  add_bond: {
    description: "Detects or infers bonds between atoms.",
    params: [
      {
        jsonKey: "bondSource",
        tsType: '"structure" | "file" | "distance" | "none"',
        default: '"distance"',
        doc: "How bonds are obtained.",
      },
    ],
    promptNotes: [
      '"structure": read bonds from structure file',
      '"distance": compute bonds by van der Waals distance',
      '"file": read bonds from separate file',
      '"none": no bonds',
    ],
    promptInputs: "`particle` (particle data type)",
    promptOutputs: "`bond` (bond data type)",
    inPrompt: true,
    pythonClass: "AddBonds",
  },
  coordination_generator: {
    description:
      "Builds directed relationships between center atoms and their bonded neighbors.\nIt consumes Drawing Boundary copies and can add only the periodic neighbor images\nneeded outside the drawing range to complete each visible center.",
    params: [
      {
        jsonKey: "excludedCenters",
        tsType: "number[]",
        default: "[]",
        doc: "Atomic numbers excluded from auto-detected center atoms.",
      },
      {
        jsonKey: "excludedLigands",
        tsType: "number[]",
        default: "[]",
        doc: "Atomic numbers excluded from auto-detected neighbor atoms.",
      },
      {
        jsonKey: "cutoffTolerance",
        tsType: "number",
        default: "1.15",
        doc: "Multiplier on the sum of covalent radii.",
      },
      {
        jsonKey: "boundaryMode",
        tsType: '"inside" | "complete"',
        default: '"complete"',
        doc: "complete includes outside periodic neighbors needed by visible centers.",
      },
    ],
    promptInputs: "`particle` (normally from Drawing Boundary)",
    promptOutputs: "`coordination` (directed center-neighbor pairs), `bond`",
    inPrompt: true,
    pythonClass: "AddCoordination",
  },
  filter: {
    description:
      'Filters atoms (and optionally bonds) by a selection query. See the\n"Atom & Bond Selection Query Language" section below for the full, authoritative\ngrammar — only the syntax documented there is supported.',
    params: [
      {
        jsonKey: "query",
        tsType: "string",
        default: '""',
        doc: "Atom selection query (see the selection language).",
      },
      {
        jsonKey: "bond_query",
        optional: true,
        tsType: "string",
        default: '""',
        doc: "Optional bond selection query.",
      },
    ],
    promptNotes: [
      '`query`: atom selection (e.g. `element == "C"`, `index < 10`, `resname == "ALA"`, `chain == "A"`, `resid == 42`, `within 5 of (resname == "HEM")`)',
      '`bond_query`: optional bond selection (e.g. `both element != "H"`)',
    ],
    promptInputs: "`in` (accepts particle or bond data type)",
    promptOutputs: "`out` (same type as input)",
    inPrompt: true,
    pythonClass: "Filter",
  },
  modify: {
    description: "Modifies visual properties (scale, opacity).",
    params: [
      { jsonKey: "scale", tsType: "number", default: "1.0", doc: "Atom size multiplier." },
      { jsonKey: "opacity", tsType: "number", default: "1.0", doc: "Transparency, 0–1." },
    ],
    promptNotes: [
      "scale: atom size multiplier (default 1.0)",
      "opacity: transparency 0-1 (default 1.0)",
    ],
    promptInputs: "`in` (accepts particle or bond data type)",
    promptOutputs: "`out` (same type as input)",
    inPrompt: true,
    pythonClass: "Modify",
  },
  symmetry: {
    description:
      "Expands a crystallographic asymmetric unit into the full unit cell by\napplying the space-group symmetry operations the parser captured on the\nstructure (a CIF `_symmetry_equiv_pos_as_xyz` loop). Bonds are replicated\nper image and coinciding images (special positions) are dropped. Structures\nwithout symmetry operations or without a unit cell pass through unchanged.",
    params: [
      {
        jsonKey: "mode",
        tsType: '"expand" | "none"',
        default: '"expand"',
        doc: "Apply the space-group operations, or pass the asymmetric unit through.",
      },
    ],
    promptNotes: [
      '"expand": apply the space-group operations to fill the unit cell (default)',
      '"none": pass the raw asymmetric unit through unchanged',
    ],
    promptInputs: "`particle`, `trajectory`",
    promptOutputs: "`particle` (expanded), `trajectory` (passed through)",
    inPrompt: true,
    pythonClass: "Symmetry",
  },
  wrap: {
    description:
      'Toggles periodic-image coordinate mapping for the particle stream (and its\ntrajectory). "wrap" folds every atom back into the home unit cell;\n"unwrap" makes bonded molecules that straddle a periodic face whole again\n(VESTA/Mercury-style). Requires a unit cell; "none" passes through.',
    params: [
      {
        jsonKey: "mode",
        tsType: '"none" | "wrap" | "unwrap"',
        default: '"none"',
        doc: "Coordinate mapping applied to atoms and trajectory frames.",
      },
    ],
    promptNotes: [
      '"none": pass positions through unchanged (default)',
      '"wrap": fold every atom into the home unit cell (fractional [0,1))',
      '"unwrap": shift atoms by whole lattice vectors so bonded molecules split\n    across a periodic face become contiguous',
    ],
    promptInputs: "`particle`, `trajectory`",
    promptOutputs: "`particle`, `trajectory` (remapped)",
    inPrompt: true,
    pythonClass: "Wrap",
  },
  replicate: {
    description:
      "Builds an OVITO/VESTA-style supercell by copying every atom (and its bonds)\ninto an `nx × ny × nz` grid of cell images and enlarging the simulation cell\nto match. Requires a unit cell on the input.",
    params: [
      {
        jsonKey: "nx",
        tsType: "number",
        default: "1",
        doc: "Repeats along the a lattice vector (integer ≥ 1).",
      },
      {
        jsonKey: "ny",
        tsType: "number",
        default: "1",
        doc: "Repeats along the b lattice vector (integer ≥ 1).",
      },
      {
        jsonKey: "nz",
        tsType: "number",
        default: "1",
        doc: "Repeats along the c lattice vector (integer ≥ 1).",
      },
    ],
    promptNotes: [
      "Each of nx/ny/nz is an integer >= 1 (default 1) — number of repeats along\n    the a/b/c lattice vectors.",
    ],
    promptInputs: "`particle`, `cell`, `trajectory`",
    promptOutputs: "`particle`, `cell`, `trajectory` (replicated)",
    inPrompt: true,
    pythonClass: "Replicate",
  },
  drawing_boundary: {
    description:
      "Generates periodic display atoms inside an inclusive fractional range.\nUnlike Replicate it does not alter the structural atom count or unit cell.",
    params: [
      { jsonKey: "xMin", tsType: "number", default: "0", doc: "Lower a-coordinate." },
      { jsonKey: "xMax", tsType: "number", default: "1", doc: "Upper a-coordinate." },
      { jsonKey: "yMin", tsType: "number", default: "0", doc: "Lower b-coordinate." },
      { jsonKey: "yMax", tsType: "number", default: "1", doc: "Upper b-coordinate." },
      { jsonKey: "zMin", tsType: "number", default: "0", doc: "Lower c-coordinate." },
      { jsonKey: "zMax", tsType: "number", default: "1", doc: "Upper c-coordinate." },
    ],
    promptInputs: "`particle`",
    promptOutputs: "`particle` with Drawing Boundary copies",
    inPrompt: true,
    pythonClass: "DrawingBoundary",
  },
  boundary_completion: {
    description:
      "Adds bond-connected periodic display atoms outside Drawing Boundary without\nchanging crystallographic coordinates. Finite-component mode deliberately leaves\ninfinite periodic networks unexpanded.",
    params: [
      {
        jsonKey: "mode",
        tsType: '"neighbors" | "components"',
        default: '"neighbors"',
        doc: "Complete one neighbor shell or each finite connected component.",
      },
    ],
    promptInputs: "`particle` from Drawing Boundary and periodic `bond` data",
    promptOutputs: "completed `particle` and `bond`",
    inPrompt: true,
    pythonClass: "BoundaryCompletion",
  },
  color: {
    description:
      "Recolors atoms using a palette mode, overriding the default per-element coloring.",
    params: [
      {
        jsonKey: "mode",
        tsType:
          '"uniform" | "byElement" | "byResidue" | "byChain" | "byBFactor" | "byProperty" | "illustrative"',
        default: '"uniform"',
        doc: "Coloring scheme.",
      },
      {
        jsonKey: "uniformColor",
        tsType: "string",
        default: '"#ff8800"',
        doc: "Hex color used when mode is uniform.",
      },
      {
        jsonKey: "range",
        optional: true,
        tsType: "[number, number]",
        doc: "Value range for continuous palettes (auto-computed if omitted).",
      },
    ],
    promptNotes: [
      '"uniform": every atom gets `uniformColor` (hex string, e.g. "#ff8800")',
      '"byElement" / "byResidue" / "byChain": categorical palette by that property',
      '"byBFactor" / "byProperty": continuous palette over `range` (auto-computed if omitted)',
      '"illustrative": Mol*-style — carbon takes a lightened chain color, every other element keeps its CPK color; pair it with the "illustrative" representation for a Goodsell-style figure',
    ],
    promptInputs: "`in` (particle only — NOT bond)",
    promptOutputs: "`out` (particle)",
    inPrompt: true,
    pythonClass: "Color",
  },
  representation: {
    description: "Switches the rendering style for the connected particle stream.",
    params: [
      {
        jsonKey: "mode",
        tsType: '"atoms" | "licorice" | "cartoon" | "both" | "surface" | "line" | "illustrative"',
        default: '"atoms"',
        doc: "Rendering style for the particle stream.",
      },
    ],
    promptNotes: [
      '"atoms": ball-and-stick / van der Waals spheres (default)',
      '"licorice": equal-radius atoms and bonds drawn as one continuous stick/tube (PyMOL licorice / sticks)',
      '"cartoon": protein backbone cartoon (secondary structure)',
      '"both": atoms and cartoon overlaid',
      '"surface": molecular surface',
      '"line": thin wireframe lines (VMD/PyMOL "lines" style)',
      '"illustrative": Mol*-style spacefill spheres at full van der Waals radius, softly shaded toward the rim of each sphere with a dark silhouette outline; bonds are hidden. Best paired with a `color` node in "illustrative" mode',
    ],
    promptInputs: "`in` (particle only — NOT bond)",
    promptOutputs: "`out` (particle)",
    inPrompt: true,
    pythonClass: "Representation",
  },
  label_generator: {
    description: "Generates text labels for atoms.",
    params: [
      {
        jsonKey: "source",
        tsType: '"element" | "resname" | "index"',
        default: '"element"',
        doc: "Which atom property becomes the label text.",
      },
    ],
    promptInputs: "`particle` (particle data type)",
    promptOutputs: "`label` (label data type)",
    inPrompt: true,
    pythonClass: "AddLabels",
  },
  polyhedron_generator: {
    description:
      "Converts directed center-neighbor coordination relationships into convex polyhedron\nmeshes. Periodic atom display and completing neighbors outside the drawing range are\nhandled upstream.",
    params: [
      { jsonKey: "opacity", tsType: "number", default: "0.5", doc: "Face opacity, 0–1." },
      { jsonKey: "showEdges", tsType: "boolean", default: "false", doc: "Draw polyhedron edges." },
      { jsonKey: "edgeColor", tsType: "string", default: '"#dddddd"', doc: "Hex color for edges." },
      { jsonKey: "edgeWidth", tsType: "number", default: "3", doc: "Edge line width." },
    ],
    promptInputs: "`coordination` (coordination data type)",
    promptOutputs: "`mesh` (mesh data type)",
    inPrompt: true,
    pythonClass: "AddPolyhedra",
  },
  surface_mesh: {
    description: "Computes an OVITO-style alpha-shape surface envelope around the atoms.",
    params: [
      {
        jsonKey: "alphaRadius",
        tsType: "number",
        default: "3.0",
        doc: "Probe sphere radius in Å (larger = smoother/coarser).",
      },
      {
        jsonKey: "color",
        tsType: "string",
        default: '"#4488ff"',
        doc: "Hex color of the surface.",
      },
      { jsonKey: "opacity", tsType: "number", default: "0.5", doc: "Surface transparency, 0–1." },
    ],
    promptNotes: [
      "alphaRadius: probe sphere radius in Å — larger is smoother/coarser,\n    smaller is more detailed (default 3.0)",
      'color: hex color string, e.g. "#4488ff"',
      "opacity: 0-1",
    ],
    promptInputs: "`particle` (particle data type)",
    promptOutputs: "`mesh` (mesh data type)",
    inPrompt: true,
    pythonClass: null,
  },
  vector_overlay: {
    description: "Visualizes per-atom vectors (forces, velocities) as arrows.",
    params: [
      { jsonKey: "scale", tsType: "number", default: "1.0", doc: "Arrow length multiplier." },
    ],
    promptInputs: "`vector` (vector data type)",
    promptOutputs: "`vector` (vector data type)",
    inPrompt: true,
    pythonClass: "VectorOverlay",
  },
  isosurface: {
    description: "Renders an isosurface (contour) of volumetric scalar-field data.",
    params: [
      {
        jsonKey: "isoLevel",
        tsType: "number",
        default: "0.05",
        doc: "Contour level for the positive surface.",
      },
      {
        jsonKey: "color",
        tsType: "string",
        default: '"#4488ff"',
        doc: "Hex color for the positive surface.",
      },
      { jsonKey: "opacity", tsType: "number", default: "0.7", doc: "Surface transparency, 0–1." },
      {
        jsonKey: "showNegative",
        tsType: "boolean",
        default: "false",
        doc: "Also draw a surface at −isoLevel.",
      },
      {
        jsonKey: "negativeColor",
        tsType: "string",
        default: '"#ff4444"',
        doc: "Hex color for the negative surface.",
      },
      {
        jsonKey: "colorMode",
        tsType: '"solid" | "volume"',
        default: '"solid"',
        doc: '"solid" uses color/negativeColor; "volume" maps vertex colors from the volume connected to the colorVolumetric input.',
      },
      {
        jsonKey: "colormap",
        tsType: '"rwb" | "bwr" | "rainbow"',
        default: '"rwb"',
        doc: 'Colormap for colorMode "volume" (rwb = red-white-blue, the chemistry ESP convention).',
      },
      {
        jsonKey: "colorRange",
        optional: true,
        tsType: "[number, number]",
        doc: "Explicit [min, max] colormap range; omit for auto (symmetric around 0 for rwb/bwr).",
      },
    ],
    promptNotes: [
      "isoLevel: contour level for the positive surface (default 0.05)",
      "showNegative: also draw a second surface at -isoLevel (e.g. for\n    electrostatic potential maps), colored with `negativeColor`",
      'colorMode "volume": paint the surface by sampling a second volume\n    connected to the `colorVolumetric` input (e.g. ESP mapped onto a\n    charge-density isosurface) through `colormap`; the optional `colorRange`\n    fixes the [min, max] mapping (omit for auto)',
    ],
    promptInputs:
      '`volumetric` (volumetric data type), `colorVolumetric` (optional volumetric used for coloring when colorMode is "volume")',
    promptOutputs: "`mesh` (mesh data type)",
    inPrompt: true,
    pythonClass: "Isosurface",
  },
  viewport: {
    description:
      "The final rendering sink. Every pipeline MUST have exactly one viewport node. All data flows into this node.",
    params: [
      {
        jsonKey: "perspective",
        tsType: "boolean",
        default: "false",
        doc: "Perspective projection instead of orthographic.",
      },
      {
        jsonKey: "cellAxesVisible",
        tsType: "boolean",
        default: "true",
        doc: "Show the unit-cell axes.",
      },
      {
        jsonKey: "pivotMarkerVisible",
        tsType: "boolean",
        default: "true",
        doc: "Show the camera pivot marker.",
      },
    ],
    promptInputs:
      "`particle`, `bond`, `cell`, `trajectory`, `label`, `mesh`, `vector` (each accepts its respective data type)",
    inPrompt: true,
    pythonClass: "Viewport",
  },
  streaming: {
    description:
      "Streams particle/bond/trajectory data in real time over a WebSocket (only available on the standalone `megane serve` host).",
    params: [
      {
        jsonKey: "connected",
        tsType: "boolean",
        default: "false",
        doc: "Whether the stream is currently connected.",
      },
    ],
    promptOutputs: "`particle`, `bond`, `trajectory`, `cell`",
    inPrompt: false,
    pythonClass: "Streaming",
  },
};

/** Node order as presented in the AI prompt (catalog authoring order, minus non-prompt nodes). */
export const PROMPT_NODE_ORDER = (Object.keys(NODE_CATALOG) as PipelineNodeType[]).filter(
  (t) => NODE_CATALOG[t].inPrompt,
);
