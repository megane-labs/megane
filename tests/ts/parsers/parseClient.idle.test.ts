/**
 * The parse worker is released after WORKER_IDLE_MS with nothing to do.
 *
 * WASM memory only grows, so a worker that parsed a large file keeps that
 * high-water mark until it is terminated. parseClient terminates it once no
 * request is in flight and no lazy decoder (which keeps the file bytes in the
 * worker) is alive, and starts a fresh worker on the next request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { workers, FakeWorker } = vi.hoisted(() => {
  const workers: { terminated: boolean; ops: string[] }[] = [];
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    state = { terminated: false, ops: [] as string[] };
    constructor() {
      workers.push(this.state);
    }
    postMessage(req: { id: number; op: string }) {
      this.state.ops.push(req.op);
      const result =
        req.op === "indexTrajectory"
          ? { nAtoms: 4, nFrames: 3 }
          : req.op === "indexStructure"
            ? { index: { nAtoms: 3, nFrames: 2 }, frame0: { tag: "frame0" } }
            : { tag: "worker" };
      queueMicrotask(() =>
        this.onmessage?.({ data: { id: req.id, ok: true, op: req.op, result } }),
      );
    }
    terminate() {
      this.state.terminated = true;
    }
  }
  return { workers, FakeWorker };
});

vi.mock("@/parsers/parse.worker?worker", () => ({ default: FakeWorker }));

function fakeFile(name: string): File {
  return {
    name,
    size: 3,
    text: async () => "DATA\n",
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as File;
}

async function freshClient() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  return import("@/parsers/parseClient");
}

describe("parse worker idle release", () => {
  beforeEach(() => {
    workers.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates the worker once it has been idle for WORKER_IDLE_MS", async () => {
    const client = await freshClient();
    await client.parseStructureFile(fakeFile("a.pdb"));
    expect(workers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS - 1);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].terminated).toBe(true);
  });

  it("starts a fresh worker for the next request after a release", async () => {
    const client = await freshClient();
    await client.parseStructureFile(fakeFile("a.pdb"));
    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS);

    expect(await client.parseStructureFile(fakeFile("b.pdb"))).toEqual({ tag: "worker" });
    expect(workers).toHaveLength(2);
    expect(workers[1].terminated).toBe(false);
    // A release is not a failure: streaming stays available.
    expect(client.shouldUseLazyTrajectory("xtc", 64 * 1024 * 1024)).toBe(true);
  });

  it("restarts the idle clock on every request", async () => {
    const client = await freshClient();
    await client.parseStructureFile(fakeFile("a.pdb"));
    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS - 10);
    await client.parseStructureFile(fakeFile("b.pdb"));
    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS - 10);

    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
  });

  it("keeps the worker while a lazy trajectory decoder is alive", async () => {
    const client = await freshClient();
    const handle = await client.indexTrajectoryLazy(fakeFile("t.xtc"), "xtc", 4);
    expect(handle).not.toBeNull();

    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS * 3);
    expect(workers[0].terminated).toBe(false);

    client.disposeTrajectoryLazy(handle!.trajectoryId);
    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS);
    expect(workers[0].ops).toContain("disposeTrajectory");
    expect(workers[0].terminated).toBe(true);
  });

  it("keeps the worker while a lazy structure decoder is alive", async () => {
    const client = await freshClient();
    const res = await client.indexStructureLazy(fakeFile("m.xyz"), "xyz");
    expect(res).not.toBeNull();

    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS * 3);
    expect(workers[0].terminated).toBe(false);

    client.disposeTrajectoryLazy(res!.handle.trajectoryId);
    await vi.advanceTimersByTimeAsync(client.WORKER_IDLE_MS);
    expect(workers[0].terminated).toBe(true);
  });
});
