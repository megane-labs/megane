/**
 * Worker-backed parse client.
 *
 * Runs WASM file parsing in a single reusable Web Worker so the main thread
 * stays responsive during large / multi-frame file loads. Falls back
 * transparently to the synchronous main-thread path (`parseClientSync`) when a
 * worker cannot be created or a request errors / times out — so no host is ever
 * left unable to open a file.
 *
 * Exposes the same signatures as the original `structure.ts` / `xtc.ts`.
 *
 * The worker is emitted as its own file (`?worker`), not inlined as a blob:
 * it imports the wasm-bindgen glue as a separate chunk by relative URL, which a
 * `blob:` worker cannot resolve. The inline build failed on its first request
 * in every production bundle, which silently moved all parsing back onto the
 * main thread and disabled lazy trajectory streaming for the session.
 *
 * NOTE: the single-file bundles (the anywidget widget, the npm library, the
 * Builder bundles) swap this module for `parseClientSync` at build time via
 * `syncParseAlias()` in vite.shared.ts. JupyterLab's webpack build keeps it and
 * builds the worker from `parseWorker.webpack.ts`. The VSCode viewer webview
 * keeps it too, with the worker inlined after all (its build folds the glue
 * into the worker, see vscode-megane/vite.webview.config.ts) and fed a WASM
 * module compiled on the page (`compileWasm` below).
 */

import ParseWorker from "./parse.worker?worker";
import wasmAssetUrl from "../../crates/megane-wasm/pkg/megane_wasm_bg.wasm?url";
import { perfMark, perfMeasure } from "../perf";
import * as sync from "./parseClientSync";
import { wasmHeapBytes } from "./parseCore";
import { structureExtFromFileName } from "./fileNames";
import { isResident, readBlobBuffer, readBlobText } from "./fileBytes";
import { unpackLabels, type PackedLabels } from "./labels";
import type {
  StructureParseResult,
  XTCParseResult,
  TrajectoryKind,
  TrajectoryIndexResult,
  LazyTrajectoryKind,
  LazyStructureKind,
  FileStructureKind,
} from "./parseCore";
import type {
  ParseRequest,
  ParseResponse,
  DecodeFrameResult,
  IndexStructureResult,
  TrajectoryFrame0Result,
  DecodedLazyFrame,
  StructureLazyResult,
  TrajectoryLazyHandle,
} from "./parseMessages";
export type {
  DecodedLazyFrame,
  StructureLazyHandle,
  StructureLazyResult,
  TrajectoryLazyHandle,
} from "./parseMessages";

const TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 0;
let nextTrajId = 0;

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, Pending>();

/**
 * How long the worker may sit idle before it is terminated.
 *
 * WASM linear memory only ever grows, so after a large parse the worker keeps
 * that high-water mark (easily tens of MB) for as long as it lives. Once nothing
 * is in flight and no lazy decoder needs the file bytes it holds, the worker is
 * released to give that memory back; the next request starts a fresh one (the
 * glue and .wasm come from the HTTP cache, so that costs tens of milliseconds).
 */
export const WORKER_IDLE_MS = 10_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** WASM heap the live worker last reported; 0 once it is terminated. */
let workerHeapBytes = 0;
/** Lazy decoders alive in the worker (trajectory ids not yet disposed). */
const liveDecoders = new Set<number>();

function cancelIdleRelease(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function workerIdle(): boolean {
  return pending.size === 0 && liveDecoders.size === 0;
}

function scheduleIdleRelease(): void {
  cancelIdleRelease();
  if (!worker || !workerIdle()) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Re-check: a decoder handle is registered only after its index response.
    if (worker && workerIdle()) {
      worker.terminate();
      worker = null;
      workerHeapBytes = 0;
    }
  }, WORKER_IDLE_MS);
}

/**
 * Bytes of WASM memory the parsers hold: the worker's heap (as of its last
 * response) plus the main thread's, which the synchronous fallback and the
 * main-thread helpers (bond inference, labels) use.
 */
