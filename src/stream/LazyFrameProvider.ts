/**
 * Worker-backed frame provider for lazy/streaming trajectory playback.
 *
 * Instead of decoding every frame up-front, the owning code builds a frame
 * index in the parse worker (which keeps the file bytes resident) and hands the
 * resulting handle to this provider. `getFrame(i)` returns a cached frame, or
 * `null` while it asks the worker to decode frame `i` in the background; the
 * decoded frame arrives later via the `onFrameReady` callback (mirroring
 * `StreamFrameProvider`, so the existing async-frame render path is reused
 * verbatim). Frame 0 and a sliding window ahead of the playhead are prefetched
 * so playback rarely stalls.
 *
 * Two shapes are supported:
 *  - Trajectory files (XTC / LAMMPS dump): provider frame `i` == decoder frame
 *    `i`; frame 0 is a real decoded frame.
 *  - Structure files with extra frames (multi-frame XYZ / multi-MODEL PDB):
 *    `basePositions` is the eager snapshot (provider frame 0), and provider
 *    frame `i > 0` decodes the underlying "extra" frame `i - 1`.
 */

import type { Frame, TrajectoryMeta } from "../types";
import type { FrameProvider } from "../pipeline/types";
import type { DecodedLazyFrame } from "../parsers/parseClient";
import { frameCacheCapacity } from "./frameCacheCapacity";

/**
 * Minimal handle shape this provider needs — satisfied by both
 * `TrajectoryLazyHandle` (XTC / LAMMPS dump) and `StructureLazyHandle`
 * (multi-frame XYZ / PDB). Only the decoder id and its atom/frame counts matter
 * here; format-specific index fields (times, box, vector names) are consumed
 * upstream when the provider's `meta` is built.
 */
export interface LazyFrameHandle {
  trajectoryId: number;
  index: { nAtoms: number; nFrames: number };
}

const DEFAULT_CACHE_SIZE = 256;
const DEFAULT_PREFETCH_AHEAD = 16;

export interface LazyFrameProviderOptions {
  /** Most frames the cache keeps (default 256). */
  maxCacheSize?: number;
  /**
   * Most bytes of decoded positions the cache keeps (default 32 MiB); see
   * `frameCacheCapacity`. The cache always keeps at least two frames.
   */
  maxCacheBytes?: number;
  /** Frames decoded ahead of the requested one; never more than the cache holds. */
  prefetchAhead?: number;
  /** Decode one underlying frame (defaults to the worker `decodeTrajectoryFrame`). */
  decode?: (trajectoryId: number, frame: number) => Promise<DecodedLazyFrame>;
  /** Dispose the worker decoder (defaults to `disposeTrajectoryLazy`). */
  dispose?: (trajectoryId: number) => void;
  /**
   * Eager frame-0 positions for the structure-file convention. When set,
   * provider frame 0 returns these synchronously and provider frame `i > 0`
   * decodes underlying frame `i - 1`. Omit for trajectory files (frame 0 is a
   * real decoded frame).
   */
  basePositions?: Float32Array | null;
  /**
   * Pre-decoded frame-0 positions for the trajectory-file convention (frame 0 is
   * a real decodable frame). Seeds the cache so the first paint after a
   * phase-1→phase-2 provider swap needs no worker round-trip and doesn't flicker.
   * Ignored when `basePositions` is set (that convention already has a
   * synchronous frame 0).
   */
  seedFrame0?: Float32Array | null;
}

export class LazyFrameProvider implements FrameProvider {
  // Reuse the "stream" kind: nothing in the pipeline branches on it, and it
  // carries the same "getFrame may return null, frames arrive async" contract.
  readonly kind = "stream" as const;
  meta: TrajectoryMeta;

  private readonly trajectoryId: number;
  private readonly nAtoms: number;
  /** Number of decodable underlying frames (excludes the synthetic base frame). */
  private readonly decodableFrames: number;
  /** 1 when a synthetic base frame 0 is present (structure files), else 0. */
  private readonly baseOffset: number;
  /** Total frames exposed to consumers (decodable + base). */
  private readonly nFrames: number;
  private readonly basePositions: Float32Array | null;
  private cache: Map<number, Frame> = new Map();
  private cacheOrder: number[] = [];
  private inflight: Set<number> = new Set();
  private readonly maxCacheSize: number;
  private readonly prefetchAhead: number;
  private readonly decode: (trajectoryId: number, frame: number) => Promise<DecodedLazyFrame>;
  private readonly disposeFn: (trajectoryId: number) => void;
  private onFrameReady: ((frame: Frame) => void) | null = null;
  private onVectors:
    | ((frameId: number, vectors: Float32Array, channelCount: number) => void)
    | null = null;
  private onProgress: ((decoded: number, total: number) => void) | null = null;
  private decodedCountHW = 0;
  private disposed = false;

