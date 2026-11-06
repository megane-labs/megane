/**
 * Simple worker pool for parallel binary decoding.
 *
 * The decode worker is inlined (`?worker&inline`, a blob: script inside the
 * bundle). This class ships in the npm library, and a worker emitted as a
 * file beside `dist/lib.js` was requested from the root of whatever app
 * installed the package (`/assets/decode.worker-….js`), where it does not
 * exist: every decode waited for its timeout.
 */

import type { WorkerResponse } from "./decode.worker";
import DecodeWorker from "./decode.worker?worker&inline";

type PendingResolve = (response: WorkerResponse) => void;
type PendingReject = (error: Error) => void;

interface PendingEntry {
  resolve: PendingResolve;
  reject: PendingReject;
  timer: ReturnType<typeof setTimeout>;
  /** The worker the request went to. */
  worker: Worker;
}

export class WorkerPool {
  private workers: Worker[];
  private pending = new Map<number, PendingEntry>();
  private nextId = 0;
  private robin = 0;

  constructor(size: number = Math.min(navigator.hardwareConcurrency || 2, 4)) {
    this.workers = Array.from({ length: size }, () => {
      const w = new DecodeWorker();
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const entry = this.pending.get(e.data.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(e.data.id);
          entry.resolve(e.data);
        }
      };
      // A worker that cannot start, or crashes, fails its requests now rather
      // than at their timeout, and leaves the pool.
      w.onerror = (e: ErrorEvent) =>
        this.drop(w, e.message ? `Decode worker failed: ${e.message}` : "Decode worker failed.");
      return w;
    });
  }

  /** Send a buffer to a worker for decoding. Returns decoded response. */
  decode(buffer: ArrayBuffer, timeoutMs: number = 10_000): Promise<WorkerResponse> {
    if (this.workers.length === 0) {
      return Promise.reject(new Error("No decode worker is running."));
    }
    const id = this.nextId++;
    const worker = this.workers[this.robin % this.workers.length];
    this.robin++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker decode timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, worker });
      worker.postMessage({ id, type: "decode", buffer }, [buffer]);
    });
  }

  /** Reject the requests sent to `worker` and take it out of the pool. */
  private drop(worker: Worker, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.worker !== worker) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(reason));
    }
    worker.terminate();
    this.workers = this.workers.filter((w) => w !== worker);
  }

  /** Terminate the workers; decodes still in flight are rejected. */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("The worker pool was disposed."));
    }
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.pending.clear();
  }
}