export function parserHeapBytes(): number {
  return workerHeapBytes + wasmHeapBytes();
}

function workerUnavailable(): boolean {
  return workerBroken || typeof Worker === "undefined";
}

// Below this file size, eager decode is fast enough that streaming would only
// add per-frame worker overhead (and slightly slower playback) for no benefit —
// so lazy decode only kicks in for genuinely large trajectories, where decoding
// every frame up-front is the actual bottleneck.
const LAZY_XTC_MIN_BYTES = 8 * 1024 * 1024;

/**
 * Shared gate for lazy/streaming decode. Requires a worker. A
 * `globalThis.__MEGANE_LAZY_XTC__` boolean override forces lazy on/off
 * (bypassing the size gate — used by tests and as a kill switch); otherwise
 * lazy is used only for files at or above {@link LAZY_XTC_MIN_BYTES}.
 */
function shouldUseLazy(fileSize: number): boolean {
  if (workerUnavailable()) return false;
  const override = (globalThis as Record<string, unknown>).__MEGANE_LAZY_XTC__;
  if (typeof override === "boolean") return override;
  return fileSize >= LAZY_XTC_MIN_BYTES;
}

/** Whether to stream a given trajectory file lazily (XTC / LAMMPS dump). */
export function shouldUseLazyTrajectory(_kind: LazyTrajectoryKind, fileSize: number): boolean {
  return shouldUseLazy(fileSize);
}

/** Whether to lazily decode a multi-frame structure file's extra frames (XYZ / PDB / .traj). */
export function shouldUseLazyStructure(_kind: FileStructureKind, fileSize: number): boolean {
  return shouldUseLazy(fileSize);
}

/**
 * The worker answered a request with an error: it rejected the request's input
 * (a malformed file, an atom-count mismatch). The worker itself is fine, so
 * this never tears it down; a crash, a timeout or a fatal reply rejects with a
 * plain `Error` instead.
 */
export class WorkerReplyError extends Error {
  override name = "WorkerReplyError";
}

/** Reject every in-flight request and drop the worker (used on a fatal error). */
function tearDown(reason: string): void {
  workerBroken = true;
  cancelIdleRelease();
  liveDecoders.clear();
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerHeapBytes = 0;
}

/**
 * A worker request failed and its caller is falling back to the main thread:
 * drop the worker too, unless it only rejected that request's input. Tearing
 * it down over one malformed file would end lazy streaming (its decoders die
 * with it) and keep every later parse on the main thread for the session.
 */
function tearDownUnlessRejected(err: unknown): void {
  if (!(err instanceof WorkerReplyError)) tearDown("falling back to synchronous parse");
}

/** Split the labels a structure result carries as text (see `./labels`). */
function unpackResultLabels(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as { labelsText?: unknown; frame0?: unknown };
    if (typeof r.labelsText === "string") unpackLabels(result as PackedLabels);
    if (r.frame0 && typeof r.frame0 === "object") unpackLabels(r.frame0 as PackedLabels);
  }
  return result;
}

