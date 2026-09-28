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
 * NOTE: on hosts whose bundler cannot handle the worker import (JupyterLab's
 * webpack, the single-file anywidget bundle, the VSCode webview whose CSP only
 * allows blob: workers), this module is swapped for `parseClientSync` at build
 * time — see `jupyterlab-megane/webpack.config.js`, `vite.widget.config.ts`
 * and `vscode-megane/vite.webview.config.ts`.
 */

import ParseWorker from "./parse.worker?worker";
import wasmAssetUrl from "../../crates/megane-wasm/pkg/megane_wasm_bg.wasm?url";
import { perfMark, perfMeasure } from "../perf";
import * as sync from "./parseClientSync";
import { structureExtFromFileName } from "./fileNames";
import type {
  StructureParseResult,
  XTCParseResult,
  TrajectoryKind,
  TrajectoryIndexResult,
  LazyTrajectoryKind,
  LazyStructureKind,
  StructureIndexResult,
} from "./parseCore";
import type {
  ParseRequest,
  ParseResponse,
  DecodeFrameResult,
  IndexStructureResult,
  TrajectoryFrame0Result,
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
    }
  }, WORKER_IDLE_MS);
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

/** Whether to lazily decode a multi-frame structure file's extra frames (XYZ). */
export function shouldUseLazyStructure(_kind: LazyStructureKind, fileSize: number): boolean {
  return shouldUseLazy(fileSize);
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
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new ParseWorker();
  w.onmessage = (e: MessageEvent<ParseResponse>) => {
    const entry = pending.get(e.data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(e.data.id);
    scheduleIdleRelease();
    if (e.data.ok) {
      entry.resolve(e.data.result);
    } else {
      entry.reject(new Error(e.data.error ?? "worker parse failed"));
    }
  };
  w.onerror = () => tearDown("parse worker crashed");
  worker = w;
  return w;
}

/** Resolve the WASM asset URL on the main thread to pass into the worker. */
function resolveWasmUrl(): string | undefined {
  const override = (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__;
  if (typeof override === "string") return override;
  return wasmAssetUrl as unknown as string;
}

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
    w.postMessage(req, transfer);
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
    if (ext === ".traj") {
      const buffer = await file.arrayBuffer();
      req = { id, op: "structure", wasmUrl: resolveWasmUrl(), ext, bytes: buffer };
      transfer.push(buffer);
    } else {
      const text = await file.text();
      req = { id, op: "structure", wasmUrl: resolveWasmUrl(), ext, text };
    }
    const result = await send<StructureParseResult>(req, transfer);
    perfMark(`megane:parse:end:${tag}`);
    perfMeasure(`megane:parse:${tag}`, `megane:parse:start:${tag}`, `megane:parse:end:${tag}`);
    return result;
  } catch {
    tearDown("falling back to synchronous parse");
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
    const req: ParseRequest = { id, op: "structure", wasmUrl: resolveWasmUrl(), ext, text };
    return await send<StructureParseResult>(req, []);
  } catch {
    tearDown("falling back to synchronous parse");
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
      const text = await file.text();
      req = { id, op: "trajectory", wasmUrl: resolveWasmUrl(), kind, text, expectedNAtoms };
    } else {
      const buffer = await file.arrayBuffer();
      req = {
        id,
        op: "trajectory",
        wasmUrl: resolveWasmUrl(),
        kind,
        bytes: buffer,
        expectedNAtoms,
      };
      transfer.push(buffer);
    }
    return await send<XTCParseResult>(req, transfer);
  } catch {
    tearDown("falling back to synchronous parse");
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

/**
 * Build a lazy trajectory decoder in the worker: reads the file, scans its
 * frame index (no coordinate decode), and keeps the bytes resident in the
 * worker so frames can be decoded on demand via {@link decodeTrajectoryFrame}.
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
    const buffer = await file.arrayBuffer();
    const index = await send<TrajectoryIndexResult>(
      {
        id,
        op: "indexTrajectory",
        wasmUrl: resolveWasmUrl(),
        kind,
        trajectoryId,
        bytes: buffer,
        expectedNAtoms,
      },
      [buffer],
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
  let size = Math.min(file.size, LAZY_XTC_MIN_BYTES);
  for (;;) {
    try {
      const id = nextId++;
      const buffer = await file.slice(0, size).arrayBuffer();
      const { positions } = await send<TrajectoryFrame0Result>(
        {
          id,
          op: "trajectoryFrame0",
          wasmUrl: resolveWasmUrl(),
          kind,
          bytes: buffer,
          expectedNAtoms,
        },
        [buffer],
      );
      return positions;
    } catch {
      if (size >= file.size || size >= PREFIX_MAX_BYTES) return null;
      size = Math.min(file.size, size * 2);
    }
  }
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

// ── Lazy multi-frame structure files (XYZ / PDB) ────────────────────────
//
// Structure files carry frame 0 as the eager snapshot and frames 1..N as
// "extra" frames. `indexStructureLazy` reads the file ONCE: the worker builds a
// persistent decoder (the extra-frame index) AND parses frame 0 from the same
// bytes, so frame 0 can render immediately while the rest stream in on demand
// via {@link decodeTrajectoryFrame}. The decoder shares the trajectory decoder
// map, so `decodeTrajectoryFrame` / `disposeTrajectoryLazy` service it too.

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

// Initial / max prefix read for `parseStructurePrefix`. One large frame of a
// big multi-frame file (e.g. 100k atoms ≈ a few MB) must fit; grow-and-retry
// handles bigger frames, capping the critical-path read regardless of total size.
const PREFIX_INITIAL_BYTES = 8 * 1024 * 1024;
const PREFIX_MAX_BYTES = 256 * 1024 * 1024;
// Bounded tail read that captures a multi-MODEL PDB's trailing CONECT section
// (written once after the last ENDMDL) so frame 0 gets explicit bonds.
const PDB_TAIL_BYTES = 4 * 1024 * 1024;

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
  kind: LazyStructureKind,
): Promise<StructureParseResult | null> {
  if (workerUnavailable()) return null;
  let size = Math.min(file.size, PREFIX_INITIAL_BYTES);
  for (;;) {
    const isWholeFile = size >= file.size;
    // Read the head (frame 0) and — for PDB — the trailing CONECT section in
    // parallel. The tail starts at/after the head so the two never overlap.
    const wantTail = kind === "pdb" && !isWholeFile && file.size - size > 0;
    const tailStart = Math.max(size, file.size - PDB_TAIL_BYTES);
    const [rawHead, rawTail] = await Promise.all([
      file.slice(0, size).text(),
      wantTail ? file.slice(tailStart).text() : Promise.resolve(""),
    ]);
    // Trim a partial trailing head line, and the partial leading tail line, so no
    // record is cut mid-way where the two chunks are stitched together.
    const head = isWholeFile ? rawHead : rawHead.slice(0, rawHead.lastIndexOf("\n") + 1);
    const tail = rawTail ? rawTail.slice(rawTail.indexOf("\n") + 1) : "";
    const text = tail ? head + tail : head;
    try {
      const id = nextId++;
      return await send<StructureParseResult>(
        { id, op: "structurePrefix", wasmUrl: resolveWasmUrl(), kind, text, isWholeFile },
        [],
      );
    } catch {
      // Frame 0 didn't fit: grow and retry, or give up (→ full-read fallback).
      if (isWholeFile || size >= PREFIX_MAX_BYTES) return null;
      size = Math.min(file.size, size * 2);
    }
  }
}

/**
 * Build a lazy structure-frame decoder in the worker AND get frame 0 in one file
 * read: the worker scans the extra-frame index (no bulk coordinate decode),
 * keeps the bytes resident, and parses frame 0 from the same copy. Returns `null`
 * (fall back to eager parse) when the worker is unavailable or indexing fails.
 */
export async function indexStructureLazy(
  file: File,
  kind: LazyStructureKind,
): Promise<StructureLazyResult | null> {
  if (workerUnavailable()) return null;
  try {
    const id = nextId++;
    const trajectoryId = nextTrajId++;
    const buffer = await file.arrayBuffer();
    const { index, frame0 } = await send<IndexStructureResult>(
      { id, op: "indexStructure", wasmUrl: resolveWasmUrl(), kind, trajectoryId, bytes: buffer },
      [buffer],
    );
    liveDecoders.add(trajectoryId);
    return { handle: { trajectoryId, kind, index }, frame0 };
  } catch {
    return null;
  }
}
