/**
 * Core WASM parse logic, shared by the main-thread sync path
 * (`parseClientSync.ts`) and the Web Worker (`parse.worker.ts`).
 *
 * This module holds the ONLY code that touches the WASM parsers and converts
 * their results into megane `Snapshot` / `Frame[]` shapes. Both the worker and
 * the synchronous fallback call these functions, guaranteeing byte-identical
 * output regardless of which host/threading path is used.
 *
 * File reading (`File.text()` / `File.arrayBuffer()`) happens in the client
 * wrappers; the functions here take already-read `text` / `bytes`.
 */

import type { Snapshot, Frame, TrajectoryMeta, VectorChannel, ScalarChannel } from "../types";
import { deserializeScalarChannels, deserializeVectorChannels } from "./vectorChannels";
import { perfMark, perfMeasure } from "../perf";

export interface StructureParseResult {
  snapshot: Snapshot;
  frames: Frame[];
  meta: TrajectoryMeta | null;
  labels: string[] | null;
  /** Per-atom vector channels embedded in the file (e.g. GRO velocities). */
  vectorChannels: VectorChannel[];
  /** Per-atom scalar channels embedded in the file (charges, flags, ...). */
  scalarChannels: ScalarChannel[];
  /** Non-fatal parse warnings surfaced by the parser (empty when clean). */
  warnings: string[];
}

export interface XTCParseResult {
  frames: Frame[];
  meta: TrajectoryMeta;
  /** Per-atom vector channels embedded in the file (e.g. LAMMPS dump vx/vy/vz). */
  vectorChannels: VectorChannel[];
}

/** Trajectory formats handled by the binary/text trajectory parsers. */
export type TrajectoryKind = "xtc" | "dcd" | "lammpstrj" | "netcdf";

let initPromise: Promise<void> | null = null;
let wasmModule: WasmModule | null = null;

interface WasmParseResult {
  n_atoms: number;
  n_bonds: number;
  n_file_bonds: number;
  n_frames: number;
  has_box: boolean;
  has_atom_labels: boolean;
  has_chain_ids: boolean;
  has_bfactors: boolean;
  atom_labels: string;
  vector_channel_count: number;
  vector_channel_meta: string;
  scalar_channel_count: number;
  scalar_channel_meta: string;
  warnings: string;
  ca_count: number;
  symmetry_op_count: number;
  symmetry_ops: string;
  positions(): Float32Array;
  elements(): Uint8Array;
  bonds(): Uint32Array;
  bond_orders(): Uint8Array;
  box_matrix(): Float32Array;
  box_origin(): Float32Array;
  frame_data(): Float32Array;
  chain_ids(): Uint8Array;
  bfactors(): Float32Array;
  vector_channel_data(): Float32Array;
  scalar_channel_data(): Float32Array;
  ca_indices(): Uint32Array;
  ca_chain_ids(): Uint8Array;
  ca_res_nums(): Uint32Array;
  ca_ss_type(): Uint8Array;
  // Heterogeneous-trajectory side table (all empty/false for uniform files).
  heterogeneous: boolean;
  varies_atoms: boolean;
  varies_cell: boolean;
  varies_topology: boolean;
  max_atoms: number;
  frame_atom_offsets(): Uint32Array;
  frame_elements(): Uint8Array;
  frame_cells(): Float32Array;
  frame_bond_offsets(): Uint32Array;
  frame_bonds(): Uint32Array;
  free(): void;
}

interface WasmXtcResult {
  n_atoms: number;
  n_frames: number;
  timestep_ps: number;
  has_box: boolean;
  vector_channel_count: number;
  vector_channel_meta: string;
  box_matrix(): Float32Array;
  box_origin(): Float32Array;
  frame_data(): Float32Array;
  vector_channel_data(): Float32Array;
  // Heterogeneous side table (all empty/false on the uniform fast path).
  heterogeneous: boolean;
  varies_atoms: boolean;
  varies_cell: boolean;
  varies_topology: boolean;
  max_atoms: number;
  frame_atom_offsets(): Uint32Array;
  frame_elements(): Uint8Array;
  frame_cells(): Float32Array;
  free(): void;
}

/**
 * Minimal surface of any persistent per-frame decoder (trajectory OR multi-frame
 * structure). The worker keeps these in one map and only needs `decode_frame`,
 * `n_atoms`, and `free` to service `decodeFrame` / `disposeTrajectory` requests.
 */
export interface WasmFrameDecoder {
  readonly n_atoms: number;
  decode_frame(frame: number): Float32Array;
  free(): void;
}

/** Common surface of a persistent lazy trajectory decoder (XTC / LAMMPS dump). */
export interface WasmTrajectoryDecoder extends WasmFrameDecoder {
  readonly n_frames: number;
  readonly timestep_ps: number;
  readonly has_box: boolean;
  box_matrix(): Float32Array;
  box_origin(): Float32Array;
}