function getWorker(): Worker {
  if (worker) return worker;
  // A crashed worker stays down for the session: every caller has already
  // fallen back to the main thread, and a retry must not spin up another one.
  if (workerBroken) throw new Error("parse worker unavailable");
  const w = new ParseWorker();
  w.onmessage = (e: MessageEvent<ParseResponse>) => {
    if (e.data.wasmBytes !== undefined) workerHeapBytes = e.data.wasmBytes;
    const entry = pending.get(e.data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(e.data.id);
    scheduleIdleRelease();
    if (e.data.ok) {
      entry.resolve(unpackResultLabels(e.data.result));
    } else {
      const message = e.data.error ?? "worker parse failed";
      entry.reject(e.data.fatal ? new Error(message) : new WorkerReplyError(message));
    }
  };
  w.onerror = () => tearDown("parse worker crashed");
  // A response that cannot be deserialized would otherwise leave its request
  // pending until the timeout.
  w.onmessageerror = () => tearDown("parse worker sent an unreadable message");
  worker = w;
  return w;
}

/** Resolve the WASM asset URL on the main thread to pass into the worker. */
function resolveWasmUrl(): string | undefined {
  const override = (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__;
  if (typeof override === "string") return override;
  return wasmAssetUrl as unknown as string;
}

/**
 * The compiled module for a WASM URL the worker cannot fetch itself (one per
 * URL, kept for later workers: the idle release terminates the worker, not the
 * module).
 *
 * In a VS Code webview the `.wasm` lives on the extension's resource origin,
 * which only answers requests that pass through the webview's service worker.
 * The page's own requests do; a Web Worker's do not, and its fetch of the
 * resource URL hangs (about 30 s) before failing. So the page fetches and
 * compiles the module, and the worker is handed the `WebAssembly.Module`.
 */
const compiledWasm = new Map<string, Promise<WebAssembly.Module>>();

/** Whether `url` is on another origin than the page (so the worker should not fetch it). */
export function isCrossOriginWasm(url: string, pageUrl: string | undefined): boolean {
  if (!pageUrl) return false;
  try {
    const resolved = new URL(url, pageUrl);
    if (resolved.protocol === "blob:" || resolved.protocol === "data:") return false;
    const pageOrigin = new URL(pageUrl).origin;
    // A custom-scheme page (`vscode-webview://…`) has an opaque origin.
    return pageOrigin === "null" || resolved.origin !== pageOrigin;
  } catch {
    return false;
  }
}

function compileWasm(url: string): Promise<WebAssembly.Module> {
  let module = compiledWasm.get(url);
  if (!module) {
    module = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => WebAssembly.compile(bytes));
    module.catch(() => compiledWasm.delete(url));
    compiledWasm.set(url, module);
  }
  return module;
}

/**
 * The module every request waits for once the WASM turned out to be
 * cross-origin. Requests are then posted after it resolves, all through the
 * same promise, so they still reach the worker in the order they were sent.
 */
let wasmGate: Promise<WebAssembly.Module> | null = null;

function send<T>(req: ParseRequest, transfer: Transferable[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    cancelIdleRelease();
    const w = getWorker();
    const timer = setTimeout(() => {
      pending.delete(req.id);
      scheduleIdleRelease();
      reject(new Error(`parse worker timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    pending.set(req.id, {
      resolve: resolve as Pending["resolve"],
      reject,
      timer,
    });
    const url = "wasm" in req ? req.wasm : undefined;
    if (typeof url === "string" && isCrossOriginWasm(url, globalThis.location?.href)) {
      wasmGate = compileWasm(url);
    }
    if (!wasmGate) {
      w.postMessage(req, transfer);
      return;
    }
    wasmGate.then(
      (module) => w.postMessage("wasm" in req ? { ...req, wasm: module } : req, transfer),
      (err: unknown) => {
        clearTimeout(timer);
        pending.delete(req.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function parseStructureFile(file: File): Promise<StructureParseResult> {
  if (workerUnavailable()) return sync.parseStructureFile(file);

  const ext = structureExtFromFileName(file.name);
  const tag = `${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}`;
  perfMark(`megane:parse:start:${tag}`);
  try {
    const id = nextId++;
    let req: ParseRequest;
    const transfer: Transferable[] = [];
    // Text formats travel as bytes too and are decoded inside WASM: a JS string
    // of the file would sit on this thread and be cloned into the worker.
    if (isResident(file)) {
      // The host holds the bytes: hand over a copy rather than make the
      // worker read them back through the (slow) Blob API.
      const buffer = await readBlobBuffer(file);
      req = { id, op: "structure", wasm: resolveWasmUrl(), ext, bytes: buffer };
      transfer.push(buffer);
    } else {
      req = { id, op: "structure", wasm: resolveWasmUrl(), ext, file };
    }
    const result = await send<StructureParseResult>(req, transfer);
    perfMark(`megane:parse:end:${tag}`);
    perfMeasure(`megane:parse:${tag}`, `megane:parse:start:${tag}`, `megane:parse:end:${tag}`);
    return result;
  } catch (err) {
    tearDownUnlessRejected(err);
    return sync.parseStructureFile(file);
  }
}

export async function parseStructureText(
  text: string,
  fileName?: string,
): Promise<StructureParseResult> {
  if (workerUnavailable()) return sync.parseStructureText(text, fileName);
  const ext = fileName ? structureExtFromFileName(fileName) : ".pdb";
  try {
    const id = nextId++;
    const req: ParseRequest = { id, op: "structure", wasm: resolveWasmUrl(), ext, text };
    return await send<StructureParseResult>(req, []);
  } catch (err) {
    tearDownUnlessRejected(err);
    return sync.parseStructureText(text, fileName);
  }
}

async function parseTrajectoryFile(
  kind: TrajectoryKind,
  file: File,
  expectedNAtoms: number,
  syncFn: (f: File, n: number) => Promise<XTCParseResult>,
): Promise<XTCParseResult> {
  if (workerUnavailable()) return syncFn(file, expectedNAtoms);
  try {
    const id = nextId++;
    let req: ParseRequest;
    const transfer: Transferable[] = [];
    if (kind === "lammpstrj") {
      const text = await readBlobText(file);
      req = { id, op: "trajectory", wasm: resolveWasmUrl(), kind, text, expectedNAtoms };
    } else {
      const buffer = await readBlobBuffer(file);
      req = {
        id,
        op: "trajectory",
        wasm: resolveWasmUrl(),
        kind,
        bytes: buffer,
        expectedNAtoms,
      };
      transfer.push(buffer);
    }
    return await send<XTCParseResult>(req, transfer);
  } catch (err) {
    tearDownUnlessRejected(err);
    return syncFn(file, expectedNAtoms);
  }
}

export function parseXTCFile(file: File, expectedNAtoms: number): Promise<XTCParseResult> {
  return parseTrajectoryFile("xtc", file, expectedNAtoms, sync.parseXTCFile);
}

export function parseDCDFile(file: File, expectedNAtoms: number): Promise<XTCParseResult> {
  return parseTrajectoryFile("dcd", file, expectedNAtoms, sync.parseDCDFile);
}

export function parseLammpstrjFile(file: File, expectedNAtoms: number): Promise<XTCParseResult> {
  return parseTrajectoryFile("lammpstrj", file, expectedNAtoms, sync.parseLammpstrjFile);
}

export function parseNetCDFFile(file: File, expectedNAtoms: number): Promise<XTCParseResult> {
  return parseTrajectoryFile("netcdf", file, expectedNAtoms, sync.parseNetCDFFile);
}

/**
 * Build a lazy trajectory decoder in the worker: scans its frame index (no
 * coordinate decode) so frames can be decoded on demand via
 * {@link decodeTrajectoryFrame}. An XTC stays in its File — the worker reads
 * windows of it for the index and each frame's bytes when it is decoded, so
 * its memory does not grow with the trajectory; a LAMMPS dump is read whole
 * and kept resident in the worker.
 * Returns `null` — the single uniform "fall back to eager parse" signal — when
 * the worker is unavailable (incl. the `parseClientSync` build) or indexing fails.
 */
export async function indexTrajectoryLazy(
  file: File,
  kind: LazyTrajectoryKind,
  expectedNAtoms: number,
): Promise<TrajectoryLazyHandle | null> {
  if (workerUnavailable()) return null;
  try {
    const id = nextId++;
    const trajectoryId = nextTrajId++;
    const wasm = resolveWasmUrl();
    // The worker indexes the File from windows and reads each frame when it
    // is shown, so neither thread ever holds the whole trajectory.
    const index = await send<TrajectoryIndexResult>(
      { id, op: "indexTrajectoryFile", wasm, kind, trajectoryId, file, expectedNAtoms },
      [],
    );
    liveDecoders.add(trajectoryId);
    return { trajectoryId, kind, index };
  } catch {
    // Any failure ⇒ let the caller fall back to eager parsing.
    return null;
  }
}

/**
 * Decode ONLY frame 0 of a large trajectory (XTC / LAMMPS dump) from a bounded
 * prefix — for size-independent first paint (read one frame, not the whole
 * file). Grows the prefix if frame 0 doesn't fit; returns `null` (caller falls
 * back to the full index read) when the worker is unavailable or frame 0 exceeds
 * the max prefix.
 */
export async function decodeTrajectoryFrame0(
  file: File,
  kind: LazyTrajectoryKind,
  expectedNAtoms: number,
): Promise<Float32Array | null> {
  if (workerUnavailable()) return null;
  // Kill switch / A-B knob: `globalThis.__MEGANE_TRAJ_FRAME0__ === false` disables
  // the phase-1 partial read so loadXtc falls back to the single full-read index
  // (the pre-two-phase behaviour). Used by the perf profiler to measure the win.
  if ((globalThis as Record<string, unknown>).__MEGANE_TRAJ_FRAME0__ === false) return null;
  return withGrowingPrefix(file, async (size) => {
    const id = nextId++;
    const buffer = await readBlobBuffer(file, 0, size);
    const { positions } = await send<TrajectoryFrame0Result>(
      {
        id,
        op: "trajectoryFrame0",
        wasm: resolveWasmUrl(),
        kind,
        bytes: buffer,
        expectedNAtoms,
      },
      [buffer],
    );
    return positions;
  });
}

/** Decode one frame (positions + any vectors) of a previously-indexed trajectory. */
export async function decodeTrajectoryFrame(
  trajectoryId: number,
  frame: number,
): Promise<DecodedLazyFrame> {
  const id = nextId++;
  const result = await send<DecodeFrameResult>({ id, op: "decodeFrame", trajectoryId, frame }, []);
  return {
    positions: result.positions,
    vectors: result.vectors,
    vectorChannelCount: result.vectorChannelCount,
    ...(result.box && { box: result.box }),
  };
}

/** Free a lazy trajectory decoder in the worker (fire-and-forget). */
export function disposeTrajectoryLazy(trajectoryId: number): void {
  if (workerUnavailable()) return;
  liveDecoders.delete(trajectoryId);
  const id = nextId++;
  void send<undefined>({ id, op: "disposeTrajectory", trajectoryId }, []).catch(() => {
    // best-effort cleanup; worker teardown already frees everything
  });
}

/**
 * Start the parse worker and compile its WASM module now, without parsing
 * anything. Hosts call it while they are still fetching a document's bytes
 * (the JupyterLab Contents request, the VSCode extension host's message) so
 * the ~150 ms of worker start-up and WASM compilation overlaps that wait
 * instead of following it. Best-effort: a failure is left for the real parse
 * request to surface (it falls back to the main thread).
 */
export function prewarmParseWorker(): void {
  if (workerUnavailable()) return;
  try {
    const id = nextId++;
    void send<undefined>({ id, op: "init", wasm: resolveWasmUrl() }, []).catch(() => {});
  } catch {
    // Worker construction failed; the next parse falls back on its own.
  }
}

// ── Lazy multi-frame structure files (XYZ / PDB) ────────────────────────
//
// Structure files carry frame 0 as the eager snapshot and frames 1..N as
// "extra" frames. `indexStructureLazy` reads the file ONCE: the worker builds a
// persistent decoder (the extra-frame index) AND parses frame 0 from the same
// bytes, so frame 0 can render immediately while the rest stream in on demand
// via {@link decodeTrajectoryFrame}. The decoder shares the trajectory decoder
// map, so `decodeTrajectoryFrame` / `disposeTrajectoryLazy` service it too.

// Initial / max prefix read for `parseStructurePrefix`. One large frame of a
// big multi-frame file (e.g. 100k atoms ≈ a few MB) must fit; grow-and-retry
// handles bigger frames, capping the critical-path read regardless of total size.
const PREFIX_INITIAL_BYTES = 8 * 1024 * 1024;
const PREFIX_MAX_BYTES = 256 * 1024 * 1024;
// Bounded tail read that captures a multi-MODEL PDB's trailing CONECT section
// (written once after the last ENDMDL) so frame 0 gets explicit bonds.
const PDB_TAIL_BYTES = 4 * 1024 * 1024;
// Bounded tail read holding an ASE .traj's offset table, which ASE rewrites at
// the end of the file as frames are appended: 1 MiB holds ~130k frames' entries.
const TRAJ_TAIL_BYTES = 1024 * 1024;

/**
 * Run `attempt` on the first {@link PREFIX_INITIAL_BYTES} of `file`, doubling
 * the prefix each time it throws (frame 0 did not fit) up to the whole file or
 * {@link PREFIX_MAX_BYTES}. Returns `null` — the caller then reads the whole
 * file — when it never succeeds, or at once when the worker has crashed.
 */
async function withGrowingPrefix<T>(
  file: File,
  attempt: (size: number) => Promise<T>,
): Promise<T | null> {
  let size = Math.min(file.size, PREFIX_INITIAL_BYTES);
  for (;;) {
    try {
      return await attempt(size);
    } catch {
      if (workerUnavailable() || size >= file.size || size >= PREFIX_MAX_BYTES) return null;
      size = Math.min(file.size, size * 2);
    }
  }
}

/**
 * Parse ONLY frame 0 from the FIRST chunk of a large multi-frame structure file,
 * for size-independent first paint: the read + parse cost is one frame, not the
 * whole file. Reads a bounded prefix (trimmed to the last newline so no atom line
 * is cut), growing if frame 0 doesn't fit. Returns `null` (caller falls back to a
 * full read) when the worker is unavailable, frame 0 exceeds the max prefix, or
 * the parse fails.
 *
 * For PDB it ALSO reads a bounded TAIL in parallel: multi-MODEL PDB writes its
 * `CONECT` records once, after the last `ENDMDL`, and they apply to every model.
 * Concatenating `head(model 0) + tail(CONECT)` gives frame 0 its explicit bonds
 * instead of distance-inferred ones — without reading the whole file.
 */
export async function parseStructurePrefix(
  file: File,
  kind: FileStructureKind,
): Promise<StructureParseResult | null> {
  if (workerUnavailable()) return null;
  if (kind === "traj") {
    // Frame 0 follows the header; the offset table locating it is usually in
    // the last bytes (see `parseStructureHead`).
    return withGrowingPrefix(file, async (size) => {
      const tailStart = Math.max(size, file.size - TRAJ_TAIL_BYTES);
      const [head, tail] = await Promise.all([
        readBlobBuffer(file, 0, size),
        readBlobBuffer(file, tailStart),
      ]);
      return sendTrajFrame0(head, tail, file.size);
    });
  }
  return withGrowingPrefix(file, async (size) => {
    const isWholeFile = size >= file.size;
    // Read the head (frame 0) and — for PDB — the trailing CONECT section in
    // parallel. The tail starts at/after the head so the two never overlap.
    const wantTail = kind === "pdb" && !isWholeFile && file.size - size > 0;
    const tailStart = Math.max(size, file.size - PDB_TAIL_BYTES);
    const [rawHead, rawTail] = await Promise.all([
      readBlobText(file, 0, size),
      wantTail ? readBlobText(file, tailStart) : Promise.resolve(""),
    ]);
    return sendStructurePrefix(rawHead, rawTail, kind, isWholeFile);
  });
}

/**
 * Parse frame 0 in the worker from a head chunk and (PDB) a tail chunk of text.
 * A partial trailing head line and the partial leading tail line are trimmed so
 * no record is cut mid-way where the two chunks are stitched together. Rejects
 * when frame 0 is not fully in the head.
 */
function sendStructurePrefix(
  rawHead: string,
  rawTail: string,
  kind: LazyStructureKind,
  isWholeFile: boolean,
): Promise<StructureParseResult> {
  const head = isWholeFile ? rawHead : rawHead.slice(0, rawHead.lastIndexOf("\n") + 1);
  const tail = rawTail ? rawTail.slice(rawTail.indexOf("\n") + 1) : "";
  const text = tail ? head + tail : head;
  const id = nextId++;
  return send<StructureParseResult>(
    { id, op: "structurePrefix", wasm: resolveWasmUrl(), kind, text, isWholeFile },
    [],
  );
}

/**
 * Parse frame 0 of a large file from just its first bytes (`head`) and last
 * bytes (`tail`), `totalSize` long in all — what a host that delivers a file
 * in pieces has before the rest arrives (see `src/hosts/progressiveFile.ts`).
 * `kind` picks the reader: the multi-frame XYZ / PDB prefix parse (PDB takes
 * its trailing CONECT records from `tail`), or the ASE `.traj` reader, which
 * finds frame 0 through the offset table in `tail`. The tail must start at or
 * after the head's end. Returns `null` when the worker is unavailable or the
 * chunks do not hold frame 0; the caller then waits for the whole file.
 */
export async function parseStructureHead(
  head: Uint8Array,
  tail: Uint8Array,
  totalSize: number,
  kind: LazyStructureKind | "traj",
): Promise<StructureParseResult | null> {
  if (workerUnavailable()) return null;
  try {
    if (kind === "traj")
      return await sendTrajFrame0(head.slice().buffer, tail.slice().buffer, totalSize);
    const isWholeFile = head.length >= totalSize;
    const decoder = new TextDecoder();
    const rawTail = kind === "pdb" && !isWholeFile ? decoder.decode(tail) : "";
    return await sendStructurePrefix(decoder.decode(head), rawTail, kind, isWholeFile);
  } catch {
    return null;
  }
}

/** Parse a `.traj`'s frame 0 in the worker from its head and tail bytes (moved there). */
function sendTrajFrame0(
  head: ArrayBuffer,
  tail: ArrayBuffer,
  totalSize: number,
): Promise<StructureParseResult> {
  return send<StructureParseResult>(
    { id: nextId++, op: "trajFrame0", wasm: resolveWasmUrl(), head, tail, totalSize },
    [head, tail],
  );
}

/**
 * Build a lazy structure-frame decoder in the worker AND get frame 0 in one file
 * read: the worker scans the extra-frame index (no bulk coordinate decode),
 * keeps the bytes resident, and parses frame 0 from the same copy. Returns `null`
 * (fall back to eager parse) when the worker is unavailable or indexing fails.
 */
export async function indexStructureLazy(
  file: File,
  kind: FileStructureKind,
): Promise<StructureLazyResult | null> {
  if (workerUnavailable()) return null;
  try {
    const id = nextId++;
    const trajectoryId = nextTrajId++;
    // The File itself: the worker indexes it from windows and reads frame 0
    // and each later frame from just their bytes.
    const { index, frame0 } = await send<IndexStructureResult>(
      { id, op: "indexStructure", wasm: resolveWasmUrl(), kind, trajectoryId, file },
      [],
    );
    liveDecoders.add(trajectoryId);
    return { handle: { trajectoryId, kind, index }, frame0 };
  } catch {
    return null;
  }
}
