import type * as THREE from "three";

/** Decoded molecular snapshot data. */
export interface Snapshot {
  nAtoms: number;
  nBonds: number;
  nFileBonds: number; // count of bonds from the structure file itself
  positions: Float32Array; // length = nAtoms * 3
  elements: Uint8Array; // length = nAtoms (atomic numbers)
  bonds: Uint32Array; // length = nBonds * 2
  bondOrders: Uint8Array | null; // length = nBonds (1=single,2=double,3=triple,4=aromatic)
  box: Float32Array | null; // length = 9 (3x3 row-major cell vectors)
  /** World-space lower corner (xlo,ylo,zlo) at which `box` is anchored, so the
   *  cell is drawn where the (absolute) atom coordinates actually are. Length 3.
   *  Null ⇒ origin at (0,0,0). Only formats with an explicit box origin
   *  (LAMMPS data/dump) set it; others keep atoms near the origin. */
  boxOrigin: Float32Array | null;
  /** Per-atom chain IDs as raw ASCII bytes (e.g. 65='A'). Null for formats without chain info. */
  atomChainIds: Uint8Array | null;
  /** Per-atom B-factors (temperature factors) in Å². Null for formats without B-factor info. */
  atomBFactors: Float32Array | null;
  // Cα backbone data for cartoon rendering (undefined for non-PDB or structures without atom names)
  caIndices?: Uint32Array; // indices of Cα atoms in positions array
  caChainIds?: Uint8Array; // per-Cα chain ID as ASCII byte (e.g. 65 = 'A')
  caResNums?: Uint32Array; // per-Cα residue sequence number
  caSsType?: Uint8Array; // per-Cα secondary structure: 0=coil, 1=helix, 2=sheet
  /**
   * Crystallographic symmetry operations as raw `x,y,z`-style strings, captured
   * from a CIF `_symmetry_equiv_pos_as_xyz` loop. Undefined for formats without
   * space-group information. The parser does NOT apply these: `positions` holds
   * the file's asymmetric unit as-is, and the `symmetry` pipeline node performs
   * the expansion into the full unit cell (its default "expand" mode).
   */
  symmetryOps?: string[];
}

/** Data mode for the application. */
export type DataMode = "streaming" | "local";

/** Bond source mode. */
export type BondSource = "structure" | "file" | "distance" | "none";

/** Trajectory source mode. */
export type TrajectorySource = "structure" | "file";

/** Label source mode. */
export type LabelSource = "none" | "structure" | "file";

/** Vector source mode. */
export type VectorSource = "none" | "file" | "demo";

/** Per-frame vector data. */
export interface VectorFrame {
  frame: number;
  vectors: Float32Array; // length = nAtoms * 3
}

/**
 * A named channel of per-atom vector data embedded in a structure/trajectory file.
 * A channel with one frame is "static" (same vectors for all playback frames).
 * A channel with N frames advances in sync with the trajectory.
 */
export interface VectorChannel {
  name: string; // e.g. "velocity", "force"
  frames: VectorFrame[];
}

/** Per-frame per-atom scalar data. */
export interface ScalarFrame {
  frame: number;
  values: Float32Array; // length = nAtoms
}

/**
 * A named channel of per-atom scalar data embedded in a structure file
 * (charges, selective-dynamics flags, LAMMPS dump computes, ...). Parsed so
 * file information is never silently discarded; not rendered yet.
 * One frame = static; N frames advance in sync with the trajectory.
 */
export interface ScalarChannel {
  name: string; // e.g. "charge", "mol_id", "c_pe"
  frames: ScalarFrame[];
}

/** Decoded trajectory frame.
 *
 * For *uniform* trajectories (the common case) a frame carries only
 * `positions`; the renderer reuses the base snapshot's elements/bonds/cell.
 * For *heterogeneous* trajectories (atom count / cell / elements change between
 * frames), the optional fields below are populated per frame so the renderer
 * can swap topology on playback. `undefined` means "reuse the snapshot".
 */