/** Persistent XTC decoder (owns the file bytes; decodes one frame on demand). */
export interface WasmXtcDecoder extends WasmTrajectoryDecoder {
  times(): Float32Array;
}

/** Persistent LAMMPS-dump decoder, additionally exposing per-frame vectors. */
export interface WasmLammpstrjDecoder extends WasmTrajectoryDecoder {
  readonly vector_channel_count: number;
  /** Newline-joined channel names (velocity/force), in decode order. */
  readonly vector_channel_names: string;
  /** True when the dump's atom count varies — host reparses eagerly. */
  readonly heterogeneous: boolean;
  decode_frame_vectors(frame: number): Float32Array;
}

/** Persistent decoder for the extra frames of a multi-frame structure file (XYZ / PDB). */
export interface WasmStructureFrameDecoder extends WasmFrameDecoder {
  /** Number of EXTRA frames (excludes the eager snapshot frame 0). */
  readonly n_frames: number;
  /** True when frames vary in atom count / cell — host reparses eagerly. */
  readonly heterogeneous: boolean;
  /** Parse frame 0 (the eager snapshot) from the held bytes — no re-read. */
  frame0(): WasmParseResult;
}

/** Lazy trajectory formats with a persistent per-frame decoder. */
export type LazyTrajectoryKind = "xtc" | "lammpstrj";

/** Multi-frame structure formats with lazy extra-frame decode (frame 0 is eager). */
export type LazyStructureKind = "xyz" | "pdb";

/** Lightweight structure-frame index (from `indexStructureCore`) — no bulk coordinates. */
export interface StructureIndexResult {
  nAtoms: number;
  /** Number of decodable EXTRA frames (excludes the eager snapshot frame 0). */
  nFrames: number;
  /**
   * True when the file is heterogeneous (frames vary in atom count / cell). The
   * lazy positions-only decoder cannot represent such frames, so the caller
   * discards the decoder and reparses the whole file eagerly.
   */
  heterogeneous: boolean;
}

/** Lightweight trajectory index (from `indexTrajectoryCore`) — no bulk coordinates. */
export interface TrajectoryIndexResult {
  nAtoms: number;
  nFrames: number;
  timestepPs: number;
  hasBox: boolean;
  box: Float32Array | null;
  /** Box origin (length 3); null ⇒ (0,0,0). Set only for LAMMPS dumps. */
  boxOrigin: Float32Array | null;
  times: Float32Array;
  /** Embedded per-atom vector channel names (LAMMPS velocity/force); empty otherwise. */
  vectorChannelNames: string[];
  /**
   * True when the trajectory's atom count varies between frames (LAMMPS dump).
   * The positions-only lazy decoder cannot stream such frames, so the caller
   * discards the decoder and reparses the whole file eagerly.
   */
  heterogeneous: boolean;
}

type ParseFn = (text: string) => WasmParseResult;
type BinaryParseFn = (data: Uint8Array) => WasmParseResult;
type TrajTextParseFn = (text: string) => WasmXtcResult;
type TrajBinaryParseFn = (data: Uint8Array) => WasmXtcResult;

interface WasmModule {
  parse_pdb: ParseFn;
  parse_gro: ParseFn;
  parse_xyz: ParseFn;
  parse_molden: ParseFn;
  parse_xsf: ParseFn;
  parse_c3xml: ParseFn;
  parse_odydata: ParseFn;
  parse_cml: ParseFn;
  parse_magres: ParseFn;
  parse_gamess: ParseFn;
  parse_phonon: ParseFn;
  parse_vasp: ParseFn;
  parse_mol: ParseFn;
  parse_mol2: ParseFn;
  parse_cif: ParseFn;
  parse_mmcif: ParseFn;
  parse_lammps_data: ParseFn;
  parse_prmtop: ParseFn;
  parse_traj: BinaryParseFn;
  parse_lammpstrj_structure: ParseFn;
  parse_xtc_file: TrajBinaryParseFn;
  parse_dcd_file: TrajBinaryParseFn;
  parse_netcdf_file: TrajBinaryParseFn;
  parse_lammpstrj_file: TrajTextParseFn;
  parse_structure_prefix: (text: string, kind: string, isWholeFile: boolean) => WasmParseResult;
  decode_trajectory_frame0: (data: Uint8Array, kind: string, nAtoms: number) => Float32Array;
  XtcDecoder: new (data: Uint8Array) => WasmXtcDecoder;
  LammpstrjDecoder: new (data: Uint8Array) => WasmLammpstrjDecoder;
  StructureFrameDecoder: new (data: Uint8Array, kind: string) => WasmStructureFrameDecoder;
  infer_bonds_vdw: (positions: Float32Array, elements: Uint8Array, n_atoms: number) => Uint32Array;
  parse_top_bonds: (text: string, n_atoms: number) => Uint32Array;
  parse_top_bonds_with_includes: (
    text: string,
    include_files: Record<string, string>,
    n_atoms: number,
  ) => Uint32Array;
  parse_psf_bonds: (text: string, n_atoms: number) => Uint32Array;
  parse_pdb_bonds: (text: string, n_atoms: number) => Uint32Array;
  extract_labels: (text: string, format: string) => string;
}

