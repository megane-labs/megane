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
import { labelsFromText } from "./labels";
import { perfMark, perfMeasure } from "../perf";
import type { TrajectoryKind } from "./fileNames";

export interface StructureParseResult {
  snapshot: Snapshot;
  frames: Frame[];
  meta: TrajectoryMeta | null;
  labels: string[] | null;
  /** `labels` joined by newlines, set instead of it while crossing from the
   *  parse worker (see `./labels`). */
  labelsText?: string;
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
export type { TrajectoryKind };

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
  ca_res_nums(): Int32Array;
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
  /** Frame 0's box. */
  box_matrix(): Float32Array;
  box_origin(): Float32Array;
  /** True when the box changes between frames (an NPT run). */
  readonly varying_cells: boolean;
  /** Frame `frame`'s box; empty unless the box changes between frames. */
  frame_cell(frame: number): Float32Array;
}

/** The per-frame cell surface shared by the WASM trajectory decoders and indexers. */
interface WasmFrameCells {
  readonly varying_cells: boolean;
  frame_cell(frame: number): Float32Array;
}

/** Windowed XTC frame indexer (see `XtcIndexer` in megane-wasm). */
interface WasmXtcIndexer {
  /** File offset the next window must start at. */
  readonly next_offset: number;
  scan(window: Uint8Array, atEof: boolean): number;
  finish(fileLen: number): void;
  readonly n_atoms: number;
  readonly n_frames: number;
  readonly timestep_ps: number;
  readonly has_box: boolean;
  /** Frame 0's box. */
  box_matrix(): Float32Array;
  /** True when the box changes between frames (an NPT run). */
  readonly varying_cells: boolean;
  /** Frame `frame`'s box; empty unless the box changes between frames. */
  frame_cell(frame: number): Float32Array;
  offsets(): Float64Array;
  times(): Float32Array;
  free(): void;
}

/** Windowed text frame indexer (see `TextFrameIndexer` in megane-wasm). */
interface WasmTextFrameIndexer {
  readonly next_offset: number;
  scan(window: Uint8Array, atEof: boolean): number;
  finish(fileLen: number): void;
  readonly n_atoms: number;
  readonly n_frames: number;
  readonly heterogeneous: boolean;
  offsets(): Float64Array;
  frames_end(fileLen: number): number;
  readonly frame0_end: number;
  readonly tail_start: number;
  readonly frame0_needs_whole_file: boolean;
  readonly timestep_ps: number;
  readonly has_box: boolean;
  box_matrix(): Float32Array;
  box_origin(): Float32Array;
  /** Dump only: true when the box changes between frames (an NPT run). */
  readonly varying_cells: boolean;
  /** Dump only: frame `frame`'s box; empty unless the box changes between frames. */
  frame_cell(frame: number): Float32Array;
  readonly vector_channel_names: string;
  free(): void;
}

/** One frame from `decode_text_frame`. */
interface WasmDecodedTextFrame {
  positions(): Float32Array;
  vectors(): Float32Array;
  free(): void;
}

/** Fixed-layout binary trajectory (see `BinaryFrameLayout` in megane-wasm). */
interface WasmBinaryFrameLayout {
  readonly n_atoms: number;
  readonly n_frames: number;
  /** NaN when the time step comes from the frames' own time (NetCDF). */
  readonly timestep_ps: number;
  readonly has_cell: boolean;
  frame_start(frame: number): number;
  readonly frame_len: number;
  decode(bytes: Uint8Array, frame: number): WasmDecodedBinaryFrame;
  free(): void;
}

/** One frame from `BinaryFrameLayout.decode`. */
interface WasmDecodedBinaryFrame {
  positions(): Float32Array;
  /** Empty without a cell. */
  cell(): Float32Array;
  /** NaN without a time. */
  readonly time: number;
  free(): void;
}

/** Binary trajectory formats whose frames sit at offsets their header gives. */
export type BinaryFrameKind = "dcd" | "netcdf";

/**
 * The index of an ASE `.traj` built from its File one frame at a time
 * (`TrajFileIndexer`): see {@link indexTrajFileCore}. Offsets are file bytes.
 */
