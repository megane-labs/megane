/**
 * The npm library's `WorkerPool`: requests go round-robin to (fake) decode
 * workers, a silent worker times out, a worker that fails to start or crashes
 * rejects its requests at once and leaves the pool, and dispose settles
 * whatever is still in flight.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { state, FakeWorker } = vi.hoisted(() => {
  const state = {
    answer: true,
    workers: [] as InstanceType<typeof FakeWorker>[],
  };
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    posted: { message: { id: number }; transfer: Transferable[] }[] = [];
    terminated = false;
    constructor() {
      state.workers.push(this);
    }
    postMessage(message: { id: number }, transfer: Transferable[]) {
      this.posted.push({ message, transfer });
      if (state.answer) {
        queueMicrotask(() =>
          this.onmessage?.({ data: { id: message.id, type: "snapshot", from: this } }),
        );
      }
    }
    terminate() {
      this.terminated = true;
    }
  }
  return { state, FakeWorker };
});

vi.mock("@/protocol/decode.worker?worker&inline", () => ({ default: FakeWorker }));

import { WorkerPool } from "@/protocol/WorkerPool";

beforeEach(() => {
  state.answer = true;
  state.workers = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerPool", () => {
  it("decodes round-robin across its workers, transferring each buffer", async () => {
    const pool = new WorkerPool(2);
    expect(state.workers).toHaveLength(2);
    const buffers = [new ArrayBuffer(4), new ArrayBuffer(4), new ArrayBuffer(4)];
    const answers = await Promise.all(buffers.map((b) => pool.decode(b)));
    expect(answers.map((a) => (a as unknown as { from: unknown }).from)).toEqual([
      state.workers[0],
      state.workers[1],
      state.workers[0],
    ]);
    expect(state.workers[0].posted[0].transfer).toEqual([buffers[0]]);
    expect(state.workers[0].posted[0].message).toMatchObject({ id: 0, type: "decode" });
    pool.dispose();
  });

  it("times out a request the worker never answers", async () => {
    vi.useFakeTimers();
    state.answer = false;
    const pool = new WorkerPool(1);
    const p = pool.decode(new ArrayBuffer(4), 500).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(501);
    expect(await p).toBe("Worker decode timed out after 500ms");
    pool.dispose();
  });

  it("rejects a failed worker's requests at once and stops sending it more", async () => {
    state.answer = false;
    const pool = new WorkerPool(2);
    const [a, b] = state.workers;
    const onA = pool.decode(new ArrayBuffer(4)).catch((e: Error) => e.message);
    const onB = pool.decode(new ArrayBuffer(4));
    a.onerror!(new ErrorEvent("error", { message: "SecurityError: blocked" }));
    expect(await onA).toBe("Decode worker failed: SecurityError: blocked");
    expect(a.terminated).toBe(true);
    // B's request is untouched; new requests go to B only.
    pool.decode(new ArrayBuffer(4)).catch(() => undefined);
    expect(b.posted).toHaveLength(2);
    expect(a.posted).toHaveLength(1);
    // Once every worker has failed, a decode is refused without waiting.
    b.onerror!(new ErrorEvent("error"));
    await expect(onB).rejects.toThrow("Decode worker failed.");
    await expect(pool.decode(new ArrayBuffer(4))).rejects.toThrow("No decode worker is running.");
  });

  it("dispose terminates the workers and rejects decodes in flight", async () => {
    state.answer = false;
    const pool = new WorkerPool(1);
    const p = pool.decode(new ArrayBuffer(4));
    pool.dispose();
    await expect(p).rejects.toThrow("The worker pool was disposed.");
    expect(state.workers[0].terminated).toBe(true);
    await expect(pool.decode(new ArrayBuffer(4))).rejects.toThrow("No decode worker is running.");
  });

  it("sizes itself from the hardware concurrency, at most four", () => {
    new WorkerPool().dispose();
    expect(state.workers.length).toBe(Math.min(navigator.hardwareConcurrency || 2, 4));
  });
});
