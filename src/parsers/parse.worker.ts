/**
 * Web Worker that runs WASM file parsing off the main thread.
 *
 * Thin wrapper: it initialises the WASM module (with the URL resolved on the
 * main thread), calls the shared `parseCore` functions, and posts the result
 * back — transferring the underlying ArrayBuffers so the big coordinate buffers
 * move to the main thread with zero copy. All parse logic lives in `parseCore`,
 * so worker output is byte-identical to the synchronous path.
 */

import {
  ensureInit,
  parseStructureCore,
  parseStructurePrefixCore,
  parseTrajFrame0Core,
  parseTrajectoryCore,
  collectResultBuffers,
  indexTrajectoryCore,
  indexXtcFileCore,
  indexStructureCore,
  decodeTrajectoryFrame0Core,
  decodeLazyFrameCore,
  type LazyFrameDecoder,
} from "./parseCore";
import type { ParseRequest, ParseResponse } from "./parseMessages";

interface WorkerSelf {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerSelf;

// Persistent lazy per-frame decoders (trajectory OR multi-frame structure),
// keyed by a client-allocated id. Each holds the whole file in WASM memory for
// its lifetime so frames can be decoded on demand — except an XTC indexed from
// its File (`indexTrajectoryFile`), which reads each frame from the file —
// and is freed on `disposeTrajectory`.
const decoders = new Map<number, LazyFrameDecoder>();

ctx.onmessage = async (e: MessageEvent<ParseRequest>) => {
  const req = e.data;
  try {
    if (req.op === "structure") {
      await ensureInit(req.wasm);
      const result = parseStructureCore({
        ext: req.ext,
        text: req.text,
        bytes: req.bytes ? new Uint8Array(req.bytes) : undefined,
      });
      const transfer = collectResultBuffers(result);
      ctx.postMessage(
        { id: req.id, ok: true, op: "structure", result } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "trajectory") {
      await ensureInit(req.wasm);
      const result = parseTrajectoryCore({
        kind: req.kind,
        text: req.text,
        bytes: req.bytes ? new Uint8Array(req.bytes) : undefined,
        expectedNAtoms: req.expectedNAtoms,
      });
      const transfer = collectResultBuffers(result);
      ctx.postMessage(
        { id: req.id, ok: true, op: "trajectory", result } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "structurePrefix") {
      await ensureInit(req.wasm);
      // Parse frame 0 from a bounded prefix; throws if frame 0 isn't fully in it.
      const result = parseStructurePrefixCore(req.text, req.kind, req.isWholeFile);
      const transfer = collectResultBuffers(result);
      ctx.postMessage(
        { id: req.id, ok: true, op: "structurePrefix", result } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "trajFrame0") {
      await ensureInit(req.wasm);
      // Frame 0 of a .traj from its head + tail; throws if they don't hold it.
      const result = parseTrajFrame0Core(
        new Uint8Array(req.head),
        new Uint8Array(req.tail),
        req.totalSize,
      );
      const transfer = collectResultBuffers(result);
      ctx.postMessage(
        { id: req.id, ok: true, op: "trajFrame0", result } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "trajectoryFrame0") {
      await ensureInit(req.wasm);
      // Decode frame 0 from a bounded prefix; throws if the prefix is too small.
      const positions = decodeTrajectoryFrame0Core(
        new Uint8Array(req.bytes),
        req.kind,
        req.expectedNAtoms,
      );
      ctx.postMessage(
        {
          id: req.id,
          ok: true,
          op: "trajectoryFrame0",
          result: { positions },
        } satisfies ParseResponse,
        [positions.buffer],
      );
    } else if (req.op === "indexStructure") {
      await ensureInit(req.wasm);
      // One read: build the persistent decoder (index) AND parse frame 0.
      const { decoder, index, frame0 } = indexStructureCore(new Uint8Array(req.bytes), req.kind);
      decoders.set(req.trajectoryId, decoder);
      // Transfer frame 0's backing buffers (positions/elements/bonds/…) zero-copy.
      const transfer = collectResultBuffers(frame0);
      ctx.postMessage(
        {
          id: req.id,
          ok: true,
          op: "indexStructure",
          result: { index, frame0 },
        } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "indexTrajectory") {
      await ensureInit(req.wasm);
      const { decoder, index } = indexTrajectoryCore(
        new Uint8Array(req.bytes),
        req.kind,
        req.expectedNAtoms,
      );
      decoders.set(req.trajectoryId, decoder);
      // Transfer the small index arrays (box, times) zero-copy.
      const transfer: Transferable[] = [index.times.buffer];
      if (index.box) transfer.push(index.box.buffer);
      if (index.boxOrigin) transfer.push(index.boxOrigin.buffer);
      ctx.postMessage(
        { id: req.id, ok: true, op: "indexTrajectory", result: index } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "indexTrajectoryFile") {
      await ensureInit(req.wasm);
      const { decoder, index } = await indexXtcFileCore(req.file, req.expectedNAtoms);
      decoders.set(req.trajectoryId, decoder);
      const transfer: Transferable[] = [index.times.buffer];
      if (index.box) transfer.push(index.box.buffer);
      ctx.postMessage(
        { id: req.id, ok: true, op: "indexTrajectoryFile", result: index } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "decodeFrame") {
      const decoder = decoders.get(req.trajectoryId);
      if (!decoder) throw new Error(`unknown trajectoryId ${req.trajectoryId}`);
      const { positions, vectors } = await decodeLazyFrameCore(decoder, req.frame);
      const vectorChannelCount = vectors.length > 0 ? vectors.length / (decoder.n_atoms * 3) : 0;
      const transfer: Transferable[] = [positions.buffer];
      if (vectors.length > 0) transfer.push(vectors.buffer);
      ctx.postMessage(
        {
          id: req.id,
          ok: true,
          op: "decodeFrame",
          result: { frame: req.frame, positions, vectors, vectorChannelCount },
        } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "init") {
      await ensureInit(req.wasm);
      ctx.postMessage({ id: req.id, ok: true, op: "init" } satisfies ParseResponse);
    } else if (req.op === "disposeTrajectory") {
      decoders.get(req.trajectoryId)?.free();
      decoders.delete(req.trajectoryId);
      ctx.postMessage({ id: req.id, ok: true, op: "disposeTrajectory" } satisfies ParseResponse);
    }
  } catch (err) {
    ctx.postMessage({
      id: req.id,
      ok: false,
      op: req.op,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ParseResponse);
  }
};
