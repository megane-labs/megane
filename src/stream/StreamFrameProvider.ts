/**
 * WebSocket-based frame provider for streaming trajectory playback.
 * Fetches frames on-demand via the `request_frame` WebSocket command
 * and caches recently accessed frames in an LRU cache.
 *
 * Designed to work with an external WebSocketClient - does not create
 * its own WebSocket connection. The owning hook (useMeganeWebSocket)
 * feeds received frames via `receiveFrame()` and sends requests via
 * the shared client.
 */

import type { Frame, TrajectoryMeta } from "../types";
import type { FrameProvider } from "../pipeline/types";
import type { WebSocketClient } from "./WebSocketClient";
import { frameCacheCapacity } from "./frameCacheCapacity";

const DEFAULT_CACHE_SIZE = 128;

export class StreamFrameProvider implements FrameProvider {
  readonly kind = "stream" as const;
  meta: TrajectoryMeta;

  private client: WebSocketClient;
  private cache: Map<number, Frame> = new Map();
  private cacheOrder: number[] = [];
  private maxCacheSize: number;
  private onFrameReady: ((frame: Frame) => void) | null = null;

  /**
   * `maxCacheSize` caps the cache in frames; it is capped in bytes too (see
   * `frameCacheCapacity`), so a large system keeps fewer frames.
   */
  constructor(
    client: WebSocketClient,
    meta: TrajectoryMeta,
    maxCacheSize = DEFAULT_CACHE_SIZE,
    maxCacheBytes?: number,
  ) {
    this.client = client;
    this.meta = meta;
    this.maxCacheSize = frameCacheCapacity(meta.nAtoms, maxCacheSize, maxCacheBytes);
  }

  /** Register a callback for when an async frame arrives. */
  setOnFrameReady(callback: (frame: Frame) => void): void {
    this.onFrameReady = callback;
  }

  /** Get a frame by index. Returns cached frame or null (async fetch). */
  getFrame(index: number): Frame | null {
    const cached = this.cache.get(index);
    if (cached) return cached;

    // Request frame from server via shared WebSocket client
    this.client.send({ type: "request_frame", frame: index });
    return null;
  }

  /** Called by the owning hook when a frame is received from WebSocket. */
  receiveFrame(frame: Frame): void {
    this.cacheFrame(frame);
    this.onFrameReady?.(frame);
  }

  /** Clear the frame cache. */
  clear(): void {
    this.cache.clear();
    this.cacheOrder = [];
  }

  /** Add a frame to the LRU cache. */
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
      if (evicted !== undefined) {
        this.cache.delete(evicted);
      }
    }

    this.cache.set(id, frame);
    this.cacheOrder.push(id);
  }
}
