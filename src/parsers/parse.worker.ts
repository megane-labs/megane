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
  indexDumpFileCore,
  indexBinaryTrajectoryFileCore,
  indexStructureCore,
  indexStructureFileCore,
  indexTrajFileCore,
  decodeTrajectoryFrame0Core,
  decodeLazyFrameCore,
  wasmHeapBytes,
  type LazyFrameDecoder,
} from "./parseCore";
import { packLabels } from "./labels";
import type { ParseRequest, ParseResponse, WasmSource } from "./parseMessages";

interface WorkerSelf {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerSelf;

/** Post a response, stamped with the heap size so the main thread can report it. */
function respond(response: ParseResponse, transfer?: Transferable[]): void {
  ctx.postMessage({ ...response, wasmBytes: wasmHeapBytes() }, transfer);
}

// Persistent lazy per-frame decoders (trajectory OR multi-frame structure),
// keyed by a client-allocated id and freed on `disposeTrajectory`. One indexed
// from its File (XTC / LAMMPS dump via `indexTrajectoryFile`, XYZ / PDB via
// `indexStructure` with a file) reads each frame from the file; one built from
// bytes holds the whole file in WASM memory for its lifetime.
const decoders = new Map<number, LazyFrameDecoder>();

/** The WASM module would not start: no request can succeed in this worker. */
class WorkerInitError extends Error {}

async function init(wasm: WasmSource): Promise<void> {
  try {
    await ensureInit(wasm);
  } catch (err) {
    throw new WorkerInitError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Whether `err` leaves this worker unusable, as opposed to the request's input
 * being rejected: the module failed to start, or a call trapped, which can
 * leave the module's memory inconsistent. Ordinary parser errors are not.
 */
function isFatal(err: unknown): boolean {
  return err instanceof WorkerInitError || err instanceof WebAssembly.RuntimeError;
}

ctx.onmessage = async (e: MessageEvent<ParseRequest>) => {
  const req = e.data;
  try {
    if (req.op === "structure") {
      await init(req.wasm);
      const bytes = req.bytes ?? (req.file ? await req.file.arrayBuffer() : undefined);
      const result = parseStructureCore({
        ext: req.ext,
        text: req.text,
        bytes: bytes ? new Uint8Array(bytes) : undefined,
      });
      const transfer = collectResultBuffers(result);
      respond(
        {
          id: req.id,
          ok: true,
          op: "structure",
          result: packLabels(result),
        } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "trajectory") {
      await init(req.wasm);
      const result = parseTrajectoryCore({
        kind: req.kind,
        text: req.text,
        bytes: req.bytes ? new Uint8Array(req.bytes) : undefined,
        expectedNAtoms: req.expectedNAtoms,
      });
      const transfer = collectResultBuffers(result);
      respond({ id: req.id, ok: true, op: "trajectory", result } satisfies ParseResponse, transfer);
    } else if (req.op === "structurePrefix") {
      await init(req.wasm);
      // Parse frame 0 from a bounded prefix; throws if frame 0 isn't fully in it.
      const result = parseStructurePrefixCore(req.text, req.kind, req.isWholeFile);
      const transfer = collectResultBuffers(result);
      respond(
        {
          id: req.id,
          ok: true,
          op: "structurePrefix",
          result: packLabels(result),
        } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "trajFrame0") {
      await init(req.wasm);
      // Frame 0 of a .traj from its head + tail; throws if they don't hold it.
      const result = parseTrajFrame0Core(
        new Uint8Array(req.head),
        new Uint8Array(req.tail),
        req.totalSize,
      );
      const transfer = collectResultBuffers(result);
      respond(
        {
          id: req.id,
          ok: true,
          op: "trajFrame0",
          result: packLabels(result),
        } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "trajectoryFrame0") {
      await init(req.wasm);
      // Decode frame 0 from a bounded prefix; throws if the prefix is too small.
      const positions = decodeTrajectoryFrame0Core(
        new Uint8Array(req.bytes),
        req.kind,
        req.expectedNAtoms,
      );
      respond(
        {
          id: req.id,
          ok: true,
          op: "trajectoryFrame0",
          result: { positions },
        } satisfies ParseResponse,
        [positions.buffer],
      );
    } else if (req.op === "indexStructure") {
      await init(req.wasm);
      // One request: build the persistent decoder (index) AND parse frame 0.
      const { kind, file } = req;
      if (kind === "traj" && !file) throw new Error("an ASE .traj is indexed from its File");
      const { decoder, index, frame0 } =
        kind === "traj"
          ? await indexTrajFileCore(file!)
          : file
            ? await indexStructureFileCore(file, kind)
            : indexStructureCore(new Uint8Array(req.bytes ?? new ArrayBuffer(0)), kind);
      decoders.set(req.trajectoryId, decoder);
      // Transfer frame 0's backing buffers (positions/elements/bonds/…) zero-copy.
      const transfer = collectResultBuffers(frame0);
      respond(
        {
          id: req.id,
          ok: true,
          op: "indexStructure",
          result: { index, frame0: packLabels(frame0) },
        } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "indexTrajectory") {
      await init(req.wasm);
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
      respond(
        { id: req.id, ok: true, op: "indexTrajectory", result: index } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "indexTrajectoryFile") {
      await init(req.wasm);
      const { decoder, index } =
        req.kind === "lammpstrj"
          ? await indexDumpFileCore(req.file, req.expectedNAtoms)
          : req.kind === "dcd" || req.kind === "netcdf"
            ? await indexBinaryTrajectoryFileCore(req.file, req.kind, req.expectedNAtoms)
            : await indexXtcFileCore(req.file, req.expectedNAtoms);
      decoders.set(req.trajectoryId, decoder);
      const transfer: Transferable[] = [index.times.buffer];
      if (index.box) transfer.push(index.box.buffer);
      if (index.boxOrigin) transfer.push(index.boxOrigin.buffer);
      respond(
        { id: req.id, ok: true, op: "indexTrajectoryFile", result: index } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "decodeFrame") {
      const decoder = decoders.get(req.trajectoryId);
      if (!decoder) throw new Error(`unknown trajectoryId ${req.trajectoryId}`);
      const { positions, vectors, box } = await decodeLazyFrameCore(decoder, req.frame);
      const vectorChannelCount = vectors.length > 0 ? vectors.length / (decoder.n_atoms * 3) : 0;
      const transfer: Transferable[] = [positions.buffer];
      if (vectors.length > 0) transfer.push(vectors.buffer);
      if (box) transfer.push(box.buffer);
      respond(
        {
          id: req.id,
          ok: true,
          op: "decodeFrame",
          result: { frame: req.frame, positions, vectors, vectorChannelCount, box },
        } satisfies ParseResponse,
        transfer,
      );
    } else if (req.op === "init") {
      await init(req.wasm);
      respond({ id: req.id, ok: true, op: "init" } satisfies ParseResponse);
    } else if (req.op === "disposeTrajectory") {
      decoders.get(req.trajectoryId)?.free();
      decoders.delete(req.trajectoryId);
      respond({ id: req.id, ok: true, op: "disposeTrajectory" } satisfies ParseResponse);
    }
  } catch (err) {
    respond({
      id: req.id,
      ok: false,
      op: req.op,
      error: err instanceof Error ? err.message : String(err),
      ...(isFatal(err) && { fatal: true }),
    } satisfies ParseResponse);
  }
};