/**
 * Initialise the WASM module (memoized). `wasmUrl` is resolved on the main
 * thread and passed explicitly so this works inside a Web Worker, whose global
 * scope cannot see `globalThis.__MEGANE_WASM_URL__`. When omitted it falls back
 * to that global (the main-thread default).
 */
export async function ensureInit(wasmUrl?: string): Promise<void> {
  if (wasmModule) return;
  if (!initPromise) {
    initPromise = (async () => {
      perfMark("megane:wasm:start");
      const wasm = await import("../../crates/megane-wasm/pkg");
      const url =
        wasmUrl ??
        ((globalThis as Record<string, unknown>).__MEGANE_WASM_URL__ as string | undefined);
      await wasm.default(url);
      perfMark("megane:wasm:end");
      perfMeasure("megane:wasm-init", "megane:wasm:start", "megane:wasm:end");
      wasmModule = {
        parse_pdb: wasm.parse_pdb,
        parse_gro: wasm.parse_gro,
        parse_xyz: wasm.parse_xyz,
        parse_molden: wasm.parse_molden,
        parse_xsf: wasm.parse_xsf,
        parse_c3xml: wasm.parse_c3xml,
        parse_odydata: wasm.parse_odydata,
        parse_cml: wasm.parse_cml,
        parse_magres: wasm.parse_magres,
        parse_gamess: wasm.parse_gamess,
        parse_phonon: wasm.parse_phonon,
        parse_vasp: wasm.parse_vasp,
        parse_mol: wasm.parse_mol,
        parse_mol2: wasm.parse_mol2,
        parse_cif: wasm.parse_cif,
        parse_mmcif: wasm.parse_mmcif,
        parse_lammps_data: wasm.parse_lammps_data,
        parse_prmtop: wasm.parse_prmtop,
        parse_traj: wasm.parse_traj,
        parse_lammpstrj_structure: wasm.parse_lammpstrj_structure,
        parse_xtc_file: wasm.parse_xtc_file,
        parse_dcd_file: wasm.parse_dcd_file,
        parse_netcdf_file: wasm.parse_netcdf_file,
        parse_lammpstrj_file: wasm.parse_lammpstrj_file,
        parse_structure_prefix: wasm.parse_structure_prefix,
        decode_trajectory_frame0: wasm.decode_trajectory_frame0,
        XtcDecoder: wasm.XtcDecoder,
        LammpstrjDecoder: wasm.LammpstrjDecoder,
        StructureFrameDecoder: wasm.StructureFrameDecoder,
        infer_bonds_vdw: wasm.infer_bonds_vdw,
        parse_top_bonds: wasm.parse_top_bonds,
        parse_top_bonds_with_includes: wasm.parse_top_bonds_with_includes,
        parse_psf_bonds: wasm.parse_psf_bonds,
        parse_pdb_bonds: wasm.parse_pdb_bonds,
        extract_labels: wasm.extract_labels,
      };
    })();
  }
  await initPromise;
}

