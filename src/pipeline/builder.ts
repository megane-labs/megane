/**
 * JavaScript/TypeScript pipeline builder for megane molecular viewer.
 *
 * Mirrors the Python Pipeline API: add nodes, wire ports explicitly, then
 * serialize to the SerializedPipeline v3 JSON format understood by the
 * TypeScript pipeline engine.
 *
 * Example:
 *
 *   import { Pipeline, LoadStructure, Filter, Modify, AddBonds, Viewport } from '@/pipeline/builder'
 *
 *   const pipe = new Pipeline()
 *   const s = pipe.addNode(new LoadStructure('protein.pdb'))
 *   const f = pipe.addNode(new Filter({ query: "element == 'C'" }))
 *   const m = pipe.addNode(new Modify({ scale: 1.3 }))
 *   const b = pipe.addNode(new AddBonds())
 *   const v = pipe.addNode(new Viewport())
 *
 *   pipe.addEdge(s.out.particle, f.inp.particle)
 *   pipe.addEdge(f.out.particle, m.inp.particle)
 *   pipe.addEdge(s.out.particle, b.inp.particle)
 *   pipe.addEdge(m.out.particle, v.inp.particle)
 *   pipe.addEdge(b.out.bond,     v.inp.bond)
 *
 *   const json = pipe.toJSON()
 */

import type {
  SerializedPipeline,
  EditOp,
  PipelineNodeParams,
  PipelineNodeType,
  IsosurfaceColorMode,
  VolumeColormap,
} from "./types";
import { defaultParams } from "./types";

/** The params shape `defaultParams(type)` returns for one node type. */
type ParamsOf<T extends PipelineNodeType> = Extract<PipelineNodeParams, { type: T }>;

/**
 * Defaults for a node type, read from `defaultParams` so the builder never
 * keeps a second hand-written copy that could drift from the editor's.
 */
function defaultsOf<T extends PipelineNodeType>(type: T): ParamsOf<T> {
  return defaultParams(type) as ParamsOf<T>;
}

// ─── Port Objects ────────────────────────────────────────────────────

/** A single typed I/O port on a pipeline node. */
export class NodePort {
  constructor(
    public readonly node: PipelineNode,
    public readonly handle: string,
  ) {}
}

/**
 * Attribute-access namespace that returns NodePort instances.
 *
 * Example: node.out.particle → NodePort(node, 'particle')
 * Accessing an undefined port throws an Error with available port names.
 */
export interface PortAccessor {
  [portName: string]: NodePort;
}

