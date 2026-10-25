/**
 * Synchronous, main-thread parse client.
 *
 * Reads the File on the main thread and calls `parseCore` directly — no Web
 * Worker. This is BOTH:
 *   1. the runtime fallback used by `parseClient.ts` when a worker cannot be
 *      created or errors/times out, and
 *   2. the build-time replacement for `parseClient.ts` on hosts whose bundler
 *      cannot handle a worker import (JupyterLab/webpack via
 *      `NormalModuleReplacementPlugin`, anywidget via a `resolve.alias`).
 *
 * It exposes exactly the same function signatures as `parseClient.ts` and the
 * original `structure.ts` / `xtc.ts`, so callers never change.
 */

import { perfMark, perfMeasure } from "../perf";
import {
  ensureInit,
  parseStructureCore,
  parseTrajectoryCore,
  type StructureParseResult,
  type XTCParseResult,
} from "./parseCore";
import { structureExtFromFileName } from "./fileNames";
import { readBlobBuffer, readBlobText } from "./fileBytes";
import type { DecodedLazyFrame, StructureLazyResult, TrajectoryLazyHandle } from "./parseMessages";
export type {
  DecodedLazyFrame,
  StructureLazyHandle,
  StructureLazyResult,
  TrajectoryLazyHandle,
} from "./parseMessages";

function extOf(name: string, fallback: string): string {
  return structureExtFromFileName(name, fallback);
}

export async function parseStructureFile(file: File): Promise<StructureParseResult> {
  await ensureInit();
  const ext = extOf(file.name, ".pdb");
  const tag = `${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}`;
  perfMark(`megane:parse:start:${tag}`);

  let parseResult: StructureParseResult;
  if (ext === ".traj") {
    const buffer = await readBlobBuffer(file);
    parseResult = parseStructureCore({ ext, bytes: new Uint8Array(buffer) });
  } else {
    const text = await readBlobText(file);
    parseResult = parseStructureCore({ ext, text });
  }

  perfMark(`megane:parse:end:${tag}`);
  perfMeasure(`megane:parse:${tag}`, `megane:parse:start:${tag}`, `megane:parse:end:${tag}`);
  return parseResult;
}

export async function parseStructureText(
  text: string,
  fileName?: string,
): Promise<StructureParseResult> {
  await ensureInit();
  const ext = fileName ? extOf(fileName, ".pdb") : ".pdb";
  return parseStructureCore({ ext, text });
}

export async function parseXTCFile(file: File, expectedNAtoms: number): Promise<XTCParseResult> {
  await ensureInit();
  const buffer = await readBlobBuffer(file);
  return parseTrajectoryCore({ kind: "xtc", bytes: new Uint8Array(buffer), expectedNAtoms });
}

export async function parseDCDFile(file: File, expectedNAtoms: number): Promise<XTCParseResult> {
  await ensureInit();
  const buffer = await readBlobBuffer(file);
  return parseTrajectoryCore({ kind: "dcd", bytes: new Uint8Array(buffer), expectedNAtoms });
}

export async function parseLammpstrjFile(
  file: File,
  expectedNAtoms: number,
): Promise<XTCParseResult> {
  await ensureInit();
  const text = await readBlobText(file);
  return parseTrajectoryCore({ kind: "lammpstrj", text, expectedNAtoms });
}

export async function parseNetCDFFile(file: File, expectedNAtoms: number): Promise<XTCParseResult> {
  await ensureInit();
  const buffer = await readBlobBuffer(file);
  return parseTrajectoryCore({ kind: "netcdf", bytes: new Uint8Array(buffer), expectedNAtoms });
}

/** Lazy decode needs a worker; the sync path never uses it. */
export function shouldUseLazyTrajectory(
  _kind: import("./parseCore").LazyTrajectoryKind,
  _fileSize: number,
): boolean {
  return false;
}

/**
 * Lazy decode is worker-only. On the synchronous path (JupyterLab/anywidget
 * bundles, or the runtime worker-unavailable fallback) this returns `null`, the
 * uniform "fall back to eager parse" signal — the caller then uses the eager parser.
 */
export async function indexTrajectoryLazy(
  _file: File,
  _kind: import("./parseCore").LazyTrajectoryKind,
  _expectedNAtoms: number,
): Promise<TrajectoryLazyHandle | null> {
  return null;
}

/** Worker-only; returns `null` so the caller falls back to a full read. */
export async function decodeTrajectoryFrame0(
  _file: File,
  _kind: import("./parseCore").LazyTrajectoryKind,
  _expectedNAtoms: number,
): Promise<Float32Array | null> {
  return null;
}

/** Never called (indexTrajectoryLazy returns null so no lazy provider is created). */
export async function decodeTrajectoryFrame(
  _trajectoryId: number,
  _frame: number,
): Promise<DecodedLazyFrame> {
  throw new Error("decodeTrajectoryFrame is worker-only");
}

/** No-op: there is no persistent decoder on the synchronous path. */
export function disposeTrajectoryLazy(_trajectoryId: number): void {
  /* no-op */
}

/** Worker-only; returns `null` so the caller waits for the whole file. */
export async function parseStructureHead(
  _head: Uint8Array,
  _tail: Uint8Array,
  _totalSize: number,
  _kind: import("./parseCore").LazyStructureKind | "traj",
): Promise<StructureParseResult | null> {
  return null;
}

/** Worker-only; nothing to warm up on the main-thread path. */
export function prewarmParseWorker(): void {
  /* no-op */
}

// ── Lazy multi-frame structure files (mirrored; never used on the sync path) ──

/** Lazy structure decode needs a worker; the sync path never uses it. */
export function shouldUseLazyStructure(
  _kind: import("./parseCore").FileStructureKind,
  _fileSize: number,
): boolean {
  return false;
}

/** Worker-only; returns `null` so the caller falls back to eager parsing. */
export async function parseStructurePrefix(
  _file: File,
  _kind: import("./parseCore").FileStructureKind,
): Promise<StructureParseResult | null> {
  return null;
}

/** Worker-only; returns `null` so the caller falls back to eager parsing. */
export async function indexStructureLazy(
  _file: File,
  _kind: import("./parseCore").FileStructureKind,
): Promise<StructureLazyResult | null> {
  return null;
}