/** Choose the appropriate WASM parser based on file extension. */
function getParserForExtension(ext: string): ParseFn {
  switch (ext) {
    case ".gro":
      return wasmModule!.parse_gro;
    // Jmol writes plain XYZ under a second extension. megane's XYZ reader
    // already covers what Jmol's does -- multi-frame blocks, `Lattice=`
    // extended headers, and extra per-atom columns after x/y/z (kept as the
    // atom label) -- so `.jxyz` is an alias, not a second parser. The labels
    // stay adjacent because `no-fallthrough` counts a comment-only case body
    // as a fallthrough.
    case ".xyz":
    case ".jxyz":
      return wasmModule!.parse_xyz;
    // XCrySDen. `.axsf` is the same grammar with an `ANIMSTEPS` header, so it
    // arrives as a multi-frame structure through the one parser.
    case ".xsf":
    case ".axsf":
      return wasmModule!.parse_xsf;
    // VASP POSCAR / CONTCAR / XDATCAR. Those filenames carry no extension, so
    // `structureExtFromFileName` (fileNames.ts) maps them onto this synthetic
    // `.vasp` extension before dispatch. An XDATCAR arrives as a multi-frame
    // structure, exactly like a multi-frame XYZ.
    case ".vasp":
      return wasmModule!.parse_vasp;
    case ".mol":
    case ".sdf":
      return wasmModule!.parse_mol;
    case ".mol2":
      return wasmModule!.parse_mol2;
    // Molden. `[Atoms]` is the static structure; a `[GEOMETRIES] XYZ`
    // block makes it multi-frame via the shared XYZ frame reader.
    case ".molden":
      return wasmModule!.parse_molden;
    // Chem3D XML (CDXML family). Nodes carry explicit bonds, so no
    // distance inference is needed for genuine 3D input.
    case ".c3xml":
      return wasmModule!.parse_c3xml;
    // Wavefunction Odyssey. `.xodydata` is XML and `.odydata` is the older
    // Spartan-style text layout, but either layout can turn up under either
    // name, so one parser sniffs the content and handles both.
    case ".xodydata":
    case ".odydata":
      return wasmModule!.parse_odydata;
    // Chemical Markup Language (Open Babel / Avogadro / ChemDraw).
    case ".cml":
      return wasmModule!.parse_cml;
    // CASTEP / Quantum ESPRESSO NMR output. The [atoms] block is the
    // structure; the ms/efg/isc tensors in [magres] are a follow-up.
    case ".magres":
      return wasmModule!.parse_magres;
    // GAMESS log output. Only `.gamess` is claimed -- registering `*.log`
    // or `*.out` would hijack every log file in the user's workspace.
    case ".gamess":
      return wasmModule!.parse_gamess;
    // CASTEP lattice dynamics. The header is the structure; mode
    // animation is a follow-up feature, shared with Molden [FREQ].
    case ".phonon":
      return wasmModule!.parse_phonon;
    case ".cif":
      return wasmModule!.parse_cif;
    case ".mmcif":
      return wasmModule!.parse_mmcif;
    case ".data":
    case ".lammps":
      return wasmModule!.parse_lammps_data;
    // LAMMPS dump opened standalone as a multi-frame structure (topology from
    // frame 0, remaining frames stream into playback). Element identities are
    // the integer LAMMPS `type` ids used as an atomic-number proxy.
    case ".lammpstrj":
    case ".dump":
    case ".trj":
      return wasmModule!.parse_lammpstrj_structure;
    case ".prmtop":
      return wasmModule!.parse_prmtop;
    default:
      return wasmModule!.parse_pdb;
  }
}

/**
 * Convert a WASM structure parse result into `Snapshot` + `Frame[]`.
 * Exported for unit testing with a hand-built mock result (no WASM required).
 */
export function parseWithFn(parseFn: ParseFn, text: string): StructureParseResult {
  const result = parseFn(text) as WasmParseResult;

  const caCount = result.ca_count;
  const symmetryOps = result.symmetry_op_count > 0 ? result.symmetry_ops.split("\n") : undefined;
  const snapshot: Snapshot = {
    nAtoms: result.n_atoms,
    nBonds: result.n_bonds,
    nFileBonds: result.n_file_bonds,
    positions: result.positions(),
    elements: result.elements(),
    bonds: result.bonds(),
    bondOrders: result.bond_orders(),
    box: result.has_box ? result.box_matrix() : null,
    boxOrigin: result.has_box && result.box_origin().length === 3 ? result.box_origin() : null,
    atomChainIds: result.has_chain_ids ? result.chain_ids() : null,
    atomBFactors: result.has_bfactors ? result.bfactors() : null,
    ...(caCount > 0 && {
      caIndices: result.ca_indices(),
      caChainIds: result.ca_chain_ids(),
      caResNums: result.ca_res_nums(),
      caSsType: result.ca_ss_type(),
    }),
    ...(symmetryOps && { symmetryOps }),
  };

  const heterogeneous = result.heterogeneous === true;
  const frames: Frame[] = heterogeneous
    ? extractHeteroFrames(result)
    : extractUniformFrames(result);

  const labels: string[] | null = result.has_atom_labels ? result.atom_labels.split("\n") : null;

  const vectorChannels = deserializeVectorChannels(result.n_atoms, result.vector_channel_meta, () =>
    result.vector_channel_data(),
  );

  const scalarChannels = deserializeScalarChannels(result.n_atoms, result.scalar_channel_meta, () =>
    result.scalar_channel_data(),
  );

  // Surface non-fatal parser warnings (e.g. atoms the file declares that the
  // parser could not represent) instead of letting them vanish silently.
  const warnings = result.warnings ? result.warnings.split("\n") : [];
  for (const w of warnings) {
    console.warn(`[megane parser] ${w}`);
  }

  const heteroMeta = heterogeneous
    ? {
        maxAtoms: result.max_atoms,
        heterogeneous: true as const,
        variesAtoms: result.varies_atoms,
        variesCell: result.varies_cell,
        variesTopology: result.varies_topology,
      }
    : undefined;

  result.free();

  const meta: TrajectoryMeta | null =
    frames.length > 0
      ? {
          nFrames: frames.length + 1,
          timestepPs: 1.0,
          nAtoms: snapshot.nAtoms,
          ...heteroMeta,
        }
      : null;

  return { snapshot, frames, meta, labels, vectorChannels, scalarChannels, warnings };
}