interface WasmTrajFileIndexer {
  readonly table_start: number;
  readonly table_end: number;
  set_table(table: Uint8Array): void;
  /** Frames in the file, frame 0 included. */
  readonly n_items: number;
  json_offset(item: number): number;
  json_len(bytes: Uint8Array): number;
  readonly next_start: number;
  add_frame(bytes: Uint8Array): void;
  frame0(): WasmParseResult;
  readonly n_atoms: number;
  /** Frames after frame 0. */
  readonly n_frames: number;
  readonly heterogeneous: boolean;
  readonly varying_cells: boolean;
  /** Empty unless the cell varies. */
  frame_cell(frame: number): Float32Array;
  frame_start(frame: number): number;
  frame_end(frame: number): number;
  decode(frame: number, bytes: Uint8Array): Float32Array;
  free(): void;
}

/** First bytes read for a `.traj`: its 48-byte header. */
export const TRAJ_HEADER_BYTES = 48;

/**
 * First bytes read for a binary trajectory's header; a header longer than
 * that (a long DCD title, many NetCDF attributes) is read again 4× longer.
 */
export const BINARY_HEAD_MIN = 64 * 1024;

/** Multi-frame text formats indexed from windows of their File. */
export type TextFrameKind = "xyz" | "pdb" | "lammpstrj";

/**
 * Window the text frame index scan reads at a time. Every line is looked at,
 * so the window only bounds the worker's memory (each one is copied into
 * WASM memory, which never shrinks) and the number of reads; a line longer
 * than it doubles it for that read.
 */
export const TEXT_INDEX_WINDOW = 4 * 1024 * 1024;
const TEXT_INDEX_WINDOW_MAX = 256 * 1024 * 1024;

/**
 * A lazy decoder that leaves the file where it is — on disk for a file the
 * user picked — and reads each frame's bytes when that frame is asked for, so
 * the worker's memory does not grow with the trajectory (a `WasmXtcDecoder`
 * copies the whole file into WASM memory, which never shrinks again).
 */
export interface FileFrameDecoder {
  readonly n_atoms: number;
  /**
   * Positions (Å), any embedded vector channels (a LAMMPS dump's) and, for a
   * trajectory whose frames each carry a cell (DCD, NetCDF, an NPT `.traj`),
   * this frame's.
   */
  decodeFrame(frame: number): Promise<DecodedFileFrame>;
  free(): void;
}

/** One frame from a {@link FileFrameDecoder}. */
export interface DecodedFileFrame {
  positions: Float32Array;
  vectors: Float32Array;
  box?: Float32Array;
}

/** A worker-held lazy decoder: the file in WASM memory, or read from the file per frame. */
export type LazyFrameDecoder = WasmFrameDecoder | FileFrameDecoder;

/** Reads `blob[start, end)`; the default goes through the Blob API. */
export type BlobRangeReader = (blob: Blob, start: number, end: number) => Promise<ArrayBuffer>;

const readBlobRange: BlobRangeReader = (blob, start, end) => blob.slice(start, end).arrayBuffer();

/**
 * First window the XTC index scan reads. It needs ~92 bytes of each frame, so a
 * window over large frames holds one header and the scan jumps to the next;
 * while windows keep holding several (small) frames it doubles, up to
 * {@link XTC_INDEX_WINDOW_MAX}, so the scan is not one read per frame.
 */
export const XTC_INDEX_WINDOW_MIN = 64 * 1024;
export const XTC_INDEX_WINDOW_MAX = 4 * 1024 * 1024;

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
export type LazyTrajectoryKind = "xtc" | "lammpstrj" | "dcd" | "netcdf";

/** Multi-frame structure formats with lazy extra-frame decode (frame 0 is eager). */
export type LazyStructureKind = "xyz" | "pdb";

