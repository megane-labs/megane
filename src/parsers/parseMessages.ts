/**
 * Message protocol shared between `parseClient.ts` (main thread) and
 * `parse.worker.ts` (Web Worker).
 */

import type {
  StructureParseResult,
  XTCParseResult,
  TrajectoryKind,
  TrajectoryIndexResult,
  LazyTrajectoryKind,
  LazyStructureKind,
  FileStructureKind,
  StructureIndexResult,
} from "./parseCore";

/**
 * The WASM module a request initialises the worker with: the `.wasm` URL, the
 * module the page compiled when the worker cannot fetch that URL itself (see
 * `parseClient.ts`), or undefined for the worker's default.
 */
export type WasmSource = string | WebAssembly.Module | undefined;

/** Request: parse a structure file's already-read contents. */
export interface StructureParseRequest {
  id: number;
  op: "structure";
  wasm: WasmSource;
  ext: string;
  text?: string;
  bytes?: ArrayBuffer;
  /** The file itself, for the worker to read (a page-held copy goes as `bytes`). */
  file?: Blob;
}

/** Request: parse a trajectory file's already-read contents. */
export interface TrajectoryParseRequest {
  id: number;
  op: "trajectory";
  wasm: WasmSource;
  kind: TrajectoryKind;
  text?: string;
  bytes?: ArrayBuffer;
  expectedNAtoms: number;
}

/** Request: build a lazy trajectory decoder (scans the index, holds bytes in the worker). */
export interface IndexTrajectoryRequest {
  id: number;
  op: "indexTrajectory";
  wasm: WasmSource;
  kind: LazyTrajectoryKind;
  trajectoryId: number;
  bytes: ArrayBuffer;
  expectedNAtoms: number;
}

/**
 * Request: build a lazy XTC / LAMMPS dump decoder from the File itself — the
 * worker scans the frame index from windows of it and reads each frame when it
 * is decoded, so it never holds the whole file (see `indexXtcFileCore`,
 * `indexDumpFileCore`).
 */
export interface IndexTrajectoryFileRequest {
  id: number;
  op: "indexTrajectoryFile";
  wasm: WasmSource;
  /** XTC unless given. */
  kind?: LazyTrajectoryKind;
  trajectoryId: number;
  file: Blob;
  expectedNAtoms: number;
}

/**
 * Request: build a lazy structure-frame decoder (scans extra frames) AND parse
 * frame 0 in the same round-trip. Given the File, the worker reads it in
 * windows and per frame (`indexStructureFileCore`, `indexTrajFileCore`); given
 * bytes, it holds them (XYZ / PDB only: an ASE .traj needs its File).
 */
export interface IndexStructureRequest {
  id: number;
  op: "indexStructure";
  wasm: WasmSource;
  kind: FileStructureKind;
  /** Reuses the trajectory decoder map, so `decodeFrame` / `disposeTrajectory` apply. */
  trajectoryId: number;
  /** The file's bytes, held in the worker for its decoder's lifetime… */
  bytes?: ArrayBuffer;
  /** …or the file itself, indexed from windows and read per frame. */
  file?: Blob;
}

/** Response for `indexStructure`: the extra-frame index plus frame 0's snapshot. */
export interface IndexStructureResult {
  index: StructureIndexResult;
  frame0: StructureParseResult;
}

/**
 * Request: parse ONLY frame 0 from a bounded prefix of a large multi-frame
 * structure file (for instant first paint). Fails if frame 0 is not fully
 * contained (the caller grows the prefix / falls back).
 */
export interface StructurePrefixRequest {
  id: number;
  op: "structurePrefix";
  wasm: WasmSource;
  kind: LazyStructureKind;
  text: string;
  isWholeFile: boolean;
}

/**
 * Request: parse ONLY frame 0 of an ASE `.traj` from the file's head and tail
 * bytes (`totalSize` long in all), before the rest of the file has arrived.
 */
export interface TrajFrame0Request {
  id: number;
  op: "trajFrame0";
  wasm: WasmSource;
  head: ArrayBuffer;
  tail: ArrayBuffer;
  totalSize: number;
}