const hasOwn = (obj: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

function makePortNamespace(node: PipelineNode, portMap: Record<string, string>): PortAccessor {
  return new Proxy({} as PortAccessor, {
    get(_, prop: string) {
      if (typeof prop !== "string" || prop.startsWith("__") || prop === "then") return undefined;
      if (hasOwn(portMap, prop)) return new NodePort(node, portMap[prop]);
      const available = Object.keys(portMap).sort().join(", ") || "(none)";
      throw new Error(`No port "${prop}" on "${node.nodeType}" node. Available: ${available}`);
    },
    has(_, prop: string) {
      return typeof prop === "string" && hasOwn(portMap, prop);
    },
    ownKeys() {
      return Object.keys(portMap);
    },
    getOwnPropertyDescriptor(_, prop: string) {
      if (typeof prop === "string" && hasOwn(portMap, prop)) {
        return { configurable: true, enumerable: true };
      }
      return undefined;
    },
  });
}

// ─── Node Base Class ─────────────────────────────────────────────────

export abstract class PipelineNode {
  abstract readonly nodeType: string;
  protected abstract readonly _outPorts: Record<string, string>;
  protected abstract readonly _inpPorts: Record<string, string>;

  _id: string | null = null;

  /** Output port namespace. Access ports via node.out.portName */
  get out(): PortAccessor {
    return makePortNamespace(this, this._outPorts);
  }

  /** Input port namespace. Access ports via node.inp.portName */
  get inp(): PortAccessor {
    return makePortNamespace(this, this._inpPorts);
  }

  /** Serialize node parameters to the SerializedPipeline v3 node dict. */
  abstract _toSerializedParams(): Record<string, unknown>;
}

// ─── Node Classes ────────────────────────────────────────────────────

/**
 * Load a molecular structure file.
 *
 * Supported formats: PDB, GRO, XYZ, MOL, LAMMPS data.
 *
 * Ports:
 *   out.particle — atom data
 *   out.traj     — trajectory channel
 *   out.cell     — simulation cell
 */
export class LoadStructure extends PipelineNode {
  readonly nodeType = "load_structure";
  protected readonly _outPorts = { particle: "particle", traj: "trajectory", cell: "cell" };
  protected readonly _inpPorts: Record<string, string> = {};

  /**
   * Structure edits replayed on the file as loaded (megane Builder's
   * history): add / delete / move atoms, change elements, add / delete bonds,
   * place a fragment, set the cell. Atom refs are indices into the file's
   * atoms (numbers) or ids of atoms an earlier op created (strings). The node
   * then emits the edited structure.
   */
  public edits: EditOp[];

  constructor(
    public path: string,
    { edits = [] }: { edits?: EditOp[] } = {},
  ) {
    super();
    this.edits = edits;
  }

  _toSerializedParams() {
    return {
      type: this.nodeType,
      fileName: this.path,
      fileUrl: this.path,
      hasTrajectory: false,
      hasCell: false,
      ...(this.edits.length > 0 ? { edits: this.edits } : {}),
    };
  }
}

/** Options accepted by {@link LoadTrajectory}. */
export interface LoadTrajectoryOptions {
  /**
   * Trajectory file path / URL, in any format the Load Trajectory node opens
   * (`TRAJECTORY_EXTS`: XTC, DCD, AMBER NetCDF `.nc`, LAMMPS dump
   * `.lammpstrj` / `.dump` / `.trj`) or a multi-frame structure file.
   */
  path?: string | null;
  /** XTC trajectory (kept for the original `{ xtc }` API). */
  xtc?: string | null;
  /** CHARMM/NAMD/X-PLOR DCD trajectory. */
  dcd?: string | null;
  /** AMBER NetCDF trajectory. */
  nc?: string | null;
  /** ASE `.traj` file (kept for the original `{ traj }` API). */
  traj?: string | null;
  /** Multi-frame XYZ file. */
  xyz?: string | null;
  /** LAMMPS dump trajectory (`.lammpstrj` / `.dump` / `.trj`). */
  lammpstrj?: string | null;
  /**
   * `"file"` (the default) plays the file above; `"structure"` forwards the
   * frames embedded in the upstream structure file instead.
   */
  source?: "file" | "structure";
}

/**
 * Load an external trajectory file.
 *
 * Accepts any trajectory format the app opens — pass the path directly
 * (`new LoadTrajectory("run.dcd")`) or as `{ path }`. The per-format keys
 * mirror the Python builder (`{ xtc }`, `{ dcd }`, `{ nc }`, `{ traj }`,
 * `{ xyz }`, `{ lammpstrj }`); when several are given the first non-null one
 * in that order wins, after `path`.
 *
 * Requires connection from a LoadStructure node.
 *
 * Ports:
 *   inp.particle — atom topology source
 *   out.traj     — trajectory frames
 */
export class LoadTrajectory extends PipelineNode {
  readonly nodeType = "load_trajectory";
  protected readonly _outPorts = { traj: "trajectory" };
  protected readonly _inpPorts = { particle: "particle" };

  public path: string | null;
  public xtc: string | null;
  public dcd: string | null;
  public nc: string | null;
  public traj: string | null;
  public xyz: string | null;
  public lammpstrj: string | null;
  public source: "file" | "structure";

  constructor(pathOrOptions: string | LoadTrajectoryOptions = {}) {
    super();
    const opts: LoadTrajectoryOptions =
      typeof pathOrOptions === "string" ? { path: pathOrOptions } : pathOrOptions;
    this.path = opts.path ?? null;
    this.xtc = opts.xtc ?? null;
    this.dcd = opts.dcd ?? null;
    this.nc = opts.nc ?? null;
    this.traj = opts.traj ?? null;
    this.xyz = opts.xyz ?? null;
    this.lammpstrj = opts.lammpstrj ?? null;
    this.source = opts.source ?? (defaultsOf("load_trajectory").source as "file" | "structure");
  }

  /** The file this node serializes: `path`, else the first per-format key set. */
  get fileName(): string | null {
    return this.path ?? this.xtc ?? this.dcd ?? this.nc ?? this.traj ?? this.xyz ?? this.lammpstrj;
  }

  _toSerializedParams() {
    const file = this.fileName;
    return {
      type: this.nodeType,
      fileName: file,
      fileUrl: file,
      source: this.source,
    };
  }
}

/**
 * Streaming source node for WebSocket-based real-time data delivery.
 *
 * Ports:
 *   out.particle — atom data
 *   out.bond     — bond data
 *   out.traj     — trajectory channel
 *   out.cell     — simulation cell
 */
export class Streaming extends PipelineNode {
  readonly nodeType = "streaming";
  protected readonly _outPorts = {
    particle: "particle",
    bond: "bond",
    traj: "trajectory",
    cell: "cell",
  };
  protected readonly _inpPorts: Record<string, string> = {};

  _toSerializedParams() {
    return { type: this.nodeType, connected: false };
  }
}

/**
 * Load per-atom vector data from a file.
 *
 * Ports:
 *   out.vector — vector field
 */
export class LoadVector extends PipelineNode {
  readonly nodeType = "load_vector";
  protected readonly _outPorts = { vector: "vector" };
  protected readonly _inpPorts: Record<string, string> = {};

  constructor(public path: string) {
    super();
  }

  _toSerializedParams() {
    return { type: this.nodeType, fileName: this.path, fileUrl: this.path };
  }
}

/**
 * Filter atoms by a selection query.
 *
 * Query syntax examples:
 *   element == 'C'
 *   element == 'O' and x > 5.0
 *   resname == 'ALA'
 *   index >= 100 and index < 200
 *
 * Ports:
 *   inp.particle — atom data in
 *   out.particle — filtered atom data
 */
export class Filter extends PipelineNode {
  readonly nodeType = "filter";
  protected readonly _outPorts = { particle: "out" };
  protected readonly _inpPorts = { particle: "in" };

  public query: string;
  public bondQuery: string;

  constructor({ query = "all", bondQuery = "" }: { query?: string; bondQuery?: string } = {}) {
    super();
    this.query = query;
    this.bondQuery = bondQuery;
  }

  _toSerializedParams() {
    return { type: this.nodeType, query: this.query, bond_query: this.bondQuery };
  }
}

/**
 * Override per-atom visual properties (scale, opacity).
 *
 * Color and representation now live on dedicated `Color` and `Representation`
 * nodes so each modifier owns a single visual property (Ovito-style modifier
 * stack).
 *
 * Ports:
 *   inp.particle — atom data in
 *   out.particle — modified atom data
 */
export class Modify extends PipelineNode {
  readonly nodeType = "modify";
  protected readonly _outPorts = { particle: "out" };
  protected readonly _inpPorts = { particle: "in" };

  public scale: number;
  public opacity: number;

  constructor({ scale = 1.0, opacity = 1.0 }: { scale?: number; opacity?: number } = {}) {
    super();
    this.scale = scale;
    this.opacity = opacity;
  }

  _toSerializedParams() {
    return { type: this.nodeType, scale: this.scale, opacity: this.opacity };
  }
}

/**
 * Generate periodic display copies inside an inclusive fractional range.
 * This changes drawing data only; structural atom indices and the cell remain
 * unchanged.
 */
export class DrawingBoundary extends PipelineNode {
  readonly nodeType = "drawing_boundary";
  protected readonly _outPorts = { particle: "particle" };
  protected readonly _inpPorts = { particle: "particle" };

  constructor(
    public bounds: {
      xMin?: number;
      xMax?: number;
      yMin?: number;
      yMax?: number;
      zMin?: number;
      zMax?: number;
    } = {},
  ) {
    super();
  }

  _toSerializedParams() {
    return {
      type: this.nodeType,
      xMin: this.bounds.xMin ?? 0,
      xMax: this.bounds.xMax ?? 1,
      yMin: this.bounds.yMin ?? 0,
      yMax: this.bounds.yMax ?? 1,
      zMin: this.bounds.zMin ?? 0,
      zMax: this.bounds.zMax ?? 1,
    };
  }
}

/**
 * Add bond-connected periodic display copies to a Drawing Boundary. Component
 * mode completes finite molecules but refuses to expand periodic networks.
 */
export class BoundaryCompletion extends PipelineNode {
  readonly nodeType = "boundary_completion";
  protected readonly _outPorts = { particle: "particle", bond: "bond" };
  protected readonly _inpPorts = { particle: "particle", bond: "bond" };

  public mode: "neighbors" | "components";

  constructor({ mode = "neighbors" }: { mode?: "neighbors" | "components" } = {}) {
    super();
    this.mode = mode;
  }

  _toSerializedParams() {
    return { type: this.nodeType, mode: this.mode };
  }
}

/**
 * Expand a crystallographic asymmetric unit into the full unit cell by
 * applying the space-group operations the parser captured on the structure
 * (a CIF `_symmetry_equiv_pos_as_xyz` loop). "expand" (the default) fills the
 * cell; "none" passes the raw asymmetric unit through. Structures without
 * symmetry operations or without a unit cell pass through unchanged.
 *
 * Ports:
 *   inp.particle — atom data in
 *   inp.traj     — trajectory in
 *   out.particle — expanded atom data
 *   out.traj     — trajectory (passed through)
 */
export type SymmetryMode = "expand" | "none";

export class Symmetry extends PipelineNode {
  readonly nodeType = "symmetry";
  protected readonly _outPorts = { particle: "particle", traj: "trajectory" };
  protected readonly _inpPorts = { particle: "particle", traj: "trajectory" };

  public mode: SymmetryMode;

  constructor({ mode = "expand" }: { mode?: SymmetryMode } = {}) {
    super();
    this.mode = mode;
  }

  _toSerializedParams() {
    return { type: this.nodeType, mode: this.mode };
  }
}

/**
 * Toggle periodic-image coordinate mapping: fold atoms into the home unit
 * cell ("wrap") or make molecules split across a periodic face whole again
 * ("unwrap"). "none" (the default) passes coordinates through untouched.
 *
 * Ports:
 *   inp.particle — atom data in
 *   inp.traj     — trajectory in
 *   out.particle — remapped atom data
 *   out.traj     — remapped trajectory
 */
export type WrapMode = "none" | "wrap" | "unwrap";

export class Wrap extends PipelineNode {
  readonly nodeType = "wrap";
  protected readonly _outPorts = { particle: "particle", traj: "trajectory" };
  protected readonly _inpPorts = { particle: "particle", traj: "trajectory" };

  public mode: WrapMode;

  constructor({ mode = "none" }: { mode?: WrapMode } = {}) {
    super();
    this.mode = mode;
  }

  _toSerializedParams() {
    return { type: this.nodeType, mode: this.mode };
  }
}

/**
 * OVITO/VESTA-style supercell builder: copies every atom (and its bonds) into
 * an `nx × ny × nz` grid of cell images and enlarges the simulation cell.
 * Requires a unit cell on the input; without one the input passes through.
 *
 * Ports:
 *   inp.particle — atom data in
 *   inp.cell     — simulation cell in
 *   inp.traj     — trajectory in
 *   out.particle — replicated atom data
 *   out.cell     — enlarged simulation cell
 *   out.traj     — replicated trajectory
 */
export class Replicate extends PipelineNode {
  readonly nodeType = "replicate";
  protected readonly _outPorts = { particle: "particle", cell: "cell", traj: "trajectory" };
  protected readonly _inpPorts = { particle: "particle", cell: "cell", traj: "trajectory" };

  public nx: number;
  public ny: number;
  public nz: number;

  constructor({ nx, ny, nz }: { nx?: number; ny?: number; nz?: number } = {}) {
    super();
    const d = defaultsOf("replicate");
    this.nx = nx ?? d.nx;
    this.ny = ny ?? d.ny;
    this.nz = nz ?? d.nz;
  }

  _toSerializedParams() {
    return { type: this.nodeType, nx: this.nx, ny: this.ny, nz: this.nz };
  }
}

/**
 * Per-stream coloring (Ovito-style). The Viewport reads color overrides
 * directly off the particle stream, so multiple Color nodes can stack.
 *
 * Ports:
 *   inp.particle — atom data in
 *   out.particle — recolored atom data
 */
export type ColorMode =
  | "uniform"
  | "byElement"
  | "byResidue"
  | "byChain"
  | "byBFactor"
  | "byProperty"
  | "illustrative";

export class Color extends PipelineNode {
  readonly nodeType = "color";
  protected readonly _outPorts = { particle: "out" };
  protected readonly _inpPorts = { particle: "in" };

  public mode: ColorMode;
  public uniformColor: string;
  public range?: [number, number];

  constructor({
    mode = "uniform",
    uniformColor = "#ff8800",
    range,
  }: { mode?: ColorMode; uniformColor?: string; range?: [number, number] } = {}) {
    super();
    this.mode = mode;
    this.uniformColor = uniformColor;
    this.range = range;
  }

  _toSerializedParams() {
    const base: Record<string, unknown> = {
      type: this.nodeType,
      mode: this.mode,
      uniformColor: this.uniformColor,
    };
    if (this.range !== undefined) base.range = this.range;
    return base;
  }
}

/**
 * Tag the particle stream with the visual representation the Viewport should
 * display. Stacks Ovito-style: the Viewport reads the override from the first
 * particle stream that carries one. When no chain has an override, the
 * Viewport falls back to `"atoms"`.
 *
 * Ports:
 *   inp.particle — atom data in
 *   out.particle — atom data tagged with the representation override
 */
export type RepresentationMode =
  | "atoms"
  | "licorice"
  | "cartoon"
  | "both"
  | "surface"
  | "line"
  | "illustrative";

export class Representation extends PipelineNode {
  readonly nodeType = "representation";
  protected readonly _outPorts = { particle: "out" };
  protected readonly _inpPorts = { particle: "in" };

  public mode: RepresentationMode;

  constructor({ mode = "atoms" }: { mode?: RepresentationMode } = {}) {
    super();
    this.mode = mode;
  }

  _toSerializedParams() {
    return { type: this.nodeType, mode: this.mode };
  }
}

/**
 * Compute and display bonds.
 *
 * Ports:
 *   inp.particle — atom data
 *   out.bond     — computed bonds
 */
export class AddBonds extends PipelineNode {
  readonly nodeType = "add_bond";
  protected readonly _outPorts = { bond: "bond" };
  protected readonly _inpPorts = { particle: "particle" };

  public source: "distance" | "structure" | "file";

  constructor({ source = "distance" }: { source?: "distance" | "structure" | "file" } = {}) {
    super();
    this.source = source;
  }

  _toSerializedParams() {
    return { type: this.nodeType, bondSource: this.source };
  }
}

/**
 * Resolve directed center-neighbor coordination relationships. With
 * `boundaryMode: "complete"`, periodic neighbor images just outside Drawing
 * Boundary are included when needed to complete a visible center.
 */
export class AddCoordination extends PipelineNode {
  readonly nodeType = "coordination_generator";
  protected readonly _outPorts = { coordination: "coordination", bond: "bond" };
  protected readonly _inpPorts = { particle: "particle" };

  constructor(
    public options: {
      excludedCenters?: number[];
      excludedLigands?: number[];
      cutoffTolerance?: number;
      boundaryMode?: "inside" | "complete";
    } = {},
  ) {
    super();
  }

  _toSerializedParams() {
    return {
      type: this.nodeType,
      excludedCenters: this.options.excludedCenters ?? [],
      excludedLigands: this.options.excludedLigands ?? [],
      cutoffTolerance: this.options.cutoffTolerance ?? 1.15,
      boundaryMode: this.options.boundaryMode ?? "complete",
    };
  }
}

/**
 * Generate text labels at atom positions.
 *
 * Ports:
 *   inp.particle — atom data
 *   out.label    — label data
 */
export class AddLabels extends PipelineNode {
  readonly nodeType = "label_generator";
  protected readonly _outPorts = { label: "label" };
  protected readonly _inpPorts = { particle: "particle" };

  public source: "element" | "resname" | "index";

  constructor({ source = "element" }: { source?: "element" | "resname" | "index" } = {}) {
    super();
    this.source = source;
  }

  _toSerializedParams() {
    return { type: this.nodeType, source: this.source };
  }
}

/**
 * Generate coordination polyhedra mesh.
 *
 * Ports:
 *   inp.coordination — directed center-neighbor coordination data
 *   out.mesh     — polyhedra mesh
 */
export class AddPolyhedra extends PipelineNode {
  readonly nodeType = "polyhedron_generator";
  protected readonly _outPorts = { mesh: "mesh" };
  protected readonly _inpPorts = { coordination: "coordination" };

  public opacity: number;
  public showEdges: boolean;
  public edgeColor: string;
  public edgeWidth: number;

  constructor({
    opacity = 0.5,
    showEdges = false,
    edgeColor = "#dddddd",
    edgeWidth = 3.0,
  }: {
    opacity?: number;
    showEdges?: boolean;
    edgeColor?: string;
    edgeWidth?: number;
  } = {}) {
    super();
    this.opacity = opacity;
    this.showEdges = showEdges;
    this.edgeColor = edgeColor;
    this.edgeWidth = edgeWidth;
  }

  _toSerializedParams() {
    return {
      type: this.nodeType,
      opacity: this.opacity,
      showEdges: this.showEdges,
      edgeColor: this.edgeColor,
      edgeWidth: this.edgeWidth,
    };
  }
}

/**
 * OVITO-style surface mesh: an alpha-shape envelope around the particles.
 *
 * Ports:
 *   inp.particle — atom data
 *   out.mesh     — surface mesh
 */
export class SurfaceMesh extends PipelineNode {
  readonly nodeType = "surface_mesh";
  protected readonly _outPorts = { mesh: "mesh" };
  protected readonly _inpPorts = { particle: "particle" };

  public alphaRadius: number;
  public color: string;
  public opacity: number;

  constructor({
    alphaRadius,
    color,
    opacity,
  }: { alphaRadius?: number; color?: string; opacity?: number } = {}) {
    super();
    const d = defaultsOf("surface_mesh");
    this.alphaRadius = alphaRadius ?? d.alphaRadius;
    this.color = color ?? d.color;
    this.opacity = opacity ?? d.opacity;
  }

  _toSerializedParams() {
    return {
      type: this.nodeType,
      alphaRadius: this.alphaRadius,
      color: this.color,
      opacity: this.opacity,
    };
  }
}

/**
 * Load a volumetric grid (Gaussian CUBE, OpenDX, ...). The file is parsed in
 * the browser; this node only records its name.
 *
 * Ports:
 *   out.volumetric — volumetric data
 */
export class LoadVolumetric extends PipelineNode {
  readonly nodeType = "load_volumetric";
  protected readonly _outPorts = { volumetric: "volumetric" };
  protected readonly _inpPorts: Record<string, string> = {};

  constructor(public path: string) {
    super();
  }

  _toSerializedParams() {
    return { type: this.nodeType, fileName: this.path, fileUrl: this.path };
  }
}

/** Options accepted by {@link Isosurface}. */
export interface IsosurfaceOptions {
  isoLevel?: number;
  color?: string;
  opacity?: number;
  showNegative?: boolean;
  negativeColor?: string;
  colorMode?: IsosurfaceColorMode;
  colormap?: VolumeColormap;
  colorRange?: [number, number];
}

/**
 * Extract an isosurface from volumetric data (marching cubes). With
 * `colorMode: "volume"` the surface is painted by sampling the volume wired
 * into `inp.colorVolumetric` through `colormap`.
 *
 * Ports:
 *   inp.volumetric      — volumetric data
 *   inp.colorVolumetric — optional volume sampled for coloring
 *   out.mesh            — isosurface mesh
 */
export class Isosurface extends PipelineNode {
  readonly nodeType = "isosurface";
  protected readonly _outPorts = { mesh: "mesh" };
  protected readonly _inpPorts = { volumetric: "volumetric", colorVolumetric: "colorVolumetric" };

  public isoLevel: number;
  public color: string;
  public opacity: number;
  public showNegative: boolean;
  public negativeColor: string;
  public colorMode: IsosurfaceColorMode;
  public colormap: VolumeColormap;
  public colorRange?: [number, number];

  constructor(options: IsosurfaceOptions = {}) {
    super();
    const d = defaultsOf("isosurface");
    this.isoLevel = options.isoLevel ?? d.isoLevel;
    this.color = options.color ?? d.color;
    this.opacity = options.opacity ?? d.opacity;
    this.showNegative = options.showNegative ?? d.showNegative;
    this.negativeColor = options.negativeColor ?? d.negativeColor;
    this.colorMode = options.colorMode ?? d.colorMode;
    this.colormap = options.colormap ?? d.colormap;
    this.colorRange = options.colorRange ?? d.colorRange;
  }

  _toSerializedParams() {
    const base: Record<string, unknown> = {
      type: this.nodeType,
      isoLevel: this.isoLevel,
      color: this.color,
      opacity: this.opacity,
      showNegative: this.showNegative,
      negativeColor: this.negativeColor,
      colorMode: this.colorMode,
      colormap: this.colormap,
    };
    if (this.colorRange !== undefined) base.colorRange = this.colorRange;
    return base;
  }
}

/**
 * Load a JCAMP-DX spectrum (`.jdx` / `.jcamp` / `.dx`). A spectrum has no 3D
 * coordinates, so it flows to {@link SpectrumPlot} rather than the Viewport.
 *
 * Ports:
 *   out.spectrum — spectrum data
 */
export class LoadSpectrum extends PipelineNode {
  readonly nodeType = "load_spectrum";
  protected readonly _outPorts = { spectrum: "spectrum" };
  protected readonly _inpPorts: Record<string, string> = {};

  constructor(public path: string) {
    super();
  }

  _toSerializedParams() {
    return { type: this.nodeType, fileName: this.path, fileUrl: this.path };
  }
}

/**
 * Draw a spectrum as a 2D line chart. Terminal node, like the Viewport.
 *
 * Ports:
 *   inp.spectrum — spectrum data
 */
export class SpectrumPlot extends PipelineNode {
  readonly nodeType = "spectrum_plot";
  protected readonly _outPorts: Record<string, string> = {};
  protected readonly _inpPorts = { spectrum: "spectrum" };

  public reverseX: boolean;
  public color: string;

  constructor({ reverseX, color }: { reverseX?: boolean; color?: string } = {}) {
    super();
    const d = defaultsOf("spectrum_plot");
    this.reverseX = reverseX ?? d.reverseX;
    this.color = color ?? d.color;
  }

  _toSerializedParams() {
    return { type: this.nodeType, reverseX: this.reverseX, color: this.color };
  }
}

/**
 * Configure per-atom vector visualization (e.g. forces, velocities).
 *
 * Ports:
 *   inp.vector — vector data in
 *   out.vector — configured vector data
 */
export class VectorOverlay extends PipelineNode {
  readonly nodeType = "vector_overlay";
  protected readonly _outPorts = { vector: "vector" };
  protected readonly _inpPorts = { vector: "vector" };

  public scale: number;

  constructor({ scale = 1.0 }: { scale?: number } = {}) {
    super();
    this.scale = scale;
  }

  _toSerializedParams() {
    return { type: this.nodeType, scale: this.scale };
  }
}

/**
 * 3D rendering output node. All data to be rendered must be connected here.
 *
 * Ports:
 *   inp.particle — atom data
 *   inp.bond     — bond data
 *   inp.cell     — simulation cell
 *   inp.traj     — trajectory channel
 *   inp.label    — text labels
 *   inp.mesh     — polyhedra mesh
 *   inp.vector   — vector field
 */
export class Viewport extends PipelineNode {
  readonly nodeType = "viewport";
  protected readonly _outPorts: Record<string, string> = {};
  protected readonly _inpPorts = {
    particle: "particle",
    bond: "bond",
    cell: "cell",
    traj: "trajectory",
    label: "label",
    mesh: "mesh",
    vector: "vector",
  };

  public perspective: boolean;
  public cellAxesVisible: boolean;
  public pivotMarkerVisible: boolean;

  constructor({
    perspective = false,
    cellAxesVisible = true,
    pivotMarkerVisible = true,
  }: {
    perspective?: boolean;
    cellAxesVisible?: boolean;
    pivotMarkerVisible?: boolean;
  } = {}) {
    super();
    this.perspective = perspective;
    this.cellAxesVisible = cellAxesVisible;
    this.pivotMarkerVisible = pivotMarkerVisible;
  }

  _toSerializedParams() {
    return {
      type: this.nodeType,
      perspective: this.perspective,
      cellAxesVisible: this.cellAxesVisible,
      pivotMarkerVisible: this.pivotMarkerVisible,
    };
  }
}

// ─── Node Registry ───────────────────────────────────────────────────

/** A builder node class whose instances serialize as node type `T`. */
type BuilderNodeClass<T extends PipelineNodeType> = new (
  ...args: never[]
) => PipelineNode & { readonly nodeType: T };

/**
 * Every builder node class, keyed by the node type it serializes to.
 *
 * The `satisfies` clause makes this exhaustive: adding a member to
 * `PipelineNodeType` without a builder class here — or registering a class
 * under the wrong key — is a compile error. `tests/ts/pipeline/builderCoverage.test.ts`
 * checks the same at runtime, plus ports and serialize round-trips.
 */
export const BUILDER_NODE_CLASSES = {
  load_structure: LoadStructure,
  load_trajectory: LoadTrajectory,
  load_vector: LoadVector,
  streaming: Streaming,
  add_bond: AddBonds,
  coordination_generator: AddCoordination,
  viewport: Viewport,
  filter: Filter,
  modify: Modify,
  symmetry: Symmetry,
  wrap: Wrap,
  replicate: Replicate,
  drawing_boundary: DrawingBoundary,
  boundary_completion: BoundaryCompletion,
  color: Color,
  representation: Representation,
  label_generator: AddLabels,
  polyhedron_generator: AddPolyhedra,
  surface_mesh: SurfaceMesh,
  vector_overlay: VectorOverlay,
  load_volumetric: LoadVolumetric,
  isosurface: Isosurface,
  load_spectrum: LoadSpectrum,
  spectrum_plot: SpectrumPlot,
} satisfies { [T in PipelineNodeType]: BuilderNodeClass<T> };

// ─── Pipeline Builder ─────────────────────────────────────────────────

type SerializedNode = SerializedPipeline["nodes"][number];
type SerializedEdge = SerializedPipeline["edges"][number];

/**
 * Pipeline graph builder.
 *
 * Build a DAG of processing nodes and serialize to the SerializedPipeline
 * v3 JSON format understood by the TypeScript pipeline engine.
 *
 * A Viewport node must be explicitly added and connected for data to be rendered.
 *
 * Example:
 *
 *   const pipe = new Pipeline()
 *   const s = pipe.addNode(new LoadStructure('protein.pdb'))
 *   const v = pipe.addNode(new Viewport())
 *   pipe.addEdge(s.out.particle, v.inp.particle)
 *   const json = pipe.toJSON()
 */
export class Pipeline {
  private _nodes: Map<string, SerializedNode> = new Map();
  private _edges: SerializedEdge[] = [];
  private _counter = 0;

  /**
   * Add a node to the pipeline.
   *
   * Returns the same node instance so its ports can be used in addEdge():
   *
   *   const s = pipe.addNode(new LoadStructure('protein.pdb'))
   *   pipe.addEdge(s.out.particle, ...)
   */
  addNode<T extends PipelineNode>(node: T): T {
    if (node._id !== null && this._nodes.has(node._id)) {
      throw new Error(
        `Node "${node._id}" has already been added to this pipeline. ` +
          "Create a new node instance instead of reusing the same one.",
      );
    }
    this._counter++;
    node._id = `${node.nodeType}-${this._counter}`;
    const params = node._toSerializedParams();
    this._nodes.set(node._id, {
      ...(params as PipelineNode["_toSerializedParams"] extends () => infer R ? R : never),
      id: node._id,
      position: { x: 0, y: 0 },
    } as SerializedNode);
    return node;
  }

  /**
   * Connect a source port to a target port.
   *
   * Both ports must belong to nodes already added to this pipeline:
   *
   *   pipe.addEdge(s.out.particle, f.inp.particle)
   *   pipe.addEdge(f.out.particle, v.inp.particle)
   */
  addEdge(source: NodePort, target: NodePort): void {
    if (!(source instanceof NodePort) || !(target instanceof NodePort)) {
      throw new TypeError(
        "addEdge() requires NodePort arguments. " +
          "Use node.out.<name> and node.inp.<name>, " +
          "e.g. pipe.addEdge(s.out.particle, f.inp.particle).",
      );
    }
    if (source.node._id === null || !this._nodes.has(source.node._id)) {
      throw new Error("Source node must be added to this pipeline before connecting.");
    }
    if (target.node._id === null || !this._nodes.has(target.node._id)) {
      throw new Error("Target node must be added to this pipeline before connecting.");
    }
    this._edges.push({
      source: source.node._id,
      target: target.node._id,
      sourceHandle: source.handle,
      targetHandle: target.handle,
    });
  }

  /**
   * Serialize to SerializedPipeline v3 format as a plain object.
   */
  toObject(): SerializedPipeline {
    return {
      version: 3,
      nodes: Array.from(this._nodes.values()),
      edges: [...this._edges],
    };
  }

  /**
   * Serialize to a JSON string (SerializedPipeline v3).
   */
  toJSON(indent = 2): string {
    return JSON.stringify(this.toObject(), null, indent);
  }
}