/** Multi-frame structure formats the worker streams from their File: the text ones and ASE `.traj`. */
export type FileStructureKind = LazyStructureKind | "traj";

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
  /** Frame 0's box. */
  box: Float32Array | null;
  /** Box origin (length 3); null ⇒ (0,0,0). Set only for LAMMPS dumps. */
  boxOrigin: Float32Array | null;
  /**
   * True when every decoded frame carries its own cell (`box`): an XTC / dump
   * whose box changes between frames (as the eager parse's frames carry one
   * then), or a DCD / NetCDF that stores a cell per frame.
   */
  frameCells: boolean;
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
  parse_structure_bytes: (ext: string, data: Uint8Array) => WasmParseResult;
  parse_traj_frame0: (head: Uint8Array, tail: Uint8Array, totalLen: number) => WasmParseResult;
  decode_trajectory_frame0: (data: Uint8Array, kind: string, nAtoms: number) => Float32Array;
  XtcDecoder: new (data: Uint8Array) => WasmXtcDecoder;
  XtcIndexer: new () => WasmXtcIndexer;
  TextFrameIndexer: new (kind: TextFrameKind) => WasmTextFrameIndexer;
  decode_text_frame: (
    kind: TextFrameKind,
    data: Uint8Array,
    nAtoms: number,
  ) => WasmDecodedTextFrame;
  BinaryFrameLayout: new (
    kind: BinaryFrameKind,
    head: Uint8Array,
    fileLen: number,
  ) => WasmBinaryFrameLayout;
  netcdf_timestep: (nFrames: number, t0: number, t1: number) => number;
  TrajFileIndexer: new (head: Uint8Array, fileLen: number) => WasmTrajFileIndexer;
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
  write_structure: (
    format: string,
    positions: Float32Array,
    elements: Uint8Array,
    bonds: Uint32Array,
    bond_orders: Uint8Array,
    box_matrix: Float32Array,
    box_origin: Float32Array,
    atom_labels: string,
    chain_ids: Uint8Array,
  ) => string;
}

let wasmMemory: WebAssembly.Memory | null = null;

/**
 * Bytes of WASM linear memory this realm's module holds (0 before
 * `ensureInit`). Linear memory only grows, so this is the high-water mark of
 * every parse the module has run.
 */
export function wasmHeapBytes(): number {
  return wasmMemory?.buffer.byteLength ?? 0;
}

/**
 * Initialise the WASM module (memoized). `wasmUrl` is resolved on the main
 * thread and passed explicitly so this works inside a Web Worker, whose global
 * scope cannot see `globalThis.__MEGANE_WASM_URL__`; it may also be a module the
 * main thread already compiled. When omitted it falls back to that global (the
 * main-thread default).
 */