export interface Frame {
  frameId: number;
  nAtoms: number;
  positions: Float32Array; // length = nAtoms * 3
  /** Per-frame atomic numbers (length nAtoms). Set only when topology varies. */
  elements?: Uint8Array;
  /** Per-frame bond pairs [a0,b0,…] (length nBonds*2). Set only when topology varies. */
  bonds?: Uint32Array;
  /** Number of bonds in `bonds`. */
  nBonds?: number;
  /** Per-frame 3×3 cell (length 9). Set only when the cell varies. */
  box?: Float32Array | null;
  /** Per-frame box origin (length 3). Set only when the cell varies; otherwise
   *  the renderer reuses the base snapshot's `boxOrigin`. */
  boxOrigin?: Float32Array | null;
}

/** Trajectory metadata. */
export interface TrajectoryMeta {
  nFrames: number;
  timestepPs: number;
  nAtoms: number;
  pdbName?: string;
  xtcName?: string;
  /** Max atom count across all frames — drives one-time GPU buffer sizing.
   *  Undefined (== nAtoms) for uniform trajectories. */
  maxAtoms?: number;
  /** True when frames differ in atom count, cell, or elements. */
  heterogeneous?: boolean;
  variesAtoms?: boolean;
  variesCell?: boolean;
  variesTopology?: boolean;
}

/** Interface for atom rendering backends. */
export interface AtomRenderer {
  readonly mesh: THREE.Object3D;
  loadSnapshot(snapshot: Snapshot, colorCtx?: import("./colorSchemes").ColorContext): void;
  updatePositions(positions: Float32Array): void;
  setScale?(scale: number, snapshot: Snapshot): void;
  setUniformRadius?(radius: number | null, snapshot: Snapshot): void;
  /** Fraction of the vdW radius atoms are drawn at (ball-and-stick vs spacefill). */
  setRadiusScale?(scale: number, snapshot: Snapshot): void;
  /** Toggle flat, unlit shading with a silhouette outline (illustrative mode). */
  setIllustrative?(enabled: boolean): void;
  setOpacity?(opacity: number): void;
  setScaleOverrides?(overrides: Float32Array): void;
  setOpacityOverrides?(overrides: Float32Array): void;
  clearOverrides?(): void;
  /**
   * Hide a subset of atoms (e.g. those rendered as lines by a separate
   * renderer). `mask[i] === 1` hides atom `i`; `null` shows all. Composes with
   * scale overrides without clobbering them.
   */
  setHiddenMask?(mask: Uint8Array | null): void;
  dispose(): void;
}

/** Interface for bond rendering backends. */
export interface BondRenderer {
  readonly mesh: THREE.Object3D;
  loadSnapshot(snapshot: Snapshot, colorCtx?: import("./colorSchemes").ColorContext): void;
  updatePositions(positions: Float32Array, bonds: Uint32Array, nBonds: number): void;
  setOpacity?(opacity: number): void;
  setScale?(scale: number, snapshot: Snapshot): void;
  setUniformRadius?(radius: number | null, snapshot?: Snapshot): void;
  setBondOpacityOverrides?(overrides: Float32Array): void;
  clearBondOpacityOverrides?(): void;
  /**
   * Hide every bond with at least one endpoint atom in `mask` (`mask[i] === 1`).
   * `null` shows all bonds. Used to suppress the cylinder bonds of atoms that a
   * per-atom representation draws as lines instead.
   */
  setHiddenMask?(mask: Uint8Array | null): void;
  dispose(): void;
}

/** Hover info for atoms. */
export interface AtomHoverInfo {
  kind: "atom";
  atomIndex: number;
  elementSymbol: string;
  atomicNumber: number;
  position: [number, number, number];
  screenX: number;
  screenY: number;
}

/** Hover info for bonds. */
export interface BondHoverInfo {
  kind: "bond";
  atomA: number;
  atomB: number;
  bondOrder: number;
  bondLength: number;
  screenX: number;
  screenY: number;
}

export type HoverInfo = AtomHoverInfo | BondHoverInfo | null;

/** Atom selection state. */
export interface SelectionState {
  atoms: number[];
}

/** Geometric measurement result. */
export interface Measurement {
  atoms: number[];
  type: "distance" | "angle" | "dihedral";
  value: number;
  label: string;
}

/** A measurement pinned to the persistent list. */
export interface StoredMeasurement {
  id: string;
  name: string;
  atoms: number[];
  type: "distance" | "angle" | "dihedral";
  value: number;
  label: string;
  hidden: boolean;
  createdAt: number;
}