  constructor(handle: LazyFrameHandle, meta: TrajectoryMeta, opts: LazyFrameProviderOptions = {}) {
    this.trajectoryId = handle.trajectoryId;
    this.nAtoms = handle.index.nAtoms;
    this.decodableFrames = handle.index.nFrames;
    this.basePositions = opts.basePositions ?? null;
    this.baseOffset = this.basePositions ? 1 : 0;
    this.nFrames = this.decodableFrames + this.baseOffset;
    this.meta = meta;
    this.maxCacheSize = frameCacheCapacity(
      this.nAtoms,
      opts.maxCacheSize ?? DEFAULT_CACHE_SIZE,
      opts.maxCacheBytes,
    );
    // A window wider than the cache would evict the frames it decodes before
    // the playhead reaches them, and decode them again.
    this.prefetchAhead = Math.min(
      opts.prefetchAhead ?? DEFAULT_PREFETCH_AHEAD,
      this.maxCacheSize - 1,
    );
    this.decode = opts.decode ?? (() => Promise.reject(new Error("no decode fn")));
    this.disposeFn = opts.dispose ?? (() => {});
    // Seed a pre-decoded frame 0 (trajectory convention) so the cache serves it
    // synchronously — the phase-1 partial-read result carries over the swap with
    // no re-decode and no flicker.
    if (opts.seedFrame0 && !this.basePositions) {
      this.cacheFrame({ frameId: 0, nAtoms: this.nAtoms, positions: opts.seedFrame0 });
      this.decodedCountHW = 1;
    }
    // Prime frame 0 (and its window) so first paint is fast.
    this.prefetchWindow(0);
  }

  /** Register a callback for when a background-decoded frame becomes available. */
  setOnFrameReady(callback: (frame: Frame) => void): void {
    this.onFrameReady = callback;
  }

  /** Register a callback for a frame's embedded vector channels (LAMMPS velocity/force). */
  setOnVectors(
    callback: (frameId: number, vectors: Float32Array, channelCount: number) => void,
  ): void {
    this.onVectors = callback;
  }

  /** Register a decode-progress callback: (distinct frames decoded, total). */
  setOnProgress(callback: (decoded: number, total: number) => void): void {
    this.onProgress = callback;
  }

  /** Number of distinct frames decoded so far (monotonic high-water mark). */
  decodedCount(): number {
    return this.decodedCountHW;
  }

  /**
   * Get a frame by index. Returns the cached frame (or the synchronous base
   * frame 0), or null while it (and a window ahead) decode in the background —
   * the frame then arrives via `onFrameReady`.
   */
  getFrame(index: number): Frame | null {
    if (index === 0 && this.basePositions) {
      return { frameId: 0, nAtoms: this.nAtoms, positions: this.basePositions };
    }
    this.prefetchWindow(index);
    return this.cache.get(index) ?? null;
  }

  /** Free the worker decoder and drop the cache. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeFn(this.trajectoryId);
    this.clear();
  }

  clear(): void {
    this.cache.clear();
    this.cacheOrder = [];
    this.inflight.clear();
  }

  /** Request frame `center` and the next `prefetchAhead` frames. */
  private prefetchWindow(center: number): void {
    const end = Math.min(center + this.prefetchAhead, this.nFrames - 1);
    for (let f = center; f <= end; f++) this.request(f);
  }

  private request(providerIndex: number): void {
    if (this.disposed) return;
    if (providerIndex < 0 || providerIndex >= this.nFrames) return;
    // The synthetic base frame 0 needs no decode.
    if (providerIndex === 0 && this.basePositions) return;
    if (this.cache.has(providerIndex) || this.inflight.has(providerIndex)) return;
    const fileFrame = providerIndex - this.baseOffset;
    if (fileFrame < 0 || fileFrame >= this.decodableFrames) return;
    this.inflight.add(providerIndex);
    this.decode(this.trajectoryId, fileFrame)
      .then((decoded) => {
        this.inflight.delete(providerIndex);
        if (this.disposed) return;
        const frame: Frame = {
          frameId: providerIndex,
          nAtoms: this.nAtoms,
          positions: decoded.positions,
        };
        const isNew = !this.cache.has(providerIndex);
        this.cacheFrame(frame);
        if (isNew) {
          this.decodedCountHW += 1;
          this.onProgress?.(this.decodedCountHW, this.nFrames);
        }
        this.onFrameReady?.(frame);
        if (decoded.vectors && decoded.vectors.length > 0) {
          this.onVectors?.(providerIndex, decoded.vectors, decoded.vectorChannelCount);
        }
      })
      .catch(() => {
        // Leave the frame undecoded (getFrame keeps returning null → the viewer
        // holds the last frame). The owner may retry on the next getFrame.
        this.inflight.delete(providerIndex);
      });
  }

  private cacheFrame(frame: Frame): void {
    const id = frame.frameId;
    if (this.cache.has(id)) {
      this.cacheOrder = this.cacheOrder.filter((i) => i !== id);
      this.cacheOrder.push(id);
      this.cache.set(id, frame);
      return;
    }
    while (this.cacheOrder.length >= this.maxCacheSize) {
      const evicted = this.cacheOrder.shift();
      if (evicted !== undefined) this.cache.delete(evicted);
    }
    this.cache.set(id, frame);
    this.cacheOrder.push(id);
  }
}