export async function ensureInit(wasmUrl?: string | WebAssembly.Module): Promise<void> {
  if (wasmModule) return;
  if (!initPromise) {
    initPromise = (async () => {
      perfMark("megane:wasm:start");
      const wasm = await import("../../crates/megane-wasm/pkg");
      const url =
        wasmUrl ??
        ((globalThis as Record<string, unknown>).__MEGANE_WASM_URL__ as string | undefined);
      // wasm-bindgen's init takes an options object; a bare URL still works
      // but logs a deprecation warning (on every page load, from the worker).
      const exports = await wasm.default({ module_or_path: url });
      wasmMemory = exports?.memory ?? null;
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
        parse_structure_bytes: wasm.parse_structure_bytes,
        parse_traj_frame0: wasm.parse_traj_frame0,
        decode_trajectory_frame0: wasm.decode_trajectory_frame0,
        XtcDecoder: wasm.XtcDecoder,
        XtcIndexer: wasm.XtcIndexer,
        TextFrameIndexer: wasm.TextFrameIndexer,
        decode_text_frame: wasm.decode_text_frame,
        BinaryFrameLayout: wasm.BinaryFrameLayout,
        netcdf_timestep: wasm.netcdf_timestep,
        TrajFileIndexer: wasm.TrajFileIndexer,
        LammpstrjDecoder: wasm.LammpstrjDecoder,
        StructureFrameDecoder: wasm.StructureFrameDecoder,
        infer_bonds_vdw: wasm.infer_bonds_vdw,
        parse_top_bonds: wasm.parse_top_bonds,
        parse_top_bonds_with_includes: wasm.parse_top_bonds_with_includes,
        parse_psf_bonds: wasm.parse_psf_bonds,
        parse_pdb_bonds: wasm.parse_pdb_bonds,
        extract_labels: wasm.extract_labels,
        write_structure: wasm.write_structure,
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
    // atom label) -- so `.jxyz` is an alias, not a second parser. `.extxyz`
    // (ASE / extended XYZ) is the same grammar too: `Lattice=` and
    // `Properties=` headers are already read by the XYZ parser. The labels
    // stay adjacent because `no-fallthrough` counts a comment-only case body
    // as a fallthrough.
    case ".xyz":
    case ".jxyz":
    case ".extxyz":
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

  const labels: string[] | null = result.has_atom_labels
    ? labelsFromText(result.atom_labels)
    : null;

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
  if (input.bytes && input.text === undefined) {
    // Raw bytes of a text format: decoded inside WASM, never as a JS string.
    const result = wasmModule!.parse_structure_bytes(input.ext, input.bytes);
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
 * Frame `frame`'s own cell from a WASM decoder / indexer whose box changes
 * between frames, else `undefined` (the frame keeps the base cell) — the
 * per-frame `box` the eager parse attaches to the same frame.
 */
function frameCellOf(cells: WasmFrameCells, frame: number): Float32Array | undefined {
  if (!cells.varying_cells) return undefined;
  const cell = cells.frame_cell(frame);
  return cell.length === 9 ? cell : undefined;
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
    frameCells: decoder.varying_cells,
  };
  return { decoder, index };
}

/**
 * Build a lazy XTC decoder that reads the file instead of holding it: the
 * frame index comes from windows of the file (see {@link XTC_INDEX_WINDOW_MIN})
 * and each frame is decoded from its own bytes, `offsets[i]` up to the next
 * frame. Same index and frames as {@link indexTrajectoryCore} for `"xtc"`.
 * Requires `ensureInit` first.
 */
export async function indexXtcFileCore(
  file: Blob,
  expectedNAtoms: number,
  read: BlobRangeReader = readBlobRange,
): Promise<{ decoder: FileFrameDecoder; index: TrajectoryIndexResult }> {
  const wasm = wasmModule!;
  const indexer = new wasm.XtcIndexer();
  try {
    let window = XTC_INDEX_WINDOW_MIN;
    while (indexer.next_offset < file.size) {
      const start = indexer.next_offset;
      const end = Math.min(start + window, file.size);
      const atEof = end === file.size;
      const found = indexer.scan(new Uint8Array(await read(file, start, end)), atEof);
      if (atEof) break;
      // A window holds at least one frame's header, so the scan always moves on.
      if (indexer.next_offset <= start) throw new Error("XTC index scan made no progress");
      if (found > 1) window = Math.min(window * 2, XTC_INDEX_WINDOW_MAX);
    }
    indexer.finish(file.size);
    const nAtoms = indexer.n_atoms;
    if (nAtoms !== expectedNAtoms) {
      throw new Error(`XTC atom count (${nAtoms}) does not match structure (${expectedNAtoms})`);
    }
    const offsets = indexer.offsets();
    const nFrames = indexer.n_frames;
    const index: TrajectoryIndexResult = {
      nAtoms,
      nFrames,
      timestepPs: indexer.timestep_ps,
      hasBox: indexer.has_box,
      box: indexer.has_box ? indexer.box_matrix() : null,
      boxOrigin: null,
      times: indexer.times(),
      vectorChannelNames: [],
      heterogeneous: false,
      frameCells: indexer.varying_cells,
    };
    // Each frame's own box when the box changes (read before the indexer is freed).
    const cells = index.frameCells
      ? Array.from({ length: nFrames }, (_, f) => frameCellOf(indexer, f))
      : [];
    const decoder: FileFrameDecoder = {
      n_atoms: nAtoms,
      async decodeFrame(frame) {
        if (!(frame >= 0 && frame < nFrames)) throw new Error("frame index out of range");
        const end = frame + 1 < nFrames ? offsets[frame + 1] : file.size;
        const bytes = new Uint8Array(await read(file, offsets[frame], end));
        const out: DecodedFileFrame = {
          positions: wasm.decode_trajectory_frame0(bytes, "xtc", nAtoms),
          vectors: new Float32Array(0),
        };
        const box = cells[frame];
        if (box) out.box = box.slice();
        return out;
      },
      free() {
        /* nothing held outside the file itself */
      },
    };
    return { decoder, index };
  } finally {
    indexer.free();
  }
}

/** Decode one frame's positions (Å) and embedded vectors from a worker-held lazy decoder. */
export async function decodeLazyFrameCore(
  decoder: LazyFrameDecoder,
  frame: number,
): Promise<DecodedFileFrame> {
  if ("decodeFrame" in decoder) return decoder.decodeFrame(frame);
  const out: DecodedFileFrame = {
    positions: decodeFrameCore(decoder, frame),
    vectors: decodeFrameVectorsCore(decoder, frame),
  };
  // An XTC / dump decoder whose box changes between frames gives each its own.
  if ("varying_cells" in decoder) {
    const box = frameCellOf(decoder as WasmTrajectoryDecoder, frame);
    if (box) out.box = box;
  }
  return out;
}

/**
 * Index a multi-frame text file from windows of it (see
 * {@link TEXT_INDEX_WINDOW}), never holding it whole. Requires `ensureInit`.
 */
async function scanTextFile(
  file: Blob,
  kind: TextFrameKind,
  read: BlobRangeReader,
  firstWindow: number,
): Promise<WasmTextFrameIndexer> {
  const indexer = new wasmModule!.TextFrameIndexer(kind);
  try {
    let window = firstWindow;
    while (indexer.next_offset < file.size) {
      const start = indexer.next_offset;
      const end = Math.min(start + window, file.size);
      const used = indexer.scan(new Uint8Array(await read(file, start, end)), end === file.size);
      if (used > 0) {
        window = firstWindow;
        continue;
      }
      // Not one whole line in the window: read a larger one.
      if (window >= TEXT_INDEX_WINDOW_MAX) throw new Error("line too long to index");
      window *= 2;
    }
    indexer.finish(file.size);
    return indexer;
  } catch (err) {
    indexer.free();
    throw err;
  }
}

/**
 * How much of a file a frame read brings in at once. Frames are mostly shown
 * in order, and a read through the Blob API costs a round trip to the
 * browser, so a frame smaller than this is read together with the frames
 * after it, and those are then served from the bytes already read.
 */
export const FRAME_READ_AHEAD = 4 * 1024 * 1024;

/** One read-ahead span of a file and the read bringing it in. */
interface ReadSpan {
  start: number;
  end: number;
  bytes: Promise<Uint8Array>;
}

/**
 * A range reader over `file` that reads {@link FRAME_READ_AHEAD} at a time
 * and keeps the last two spans, so frames read in order (and the decodes a
 * playback prefetch fires at once) share one read. Holds at most two spans.
 */
export function readAheadReader(
  file: Blob,
  read: BlobRangeReader,
  span = FRAME_READ_AHEAD,
): (start: number, end: number) => Promise<Uint8Array> {
  let spans: ReadSpan[] = [];
  return async (start, end) => {
    const hit = spans.find((s) => start >= s.start && end <= s.end);
    if (hit) return (await hit.bytes).subarray(start - hit.start, end - hit.start);
    if (end - start >= span) return new Uint8Array(await read(file, start, end));
    const spanEnd = Math.min(file.size, start + span);
    const next: ReadSpan = {
      start,
      end: spanEnd,
      bytes: read(file, start, spanEnd).then((b) => new Uint8Array(b)),
    };
    spans = [spans[spans.length - 1], next].filter((s): s is ReadSpan => s !== undefined);
    try {
      return (await next.bytes).subarray(0, end - start);
    } catch (err) {
      spans = spans.filter((s) => s !== next);
      throw err;
    }
  };
}

/** A decoder reading each indexed frame of a text file from its own bytes. */
function textFileDecoder(
  file: Blob,
  kind: TextFrameKind,
  indexer: WasmTextFrameIndexer,
  read: BlobRangeReader,
): FileFrameDecoder {
  const wasm = wasmModule!;
  const offsets = indexer.offsets();
  const nFrames = offsets.length;
  const nAtoms = indexer.n_atoms;
  const framesEnd = indexer.frames_end(file.size);
  // A dump whose box changes gives each frame its own (read before the indexer is freed).
  const cells = indexer.varying_cells
    ? Array.from({ length: nFrames }, (_, f) => frameCellOf(indexer, f))
    : [];
  const readFrame = readAheadReader(file, read);
  return {
    n_atoms: nAtoms,
    async decodeFrame(frame) {
      if (!(frame >= 0 && frame < nFrames)) throw new Error("frame index out of range");
      const end = frame + 1 < nFrames ? offsets[frame + 1] : framesEnd;
      const decoded = wasm.decode_text_frame(kind, await readFrame(offsets[frame], end), nAtoms);
      try {
        const out: DecodedFileFrame = {
          positions: decoded.positions(),
          vectors: decoded.vectors(),
        };
        const box = cells[frame];
        if (box) out.box = box.slice();
        return out;
      } finally {
        decoded.free();
      }
    },
    free() {
      /* nothing held outside the file itself */
    },
  };
}

/**
 * {@link indexStructureCore} for a multi-frame XYZ / PDB that stays in its
 * File: the extra-frame index comes from windows of the file, frame 0 from
 * just the bytes that hold it (a PDB's model 0 plus the records after the
 * last model), and each extra frame is read when it is decoded — the worker
 * never holds the file. A PDB whose model 0 needs records from between later
 * models is indexed from the whole file instead. Requires `ensureInit` first.
 */
export async function indexStructureFileCore(
  file: Blob,
  kind: LazyStructureKind,
  read: BlobRangeReader = readBlobRange,
  window = TEXT_INDEX_WINDOW,
): Promise<{
  decoder: LazyFrameDecoder;
  index: StructureIndexResult;
  frame0: StructureParseResult;
}> {
  const indexer = await scanTextFile(file, kind, read, window);
  try {
    if (indexer.frame0_needs_whole_file) {
      return indexStructureCore(new Uint8Array(await read(file, 0, file.size)), kind);
    }
    const index: StructureIndexResult = {
      nAtoms: indexer.n_atoms,
      nFrames: indexer.n_frames,
      heterogeneous: indexer.heterogeneous,
    };
    const decoder = textFileDecoder(file, kind, indexer, read);
    const decode = (buf: ArrayBuffer): string => new TextDecoder().decode(buf);
    let text = decode(await read(file, 0, indexer.frame0_end));
    // A PDB's records after its last model (CONECT, …) belong to model 0 too.
    if (kind === "pdb" && indexer.tail_start < file.size) {
      text += decode(await read(file, indexer.tail_start, file.size));
    }
    const frame0 = parseStructurePrefixCore(text, kind, true);
    return { decoder, index, frame0 };
  } finally {
    indexer.free();
  }
}

/**
 * {@link indexStructureFileCore} for an ASE `.traj` (ULM): the header and the
 * offset table come first, then every frame's bytes in order — read ahead
 * {@link FRAME_READ_AHEAD} at a time, so the scan reads the file once without
 * holding it — and each extra frame is read again when it is decoded. A cell
 * that changes between frames (an NPT run) rides on each decoded frame. A file
 * whose frames change their atoms makes the index `heterogeneous` (the caller
 * then parses it whole); one the index cannot read frame by frame throws.
 * Requires `ensureInit` first.
 */
export async function indexTrajFileCore(
  file: Blob,
  read: BlobRangeReader = readBlobRange,
): Promise<{
  decoder: LazyFrameDecoder;
  index: StructureIndexResult;
  frame0: StructureParseResult;
}> {
  const head = new Uint8Array(await read(file, 0, Math.min(file.size, TRAJ_HEADER_BYTES)));
  const indexer = new wasmModule!.TrajFileIndexer(head, file.size);
  try {
    indexer.set_table(new Uint8Array(await read(file, indexer.table_start, indexer.table_end)));
    const readSpan = readAheadReader(file, read);
    const nItems = indexer.n_items;
    for (let item = 0; item < nItems; item++) {
      const start = indexer.next_start;
      const at = indexer.json_offset(item);
      // The 8 bytes at the frame's JSON give its length. A small frame's are
      // read with its arrays (one read-ahead span); a large frame's on their
      // own, so the arrays are not read twice.
      const lenBytes =
        at + 8 - start < FRAME_READ_AHEAD
          ? (await readSpan(start, at + 8)).subarray(at - start)
          : new Uint8Array(await read(file, at, at + 8));
      indexer.add_frame(await readSpan(start, at + 8 + indexer.json_len(lenBytes)));
    }
    const frame0 = parseWithFn(() => indexer.frame0(), "");
    const nFrames = indexer.n_frames;
    const index: StructureIndexResult = {
      nAtoms: indexer.n_atoms,
      nFrames,
      heterogeneous: indexer.heterogeneous,
    };
    const varyingCells = indexer.varying_cells;
    const readFrame = readAheadReader(file, read);
    const decoder: FileFrameDecoder = {
      n_atoms: indexer.n_atoms,
      async decodeFrame(frame) {
        if (!(frame >= 0 && frame < nFrames)) throw new Error("frame index out of range");
        const bytes = await readFrame(indexer.frame_start(frame), indexer.frame_end(frame));
        const out: DecodedFileFrame = {
          positions: indexer.decode(frame, bytes),
          vectors: new Float32Array(0),
        };
        if (varyingCells) out.box = indexer.frame_cell(frame);
        return out;
      },
      free() {
        indexer.free();
      },
    };
    return { decoder, index, frame0 };
  } catch (err) {
    indexer.free();
    throw err;
  }
}

/**
 * {@link indexTrajectoryCore} for a LAMMPS dump that stays in its File: the
 * frame index comes from windows of it and each frame (with its vector
 * channels) is read when it is decoded. Requires `ensureInit` first.
 */
export async function indexDumpFileCore(
  file: Blob,
  expectedNAtoms: number,
  read: BlobRangeReader = readBlobRange,
  window = TEXT_INDEX_WINDOW,
): Promise<{ decoder: FileFrameDecoder; index: TrajectoryIndexResult }> {
  const indexer = await scanTextFile(file, "lammpstrj", read, window);
  try {
    if (indexer.n_atoms !== expectedNAtoms) {
      throw new Error(
        `LAMMPS dump atom count (${indexer.n_atoms}) does not match structure (${expectedNAtoms})`,
      );
    }
    const hasBox = indexer.has_box;
    const origin = indexer.box_origin();
    const index: TrajectoryIndexResult = {
      nAtoms: indexer.n_atoms,
      nFrames: indexer.n_frames,
      timestepPs: indexer.timestep_ps,
      hasBox,
      box: hasBox ? indexer.box_matrix() : null,
      boxOrigin: hasBox && origin.length === 3 ? origin : null,
      times: new Float32Array(0),
      vectorChannelNames: indexer.vector_channel_names.split("\n").filter((n) => n.length > 0),
      heterogeneous: indexer.heterogeneous,
      frameCells: indexer.varying_cells,
    };
    return { decoder: textFileDecoder(file, "lammpstrj", indexer, read), index };
  } finally {
    indexer.free();
  }
}

/**
 * Build a lazy decoder for a DCD or AMBER NetCDF trajectory that stays in its
 * File: every frame sits at an offset the header gives, so the index is read
 * from the first bytes alone and each frame from its own bytes. Frames carry
 * their own cell when the file has one per frame (an NPT run's changing box).
 * Requires `ensureInit` first.
 */
export async function indexBinaryTrajectoryFileCore(
  file: Blob,
  kind: BinaryFrameKind,
  expectedNAtoms: number,
  read: BlobRangeReader = readBlobRange,
): Promise<{ decoder: FileFrameDecoder; index: TrajectoryIndexResult }> {
  const wasm = wasmModule!;
  let layout: WasmBinaryFrameLayout | null = null;
  for (let head = BINARY_HEAD_MIN; layout === null; head *= 4) {
    const end = Math.min(head, file.size);
    try {
      layout = new wasm.BinaryFrameLayout(
        kind,
        new Uint8Array(await read(file, 0, end)),
        file.size,
      );
    } catch (err) {
      // Too short for the header: read more, unless this was the whole file.
      if (end === file.size) throw err;
    }
  }
  const owned = layout;
  try {
    const nAtoms = owned.n_atoms;
    const nFrames = owned.n_frames;
    if (nAtoms !== expectedNAtoms) {
      const label = kind === "dcd" ? "DCD" : "AMBER NetCDF";
      throw new Error(
        `${label} atom count (${nAtoms}) does not match structure (${expectedNAtoms})`,
      );
    }
    const readFrame = readAheadReader(file, read);
    const frameLen = owned.frame_len;
    const decodeAt = async (frame: number) => {
      const start = owned.frame_start(frame);
      const bytes = await readFrame(start, Math.min(file.size, start + frameLen));
      const decoded = owned.decode(bytes, frame);
      try {
        return { positions: decoded.positions(), cell: decoded.cell(), time: decoded.time };
      } finally {
        decoded.free();
      }
    };
    // Frame 0 checks the layout against a real frame and gives the base cell.
    const first = await decodeAt(0);
    let timestepPs = owned.timestep_ps;
    if (Number.isNaN(timestepPs)) {
      const t1 = nFrames > 1 ? (await decodeAt(1)).time : NaN;
      timestepPs = wasm.netcdf_timestep(nFrames, first.time, t1);
    }
    const hasBox = owned.has_cell && first.cell.length === 9;
    const index: TrajectoryIndexResult = {
      nAtoms,
      nFrames,
      timestepPs,
      hasBox,
      box: hasBox ? first.cell : null,
      boxOrigin: null,
      times: new Float32Array(0),
      vectorChannelNames: [],
      heterogeneous: false,
      frameCells: hasBox,
    };
    const decoder: FileFrameDecoder = {
      n_atoms: nAtoms,
      async decodeFrame(frame) {
        if (!(frame >= 0 && frame < nFrames)) throw new Error("frame index out of range");
        const { positions, cell } = await decodeAt(frame);
        const out: DecodedFileFrame = { positions, vectors: new Float32Array(0) };
        if (hasBox && cell.length === 9) out.box = cell;
        return out;
      },
      free() {
        owned.free();
      },
    };
    return { decoder, index };
  } catch (err) {
    owned.free();
    throw err;
  }
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
 * Parse ONLY frame 0 of an ASE `.traj` from the file's first bytes and last
 * bytes (`totalLen` long in all) — `parse_traj`'s frame-0 snapshot, before the
 * rest of the file is available. Throws when frame 0 or its offset-table entry
 * is not in those bytes. Requires `ensureInit` first.
 */
export function parseTrajFrame0Core(
  head: Uint8Array,
  tail: Uint8Array,
  totalLen: number,
): StructureParseResult {
  return parseWithFn(() => wasmModule!.parse_traj_frame0(head, tail, totalLen), "");
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
  for (const frame of result.frames) {
    add(frame.positions);
    add(frame.elements);
    add(frame.bonds);
    add(frame.box);
    add(frame.boxOrigin);
  }
  for (const channel of result.vectorChannels) {
    for (const vf of channel.frames) add(vf.vectors);
  }
  if ("scalarChannels" in result) {
    for (const channel of result.scalarChannels) {
      for (const sf of channel.frames) add(sf.values);
    }
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
        : ext === ".xyz" || ext === ".extxyz"
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

/**
 * Output formats the Rust structure writer supports. `cif` (P 1, fractional
 * coordinates) and `poscar` (VASP 5, Cartesian, atoms grouped by element)
 * need a unit cell: the writer rejects a structure without one.
 */
export type StructureWriteFormat = "xyz" | "pdb" | "mol" | "cif" | "poscar";

/**
 * Serialize a structure as XYZ / PDB / MOL / CIF / POSCAR text through the
 * Rust writer (`megane_core::writer`, the same code the Python
 * `write_structure` uses). Optional channels are passed as empty arrays /
 * strings when absent; `boxOrigin` is the cell corner CIF / POSCAR positions
 * are measured from. Main-thread.
 */
export async function writeStructure(
  format: StructureWriteFormat,
  positions: Float32Array,
  elements: Uint8Array,
  bonds: Uint32Array,
  opts: {
    bondOrders?: Uint8Array | null;
    box?: Float32Array | null;
    boxOrigin?: Float32Array | null;
    atomLabels?: string[] | null;
    chainIds?: Uint8Array | null;
  } = {},
): Promise<string> {
  await ensureInit();
  return wasmModule!.write_structure(
    format,
    positions,
    elements,
    bonds,
    opts.bondOrders ?? new Uint8Array(0),
    opts.box ?? new Float32Array(0),
    opts.boxOrigin ?? new Float32Array(0),
    opts.atomLabels && opts.atomLabels.length > 0 ? opts.atomLabels.join("\n") : "",
    opts.chainIds ?? new Uint8Array(0),
  );
}
