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
  StructureIndexResult,
} from "./parseCore";

/** Request: parse a structure file's already-read contents. */
export interface StructureParseRequest {
  id: number;
  op: "structure";
  wasmUrl: string | undefined;
  ext: string;
  text?: string;
  bytes?: ArrayBuffer;
}

/** Request: parse a trajectory file's already-read contents. */
export interface TrajectoryParseRequest {
  id: number;
  op: "trajectory";
  wasmUrl: string | undefined;
  kind: TrajectoryKind;
  text?: string;
  bytes?: ArrayBuffer;
  expectedNAtoms: number;
}

/** Request: build a lazy trajectory decoder (scans the index, holds bytes in the worker). */
export interface IndexTrajectoryRequest {
  id: number;
  op: "indexTrajectory";
  wasmUrl: string | undefined;
  kind: LazyTrajectoryKind;
  trajectoryId: number;
  bytes: ArrayBuffer;
  expectedNAtoms: number;
}

/**
 * Request: build a lazy structure-frame decoder (scans extra frames, holds bytes
 * in the worker) AND parse frame 0 in the same round-trip — one file read yields
 * both the index and the eager snapshot.
 */
export interface IndexStructureRequest {
  id: number;
  op: "indexStructure";
  wasmUrl: string | undefined;
  kind: LazyStructureKind;
  /** Reuses the trajectory decoder map, so `decodeFrame` / `disposeTrajectory` apply. */
  trajectoryId: number;
  bytes: ArrayBuffer;
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
  wasmUrl: string | undefined;
  kind: LazyStructureKind;
  text: string;
  isWholeFile: boolean;
}

/** Request: decode frame 0 from a bounded prefix of a large trajectory (instant first paint). */
export interface TrajectoryFrame0Request {
  id: number;
  op: "trajectoryFrame0";
  wasmUrl: string | undefined;
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
  | DecodeFrameRequest
  | DisposeTrajectoryRequest;

/** Response payload for a `decodeFrame` request: one frame's positions (+ vectors). */
export interface DecodeFrameResult {
  frame: number;
  positions: Float32Array;
  /** Embedded vector channels for this frame, concatenated (empty if none). */
  vectors: Float32Array;
  /** Number of vector channels packed into `vectors`. */
  vectorChannelCount: number;
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
    | "decodeFrame"
    | "disposeTrajectory";
  result?:
    | StructureParseResult
    | XTCParseResult
    | TrajectoryIndexResult
    | IndexStructureResult
    | TrajectoryFrame0Result
    | DecodeFrameResult;
  error?: string;
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
}

/** Handle returned by `indexStructureLazy`, consumed by `LazyFrameProvider`. */
export interface StructureLazyHandle {
  trajectoryId: number;
  kind: LazyStructureKind;
  index: StructureIndexResult;
}

/** `indexStructureLazy` result: the streaming handle plus frame 0's snapshot. */
export interface StructureLazyResult {
  handle: StructureLazyHandle;
  frame0: StructureParseResult;
}
