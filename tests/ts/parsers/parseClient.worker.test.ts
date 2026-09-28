/**
 * Unit tests for parseClient's Web Worker path.
 *
 * jsdom has no real Worker, so we install a fake Worker (both as the mocked
 * `?worker` import and as `globalThis.Worker`) that echoes a canned
 * response. This exercises getWorker / send / resolveWasmUrl / onmessage and
 * the error → tearDown → synchronous-fallback branch that the plain fallback
 * test cannot reach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, FakeWorker } = vi.hoisted(() => {
  const state = {
    mode: "ok" as "ok" | "err" | "crash",
    lastReq: null as { id: number; op: string } | null,
    created: 0,
    posted: 0,
  };
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      state.created++;
    }
    postMessage(req: { id: number; op: string }) {
      state.lastReq = req;
      state.posted++;
      queueMicrotask(() => {
        if (state.mode === "crash") {
          this.onerror?.();
        } else if (state.mode === "ok") {
          this.onmessage?.({
            data: { id: req.id, ok: true, op: req.op, result: { tag: "worker" } },
          });
        } else {
          this.onmessage?.({ data: { id: req.id, ok: false, op: req.op, error: "boom" } });
        }
      });
    }
    terminate() {}
  }
  return { state, FakeWorker };
});

vi.mock("@/parsers/parse.worker?worker", () => ({ default: FakeWorker }));
vi.mock("@/parsers/parseClientSync", () => ({
  parseStructureFile: vi.fn(async () => ({ tag: "sync" })),
  parseStructureText: vi.fn(async () => ({ tag: "sync" })),
  parseXTCFile: vi.fn(async () => ({ tag: "sync" })),
  parseDCDFile: vi.fn(async () => ({ tag: "sync" })),
  parseLammpstrjFile: vi.fn(async () => ({ tag: "sync" })),
  parseNetCDFFile: vi.fn(async () => ({ tag: "sync" })),
  indexStructureLazy: vi.fn(async () => null),
}));

function fakeFile(name: string, size = 3): File {
  return {
    name,
    size,
    text: async () => "DATA\n",
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    slice: () => ({
      text: async () => "DATA\n",
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }),
  } as unknown as File;
}

// Fresh parseClient module (and its worker/workerBroken state) per test.
async function freshClient() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  return import("@/parsers/parseClient");
}

describe("parseClient worker path", () => {
  beforeEach(() => {
    state.mode = "ok";
    state.lastReq = null;
    state.created = 0;
    state.posted = 0;
    vi.clearAllMocks();
  });

  it("resolves a structure parse via the worker", async () => {
    const client = await freshClient();
    const out = await client.parseStructureFile(fakeFile("x.pdb"));
    expect(out).toEqual({ tag: "worker" });
    expect(state.lastReq?.op).toBe("structure");
  });

  it("sends .traj bytes through the worker", async () => {
    const client = await freshClient();
    await client.parseStructureFile(fakeFile("m.traj"));
    expect(state.lastReq?.op).toBe("structure");
  });

  it("resolves each trajectory format via the worker", async () => {
    const client = await freshClient();
    expect(await client.parseXTCFile(fakeFile("t.xtc"), 4)).toEqual({ tag: "worker" });
    expect(await client.parseDCDFile(fakeFile("t.dcd"), 4)).toEqual({ tag: "worker" });
    expect(await client.parseNetCDFFile(fakeFile("t.nc"), 4)).toEqual({ tag: "worker" });
    expect(await client.parseLammpstrjFile(fakeFile("t.lammpstrj"), 4)).toEqual({ tag: "worker" });
  });

  it("parseStructureText resolves via the worker", async () => {
    const client = await freshClient();
    expect(await client.parseStructureText("ATOM", "x.pdb")).toEqual({ tag: "worker" });
  });

  it("falls back to sync when the worker returns an error", async () => {
    const client = await freshClient();
    const sync = await import("@/parsers/parseClientSync");
    state.mode = "err";
    const out = await client.parseStructureFile(fakeFile("x.pdb"));
    expect(out).toEqual({ tag: "sync" });
    expect(sync.parseStructureFile).toHaveBeenCalled();
  });

  it("falls back to sync for trajectories when the worker errors", async () => {
    const client = await freshClient();
    const sync = await import("@/parsers/parseClientSync");
    state.mode = "err";
    const out = await client.parseXTCFile(fakeFile("t.xtc"), 4);
    expect(out).toEqual({ tag: "sync" });
    expect(sync.parseXTCFile).toHaveBeenCalled();
  });

  it("builds a lazy trajectory handle via the worker", async () => {
    const client = await freshClient();
    const res = await client.indexTrajectoryLazy(fakeFile("t.xtc"), "xtc", 4);
    expect(state.lastReq?.op).toBe("indexTrajectory");
    expect(res?.kind).toBe("xtc");
    expect(typeof res?.trajectoryId).toBe("number");
  });

  it("returns null (full-read fallback) when trajectory indexing errors", async () => {
    const client = await freshClient();
    state.mode = "err";
    expect(await client.indexTrajectoryLazy(fakeFile("t.xtc"), "xtc", 4)).toBeNull();
  });

  it("decodes frame 0 from a bounded prefix via the worker", async () => {
    const client = await freshClient();
    await client.decodeTrajectoryFrame0(fakeFile("t.xtc"), "xtc", 4);
    expect(state.lastReq?.op).toBe("trajectoryFrame0");
  });

  it("returns null when the frame-0 prefix decode errors and can't grow", async () => {
    const client = await freshClient();
    state.mode = "err";
    // size <= prefix so the read is already whole-file → no retry, straight to null.
    expect(await client.decodeTrajectoryFrame0(fakeFile("t.xtc", 3), "xtc", 4)).toBeNull();
  });

  it("builds a lazy structure handle (with frame 0) via the worker in one round-trip", async () => {
    const client = await freshClient();
    const res = await client.indexStructureLazy(fakeFile("m.xyz"), "xyz");
    expect(state.lastReq?.op).toBe("indexStructure");
    expect(res?.handle.kind).toBe("xyz");
    expect(typeof res?.handle.trajectoryId).toBe("number");
  });

  it("returns null (eager fallback) when structure indexing errors", async () => {
    const client = await freshClient();
    state.mode = "err";
    expect(await client.indexStructureLazy(fakeFile("m.xyz"), "xyz")).toBeNull();
  });

  it("parses frame 0 from a prefix via the worker", async () => {
    const client = await freshClient();
    const out = await client.parseStructurePrefix(fakeFile("m.xyz", 100), "xyz");
    expect(out).toEqual({ tag: "worker" });
    expect(state.lastReq?.op).toBe("structurePrefix");
  });

  it("returns null when the prefix parse errors and the prefix can't grow", async () => {
    const client = await freshClient();
    state.mode = "err";
    // size <= prefix so isWholeFile is true → no retry, straight to null.
    expect(await client.parseStructurePrefix(fakeFile("m.xyz", 3), "xyz")).toBeNull();
  });

  it("reads a tail chunk for a large PDB (to capture CONECT) but not for XYZ", async () => {
    const client = await freshClient();
    const bigFile = (name: string) => {
      const slice = vi.fn(() => ({ text: async () => "L1\nL2\n" }));
      const file = {
        name,
        size: 32 * 1024 * 1024, // larger than the 8MB prefix → head + tail
        text: async () => "L1\nL2\n",
        arrayBuffer: async () => new ArrayBuffer(0),
        slice,
      } as unknown as File;
      return { file, slice };
    };

    const pdb = bigFile("big.pdb");
    await client.parseStructurePrefix(pdb.file, "pdb");
    expect(pdb.slice).toHaveBeenCalledTimes(2); // head + CONECT tail

    const xyz = bigFile("big.xyz");
    await client.parseStructurePrefix(xyz.file, "xyz");
    expect(xyz.slice).toHaveBeenCalledTimes(1); // head only
  });

  it("gives up growing a prefix once the worker crashes, without starting another", async () => {
    const client = await freshClient();
    state.mode = "crash";
    // Large enough that the prefix could double several times.
    const big = fakeFile("big.xtc", 64 * 1024 * 1024);
    expect(await client.decodeTrajectoryFrame0(big, "xtc", 3)).toBeNull();
    expect(
      await client.parseStructurePrefix(fakeFile("big.xyz", 64 * 1024 * 1024), "xyz"),
    ).toBeNull();
    expect(state.created).toBe(1);
    expect(state.posted).toBe(1);
  });
});