/**
 * Extract extra frames for a *uniform* structure trajectory — the fast path.
 * One wasm→JS copy for all frames; each frame is a zero-copy `subarray` view
 * into that single backing buffer (kept alive by the views). Frames are
 * read-only downstream, so sharing one buffer is safe.
 */
function extractUniformFrames(result: WasmParseResult): Frame[] {
  const frames: Frame[] = [];
  if (result.n_frames > 0) {
    const allData = result.frame_data();
    const stride = result.n_atoms * 3;
    for (let i = 0; i < result.n_frames; i++) {
      frames.push({
        frameId: i + 1,
        nAtoms: result.n_atoms,
        positions: allData.subarray(i * stride, (i + 1) * stride),
      });
    }
  }
  return frames;
}

/**
 * Extract extra frames for a *heterogeneous* trajectory (atom count / cell /
 * elements vary). Positions are jagged, sliced by `frame_atom_offsets`; the
 * optional per-frame `elements`/`bonds`/`box` are attached only for the
 * channels that actually vary (empty wasm arrays ⇒ reuse the snapshot).
 */
function extractHeteroFrames(result: WasmParseResult): Frame[] {
  const frames: Frame[] = [];
  const nFrames = result.n_frames;
  if (nFrames === 0) return frames;

  // One wasm→JS copy of each channel; per-frame views subarray into these.
  const allPos = result.frame_data();
  const offsets = result.frame_atom_offsets(); // atoms, length nFrames+1
  const elemsFlat = result.frame_elements(); // empty ⇒ topology constant
  const cellsFlat = result.frame_cells(); // empty ⇒ cell constant
  const bondOffsets = result.frame_bond_offsets(); // pairs, empty ⇒ topology constant
  const bondsFlat = result.frame_bonds();

  const hasElems = elemsFlat.length > 0;
  const hasCells = cellsFlat.length > 0;
  const hasBonds = bondsFlat.length > 0 && bondOffsets.length > 0;

  for (let i = 0; i < nFrames; i++) {
    const a = offsets[i];
    const b = offsets[i + 1];
    const nAtoms = b - a;
    const frame: Frame = {
      frameId: i + 1,
      nAtoms,
      positions: allPos.subarray(a * 3, b * 3),
    };
    if (hasElems) frame.elements = elemsFlat.subarray(a, b);
    if (hasCells) frame.box = cellsFlat.subarray(i * 9, i * 9 + 9);
    if (hasBonds) {
      const ba = bondOffsets[i];
      const bb = bondOffsets[i + 1];
      frame.bonds = bondsFlat.subarray(ba * 2, bb * 2);
      frame.nBonds = bb - ba;
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * Convert a WASM trajectory parse result into `Frame[]` + meta + channels.
 * Exported for unit testing with a hand-built mock result (no WASM required).
 */
export function extractFrames(
  result: WasmXtcResult,
  expectedNAtoms: number,
  formatLabel: string,
): XTCParseResult {
  // Frame 0 defines the base topology; its atom count must match the loaded
  // structure even for heterogeneous (variable-atom) trajectories.
  if (result.n_atoms !== expectedNAtoms) {
    const msg = `${formatLabel} atom count (${result.n_atoms}) does not match structure (${expectedNAtoms})`;
    result.free();
    throw new Error(msg);
  }

  // One wasm→JS copy for the whole trajectory; each frame is a zero-copy view
  // (subarray) into that single backing buffer. Frames are read-only downstream,
  // so sharing one buffer is safe. Keep `allData` alive via these views.
  const allData = result.frame_data();
  const nFrames = result.n_frames;
  const frames: Frame[] = [];
  const heterogeneous = result.heterogeneous === true;

  if (heterogeneous) {
    // Slice jagged positions by per-frame atom offsets (empty ⇒ fixed atom
    // count, e.g. per-frame-cell XTC/DCD/NetCDF); attach the per-frame cell
    // (empty ⇒ constant cell) and per-frame element/type ids (empty ⇒ constant
    // topology). The renderer swaps cell / re-topologises only when a frame
    // carries those optional fields.
    const offsets = result.frame_atom_offsets(); // atoms, length nFrames+1 or empty
    const cellsFlat = result.frame_cells(); // 9 floats/frame or empty
    const elemsFlat = result.frame_elements(); // per-frame ids or empty
    const hasOffsets = offsets.length > 0;
    const hasCells = cellsFlat.length > 0;
    const hasElems = elemsFlat.length > 0;
    for (let i = 0; i < nFrames; i++) {
      const aAtoms = hasOffsets ? offsets[i] : i * result.n_atoms;
      const bAtoms = hasOffsets ? offsets[i + 1] : (i + 1) * result.n_atoms;
      const frame: Frame = {
        frameId: i,
        nAtoms: bAtoms - aAtoms,
        positions: allData.subarray(aAtoms * 3, bAtoms * 3),
      };
      if (hasElems) {
        frame.elements = elemsFlat.subarray(aAtoms, bAtoms);
      }
      if (hasCells) {
        frame.box = cellsFlat.subarray(i * 9, i * 9 + 9);
      }
      frames.push(frame);
    }
  } else {
    const stride = result.n_atoms * 3;
    for (let i = 0; i < nFrames; i++) {
      frames.push({
        frameId: i,
        nAtoms: result.n_atoms,
        positions: allData.subarray(i * stride, (i + 1) * stride),
      });
    }
  }

  const meta: TrajectoryMeta = {
    nFrames,
    timestepPs: result.timestep_ps,
    nAtoms: result.n_atoms,
    ...(heterogeneous
      ? {
          heterogeneous: true,
          maxAtoms: result.max_atoms,
          variesAtoms: result.varies_atoms,
          variesCell: result.varies_cell,
          variesTopology: result.varies_topology,
        }
      : {}),
  };

  const vectorChannels = deserializeVectorChannels(result.n_atoms, result.vector_channel_meta, () =>
    result.vector_channel_data(),
  );

  result.free();
  return { frames, meta, vectorChannels };
}

/**
 * Remap a heterogeneous LAMMPS-dump trajectory's per-frame element ids.
 *
 * A LAMMPS dump carries integer atom *types*, not elements. When the atom count
 * varies (GCMC / deposition) the trajectory lane emits those raw type ids as
 * each frame's `elements`; this maps them to real atomic numbers using the
 * `type → element` correspondence established by frame 0 against the separately
 * loaded structure (whose `structureElements` line up 1:1 with frame-0 atoms).
 * Types absent from frame 0 fall back to element 0 (unknown / gray).
 *
 * Returns NEW frames with remapped element copies — the parser's own output is
 * never mutated (CRITICAL RULE #11: what the parser returned stays what the
 * file asserted). Frames without per-frame elements are shared unchanged, and
 * the whole input is returned as-is when no remapping applies.
 */
export function remapTrajectoryTypesToElements(
  frames: Frame[],
  structureElements: Uint8Array,
): Frame[] {
  if (frames.length === 0 || !frames[0].elements) return frames;
  const typeToElement = new Map<number, number>();
  const frame0Types = frames[0].elements;
  const n = Math.min(frame0Types.length, structureElements.length);
  for (let i = 0; i < n; i++) {
    if (!typeToElement.has(frame0Types[i])) {
      typeToElement.set(frame0Types[i], structureElements[i]);
    }
  }
  return frames.map((frame) => {
    const elems = frame.elements;
    if (!elems) return frame;
    const mapped = new Uint8Array(elems.length);
    for (let i = 0; i < elems.length; i++) {
      mapped[i] = typeToElement.get(elems[i]) ?? 0;
    }
    return { ...frame, elements: mapped };
  });
}

/** Input for the structure parse core (already read from the File). */
export interface StructureParseInput {
  ext: string;
  text?: string;
  bytes?: Uint8Array;
}

/** Parse structure text/bytes (post file-read). Requires `ensureInit` first. */
export function parseStructureCore(input: StructureParseInput): StructureParseResult {
  if (input.ext === ".traj") {
    const bytes = input.bytes ?? new Uint8Array();
    const result = wasmModule!.parse_traj(bytes);
    return parseWithFn(() => result, "");
  }
  const parseFn = getParserForExtension(input.ext);
  return parseWithFn(parseFn, input.text ?? "");
}

/** Input for the trajectory parse core (already read from the File). */
export interface TrajectoryParseInput {
  kind: TrajectoryKind;
  text?: string;
  bytes?: Uint8Array;
  expectedNAtoms: number;
}

const TRAJ_LABELS: Record<TrajectoryKind, string> = {
  xtc: "XTC",
  dcd: "DCD",
  lammpstrj: "LAMMPS dump",
  netcdf: "AMBER NetCDF",
};

/** Parse trajectory text/bytes (post file-read). Requires `ensureInit` first. */
export function parseTrajectoryCore(input: TrajectoryParseInput): XTCParseResult {
  let result: WasmXtcResult;
  switch (input.kind) {
    case "xtc":
      result = wasmModule!.parse_xtc_file(input.bytes ?? new Uint8Array());
      break;
    case "dcd":
      result = wasmModule!.parse_dcd_file(input.bytes ?? new Uint8Array());
      break;
    case "netcdf":
      result = wasmModule!.parse_netcdf_file(input.bytes ?? new Uint8Array());
      break;
    case "lammpstrj":
      result = wasmModule!.parse_lammpstrj_file(input.text ?? "");
      break;
  }
  return extractFrames(result, input.expectedNAtoms, TRAJ_LABELS[input.kind]);
}

/**
 * Build a lazy trajectory decoder + its frame index without decoding any
 * coordinates. The returned `decoder` OWNS the file bytes in WASM memory and
 * must be kept alive (and eventually `free()`d) by the caller — unlike the eager
 * parse path which frees its result immediately. Requires `ensureInit` first.
 */
export function indexTrajectoryCore(
  bytes: Uint8Array,
  kind: LazyTrajectoryKind,
  expectedNAtoms: number,
): { decoder: WasmTrajectoryDecoder; index: TrajectoryIndexResult } {
  const decoder: WasmTrajectoryDecoder =
    kind === "lammpstrj"
      ? new wasmModule!.LammpstrjDecoder(bytes)
      : new wasmModule!.XtcDecoder(bytes);
  if (decoder.n_atoms !== expectedNAtoms) {
    const label = kind === "lammpstrj" ? "LAMMPS dump" : "XTC";
    const msg = `${label} atom count (${decoder.n_atoms}) does not match structure (${expectedNAtoms})`;
    decoder.free();
    throw new Error(msg);
  }
  const vectorChannelNames =
    kind === "lammpstrj"
      ? (decoder as WasmLammpstrjDecoder).vector_channel_names
          .split("\n")
          .filter((s) => s.length > 0)
      : [];
  const index: TrajectoryIndexResult = {
    nAtoms: decoder.n_atoms,
    nFrames: decoder.n_frames,
    timestepPs: decoder.timestep_ps,
    hasBox: decoder.has_box,
    box: decoder.has_box ? decoder.box_matrix() : null,
    boxOrigin: decoder.has_box && decoder.box_origin().length === 3 ? decoder.box_origin() : null,
    times: kind === "xtc" ? (decoder as WasmXtcDecoder).times() : new Float32Array(0),
    vectorChannelNames,
    heterogeneous: kind === "lammpstrj" && (decoder as WasmLammpstrjDecoder).heterogeneous === true,
  };
  return { decoder, index };
}

/**
 * Build a persistent structure-frame decoder for a multi-frame structure file
 * (XYZ / PDB) AND parse frame 0 (the eager snapshot) from the SAME held bytes —
 * one file read yields both the index and frame 0, so frame 0 can render before
 * the rest is decoded. The `decoder` OWNS the file bytes in WASM memory and must
 * be kept alive (and eventually `free()`d) by the caller (unlike `frame0`, which
 * is a normal result whose buffers are freed here). Requires `ensureInit` first.
 */
export function indexStructureCore(
  bytes: Uint8Array,
  kind: LazyStructureKind,
): {
  decoder: WasmStructureFrameDecoder;
  index: StructureIndexResult;
  frame0: StructureParseResult;
} {
  const decoder = new wasmModule!.StructureFrameDecoder(bytes, kind);
  const index: StructureIndexResult = {
    nAtoms: decoder.n_atoms,
    nFrames: decoder.n_frames,
    heterogeneous: decoder.heterogeneous === true,
  };
  const frame0 = parseWithFn(() => decoder.frame0(), "");
  return { decoder, index, frame0 };
}

/**
 * Parse ONLY frame 0 from a bounded PREFIX of a large multi-frame structure file
 * (XYZ / PDB) — for size-independent first paint. Throws (caught upstream so the
 * caller grows the prefix or falls back to a full read) if frame 0 is not fully
 * contained in the prefix. `isWholeFile` is true when the prefix covers the whole
 * file. Requires `ensureInit` first.
 */
export function parseStructurePrefixCore(
  text: string,
  kind: LazyStructureKind,
  isWholeFile: boolean,
): StructureParseResult {
  return parseWithFn(() => wasmModule!.parse_structure_prefix(text, kind, isWholeFile), "");
}

/**
 * Decode ONLY frame 0 (positions, Å) from a bounded prefix of a large trajectory
 * (XTC / LAMMPS dump). Throws (caught upstream → grow the prefix / fall back) if
 * the prefix is too small to hold frame 0. Requires `ensureInit` first.
 */
export function decodeTrajectoryFrame0Core(
  bytes: Uint8Array,
  kind: LazyTrajectoryKind,
  nAtoms: number,
): Float32Array {
  return wasmModule!.decode_trajectory_frame0(bytes, kind, nAtoms);
}

/** Decode a single frame's positions (Å) from a persistent decoder. */
export function decodeFrameCore(decoder: WasmFrameDecoder, frame: number): Float32Array {
  return decoder.decode_frame(frame);
}

/**
 * Decode a single frame's embedded vector channels (LAMMPS velocity/force),
 * concatenated in channel order. Empty for decoders without vector channels.
 */
export function decodeFrameVectorsCore(decoder: WasmFrameDecoder, frame: number): Float32Array {
  if ("decode_frame_vectors" in decoder) {
    return (decoder as WasmLammpstrjDecoder).decode_frame_vectors(frame);
  }
  return new Float32Array(0);
}

/**
 * Collect the (deduplicated) backing ArrayBuffers of a parse result so the
 * worker can transfer them to the main thread with zero copy. Frames share one
 * buffer (the trajectory `frame_data`); vector-channel frames share another —
 * the `Set` collapses those duplicates so a buffer is never listed twice
 * (which would throw `DataCloneError`).
 */
export function collectResultBuffers(result: StructureParseResult | XTCParseResult): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view?: { buffer: ArrayBufferLike } | null) => {
    if (view) buffers.add(view.buffer as ArrayBuffer);
  };
  if ("snapshot" in result) {
    const s = result.snapshot;
    add(s.positions);
    add(s.elements);
    add(s.bonds);
    add(s.bondOrders);
    add(s.box);
    add(s.boxOrigin);
    add(s.atomChainIds);
    add(s.atomBFactors);
    add(s.caIndices);
    add(s.caChainIds);
    add(s.caResNums);
    add(s.caSsType);
  }
  for (const frame of result.frames) add(frame.positions);
  for (const channel of result.vectorChannels) {
    for (const vf of channel.frames) add(vf.vectors);
  }
  return [...buffers];
}

/** Infer bonds using VDW radii (threshold = vdw_sum * 0.6). Main-thread. */
export async function inferBondsVdw(
  positions: Float32Array,
  elements: Uint8Array,
  nAtoms: number,
): Promise<Uint32Array> {
  await ensureInit();
  return wasmModule!.infer_bonds_vdw(positions, elements, nAtoms);
}

/** Parse GROMACS .top file and extract bond pairs. Main-thread. */
export async function parseTopBonds(text: string, nAtoms: number): Promise<Uint32Array> {
  await ensureInit();
  return wasmModule!.parse_top_bonds(text, nAtoms);
}

/**
 * Parse a GROMACS `.top` text with `#include` resolution. Main-thread.
 *
 * `includeFiles` maps include path → file content for all `.itp` files that
 * the topology references. Missing keys are silently skipped. Throws if a
 * circular include is detected.
 */
export async function parseTopBondsWithIncludes(
  text: string,
  includeFiles: Record<string, string>,
  nAtoms: number,
): Promise<Uint32Array> {
  await ensureInit();
  return wasmModule!.parse_top_bonds_with_includes(text, includeFiles, nAtoms);
}

/** Parse CHARMM/NAMD PSF topology file and extract bond pairs. Main-thread. */
export async function parsePsfBonds(text: string, nAtoms: number): Promise<Uint32Array> {
  await ensureInit();
  return wasmModule!.parse_psf_bonds(text, nAtoms);
}

/** Extract only CONECT bonds from a PDB file. Main-thread. */
export async function parsePdbBonds(text: string, nAtoms: number): Promise<Uint32Array> {
  await ensureInit();
  return wasmModule!.parse_pdb_bonds(text, nAtoms);
}

/** Extract atom labels from a file (structure format or plain text). Main-thread. */
export async function extractLabelsFromFile(file: File, nAtoms: number): Promise<string[]> {
  const text = await file.text();
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";

  let labels: string[];
  if (ext === ".txt") {
    labels = text.split("\n").map((l) => l.trim());
  } else {
    await ensureInit();
    const format =
      ext === ".gro"
        ? "gro"
        : ext === ".xyz"
          ? "xyz"
          : ext === ".data" || ext === ".lammps"
            ? "lammps_data"
            : "pdb";
    const raw = wasmModule!.extract_labels(text, format);
    labels = raw ? raw.split("\n") : [];
  }

  // Pad or trim to match nAtoms
  if (labels.length > nAtoms) {
    labels = labels.slice(0, nAtoms);
  }
  while (labels.length < nAtoms) {
    labels.push("");
  }
  return labels;
}