/** Request: decode frame 0 from a bounded prefix of a large trajectory (instant first paint). */
export interface TrajectoryFrame0Request {
  id: number;
  op: "trajectoryFrame0";
  wasm: WasmSource;
  kind: LazyTrajectoryKind;
  bytes: ArrayBuffer;
  expectedNAtoms: number;
}

/** Response for `trajectoryFrame0`: frame 0's positions. */
export interface TrajectoryFrame0Result {
  positions: Float32Array;
}

/** Request: decode a single frame from a previously-indexed trajectory. */
export interface DecodeFrameRequest {
  id: number;
  op: "decodeFrame";
  trajectoryId: number;
  frame: number;
}

/**
 * Request: start the worker's WASM module and do nothing else, so a host that
 * is still waiting for a file's bytes has the module compiled by the time they
 * arrive (see `prewarmParseWorker`).
 */
export interface InitRequest {
  id: number;
  op: "init";
  wasm: WasmSource;
}

/** Request: free a lazy XTC decoder and its retained bytes. */
export interface DisposeTrajectoryRequest {
  id: number;
  op: "disposeTrajectory";
  trajectoryId: number;
}

export type ParseRequest =
  | StructureParseRequest
  | TrajectoryParseRequest
  | StructurePrefixRequest
  | TrajectoryFrame0Request
  | IndexStructureRequest
  | IndexTrajectoryRequest
  | IndexTrajectoryFileRequest
  | DecodeFrameRequest
  | DisposeTrajectoryRequest
  | InitRequest
  | TrajFrame0Request;

/** Response payload for a `decodeFrame` request: one frame's positions (+ vectors). */
export interface DecodeFrameResult {
  frame: number;
  positions: Float32Array;
  /** Embedded vector channels for this frame, concatenated (empty if none). */
  vectors: Float32Array;
  /** Number of vector channels packed into `vectors`. */
  vectorChannelCount: number;
  /** This frame's cell, when the trajectory carries one per frame. */
  box?: Float32Array;
}

export interface ParseResponse {
  id: number;
  ok: boolean;
  op:
    | "structure"
    | "trajectory"
    | "structurePrefix"
    | "trajectoryFrame0"
    | "indexStructure"
    | "indexTrajectory"
    | "indexTrajectoryFile"
    | "decodeFrame"
    | "disposeTrajectory"
    | "init"
    | "trajFrame0";
  result?:
    | StructureParseResult
    | XTCParseResult
    | TrajectoryIndexResult
    | IndexStructureResult
    | TrajectoryFrame0Result
    | DecodeFrameResult;
  error?: string;
  /**
   * Set with `ok: false` when the failure leaves the worker unusable — its
   * WASM module would not start, or trapped mid-call — rather than the
   * request's input being rejected (a malformed file).
   */
  fatal?: boolean;
  /** The worker's WASM heap size after handling the request (see `wasmHeapBytes`). */
  wasmBytes?: number;
}

// ── Lazy decode handles ──────────────────────────────────────────────────
// Returned by `parseClient`'s lazy entry points; `parseClientSync` (swapped in
// at build time on hosts without the worker) re-exports the same types so the
// module shape does not change with the swap.

/** Handle returned by `indexTrajectoryLazy`, consumed by `LazyFrameProvider`. */
export interface TrajectoryLazyHandle {
  trajectoryId: number;
  kind: LazyTrajectoryKind;
  index: TrajectoryIndexResult;
}

/** One lazily-decoded frame: positions plus any embedded vector channels. */
export interface DecodedLazyFrame {
  positions: Float32Array;
  /** Concatenated per-atom vector channels for this frame (empty if none). */
  vectors: Float32Array;
  vectorChannelCount: number;
  /** This frame's cell, when the trajectory carries one per frame. */
  box?: Float32Array;
}

/** Handle returned by `indexStructureLazy`, consumed by `LazyFrameProvider`. */
export interface StructureLazyHandle {
  trajectoryId: number;
  kind: FileStructureKind;
  index: StructureIndexResult;
}

/** `indexStructureLazy` result: the streaming handle plus frame 0's snapshot. */
export interface StructureLazyResult {
  handle: StructureLazyHandle;
  frame0: StructureParseResult;
}
