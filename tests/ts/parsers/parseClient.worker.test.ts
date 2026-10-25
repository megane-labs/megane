/**
 * Unit tests for parseClient's Web Worker path.
 *
 * jsdom has no real Worker, so we install a fake Worker (both as the mocked
 * `?worker` import and as `globalThis.Worker`) that echoes a canned
 * response. This exercises getWorker / send / resolveWasmUrl / onmessage and
 * the error → tearDown → synchronous-fallback branch that the plain fallback
 * test cannot reach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { state, FakeWorker } = vi.hoisted(() => {
  const state = {
    mode: "ok" as "ok" | "err" | "crash",
    lastReq: null as { id: number; op: string } | null,
    reqs: [] as { id: number; op: string; wasm?: unknown }[],
    created: 0,
    posted: 0,
    throwOnCreate: false,
    result: null as unknown,
    /** WASM heap size the fake worker stamps on ok responses, when set. */
    wasmBytes: undefined as number | undefined,
  };
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      if (state.throwOnCreate) throw new Error("worker blocked");
      state.created++;
    }
    postMessage(req: { id: number; op: string }) {
      state.lastReq = req;
      state.reqs.push(req);
      state.posted++;
      queueMicrotask(() => {
        if (state.mode === "crash") {
          this.onerror?.();
        } else if (state.mode === "ok") {
          this.onmessage?.({
            data: {
              id: req.id,
              ok: true,
              op: req.op,
              result: state.result ?? { tag: "worker" },
              wasmBytes: state.wasmBytes,
            },
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
    state.reqs = [];
    state.created = 0;
    state.posted = 0;
    state.throwOnCreate = false;
    state.result = null;
    vi.clearAllMocks();
  });

  it("splits the labels a structure result carries as text", async () => {
    const client = await freshClient();
    state.result = { labels: null, labelsText: "HOH1\nHOH1\nNA2" };
    const out = (await client.parseStructureFile(fakeFile("x.pdb"))) as unknown as {
      labels: string[];
      labelsText?: string;
    };
    expect(out.labels).toEqual(["HOH1", "HOH1", "NA2"]);
    expect(out.labelsText).toBeUndefined();
  });

  it("splits the labels of an indexed structure's frame 0", async () => {
    const client = await freshClient();
    state.result = { index: { nFrames: 1 }, frame0: { labels: null, labelsText: "A\nB" } };
    const out = (await client.parseStructureText("ATOM", "x.pdb")) as unknown as {
      frame0: { labels: string[] };
    };
    expect(out.frame0.labels).toEqual(["A", "B"]);
  });

  it("resolves a structure parse via the worker", async () => {
    const client = await freshClient();
    const out = await client.parseStructureFile(fakeFile("x.pdb"));
    expect(out).toEqual({ tag: "worker" });
    expect(state.lastReq?.op).toBe("structure");
  });

  it("posts a picked file as itself and a host-held file's bytes", async () => {
    const client = await freshClient();
    const { fileFromBytes } = await import("@/parsers/fileBytes");
    const picked = fakeFile("x.gro");
    await client.parseStructureFile(picked);
    const req1 = state.lastReq as unknown as { ext: string; file?: unknown; text?: unknown };
    expect(req1.ext).toBe(".gro");
    expect(req1.file).toBe(picked);
    expect(req1.text).toBeUndefined();

    await client.parseStructureFile(fileFromBytes(new Uint8Array([1, 2, 3]), "y.pdb"));
    const req2 = state.lastReq as unknown as { bytes?: ArrayBuffer; file?: unknown };
    expect(new Uint8Array(req2.bytes!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(req2.file).toBeUndefined();
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

  it("builds a lazy XTC handle from the File, without reading it on the main thread", async () => {
    const client = await freshClient();
    const file = fakeFile("t.xtc");
    const res = await client.indexTrajectoryLazy(file, "xtc", 4);
    expect(state.lastReq?.op).toBe("indexTrajectoryFile");
    expect((state.lastReq as { file?: unknown }).file).toBe(file);
    expect(res?.kind).toBe("xtc");
    expect(typeof res?.trajectoryId).toBe("number");
  });

  it("builds a lazy LAMMPS-dump handle from the File itself", async () => {
    const client = await freshClient();
    const file = fakeFile("t.lammpstrj");
    const res = await client.indexTrajectoryLazy(file, "lammpstrj", 4);
    expect(state.lastReq).toMatchObject({ op: "indexTrajectoryFile", kind: "lammpstrj" });
    expect((state.lastReq as { file?: unknown }).file).toBe(file);
    expect(res?.kind).toBe("lammpstrj");
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
    const file = fakeFile("m.xyz");
    const res = await client.indexStructureLazy(file, "xyz");
    expect(state.lastReq?.op).toBe("indexStructure");
    expect((state.lastReq as { file?: unknown; bytes?: unknown }).file).toBe(file);
    expect((state.lastReq as { bytes?: unknown }).bytes).toBeUndefined();
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

  it("parseStructureHead reads an ASE .traj's frame 0 from head and tail in the worker", async () => {
    const client = await freshClient();
    const head = new Uint8Array([1, 2, 3]);
    const tail = new Uint8Array([9]);
    const result = await client.parseStructureHead(head, tail, 100, "traj");
    expect(result).toEqual({ tag: "worker" });
    expect(state.lastReq).toMatchObject({ op: "trajFrame0", totalSize: 100 });
    const req = state.lastReq as unknown as { head: ArrayBuffer; tail: ArrayBuffer };
    expect(new Uint8Array(req.head)).toEqual(head);
    expect(new Uint8Array(req.tail)).toEqual(tail);
    // The caller's own chunks are copied, never transferred away.
    expect(head.byteLength).toBe(3);
  });

  it("parses a .traj's frame 0 from its head and the tail holding the offset table", async () => {
    const client = await freshClient();
    const MiB = 1024 * 1024;
    const slice = vi.fn((start: number) => ({
      arrayBuffer: async () => new Uint8Array([start === 0 ? 1 : 2]).buffer,
    }));
    const file = { name: "big.traj", size: 32 * MiB, slice } as unknown as File;
    expect(await client.parseStructurePrefix(file, "traj")).toEqual({ tag: "worker" });
    expect(state.lastReq).toMatchObject({ op: "trajFrame0", totalSize: 32 * MiB });
    expect(slice.mock.calls.map((c) => c[0])).toEqual([0, 31 * MiB]);
    const req = state.lastReq as unknown as { head: ArrayBuffer; tail: ArrayBuffer };
    expect(new Uint8Array(req.head)).toEqual(new Uint8Array([1]));
    expect(new Uint8Array(req.tail)).toEqual(new Uint8Array([2]));
  });

  it("indexes a .traj in the worker from the File itself", async () => {
    const client = await freshClient();
    state.result = { index: { nAtoms: 3, nFrames: 4, heterogeneous: false }, frame0: {} };
    const file = fakeFile("run.traj", 100);
    const res = await client.indexStructureLazy(file, "traj");
    expect(state.lastReq).toMatchObject({ op: "indexStructure", kind: "traj", file });
    expect(res?.handle).toMatchObject({ kind: "traj", index: { nFrames: 4 } });
  });

  it("parseStructureHead stitches a PDB head to its CONECT tail, trimming cut lines", async () => {
    const client = await freshClient();
    const enc = (s: string) => new TextEncoder().encode(s);
    await client.parseStructureHead(
      enc("ATOM 1\nATOM 2\nATO"),
      enc("NDMDL\nCONECT 1 2\n"),
      999,
      "pdb",
    );
    expect(state.lastReq).toMatchObject({
      op: "structurePrefix",
      kind: "pdb",
      text: "ATOM 1\nATOM 2\nCONECT 1 2\n",
      isWholeFile: false,
    });
  });

  it("parseStructureHead ignores the tail for XYZ and passes a whole-file head as is", async () => {
    const client = await freshClient();
    const enc = (s: string) => new TextEncoder().encode(s);
    await client.parseStructureHead(enc("3\nc\nC 0 0 0"), enc("tail"), 11, "xyz");
    expect(state.lastReq).toMatchObject({
      op: "structurePrefix",
      kind: "xyz",
      text: "3\nc\nC 0 0 0",
      isWholeFile: true,
    });
  });

  it("parseStructureHead returns null when the chunks do not hold frame 0", async () => {
    const client = await freshClient();
    state.mode = "err";
    expect(
      await client.parseStructureHead(new Uint8Array(1), new Uint8Array(1), 50, "traj"),
    ).toBeNull();
  });

  it("prewarmParseWorker starts the worker with an init request carrying the WASM URL", async () => {
    const client = await freshClient();
    const url = `${location.origin}/assets/megane.wasm`;
    (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__ = url;
    try {
      client.prewarmParseWorker();
      expect(state.created).toBe(1);
      // Same-origin: the worker fetches the URL itself, posted at once.
      expect(state.lastReq).toMatchObject({ op: "init", wasm: url });
      // The worker that compiled the module is the one the next parse uses.
      await client.parseStructureFile(fakeFile("a.pdb"));
      expect(state.created).toBe(1);
    } finally {
      delete (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__;
    }
  });

  it("prewarmParseWorker swallows a failed init", async () => {
    const client = await freshClient();
    state.mode = "err";
    expect(() => client.prewarmParseWorker()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(state.posted).toBe(1);
  });

  it("prewarmParseWorker leaves a worker that cannot be constructed to the next parse", async () => {
    const client = await freshClient();
    state.throwOnCreate = true;
    expect(() => client.prewarmParseWorker()).not.toThrow();
    expect(state.posted).toBe(0);
  });

  it("parserHeapBytes reports the heap size the worker last stamped", async () => {
    const client = await freshClient();
    expect(client.parserHeapBytes()).toBe(0);
    state.wasmBytes = 3 * 65536;
    await client.parseStructureFile(fakeFile("a.pdb"));
    expect(client.parserHeapBytes()).toBe(3 * 65536);
    // A response without a stamp leaves the last figure in place.
    state.wasmBytes = undefined;
    await client.parseStructureFile(fakeFile("b.pdb"));
    expect(client.parserHeapBytes()).toBe(3 * 65536);
  });

  it("parserHeapBytes drops the worker's heap once it crashes", async () => {
    const client = await freshClient();
    state.wasmBytes = 65536;
    await client.parseStructureFile(fakeFile("a.pdb"));
    state.mode = "crash";
    await client.parseStructureFile(fakeFile("b.pdb"));
    expect(client.parserHeapBytes()).toBe(0);
  });

  it("prewarmParseWorker does nothing once the worker has crashed", async () => {
    const client = await freshClient();
    state.mode = "crash";
    await client.parseStructureFile(fakeFile("a.pdb"));
    const posted = state.posted;
    client.prewarmParseWorker();
    expect(state.posted).toBe(posted);
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

  describe("a WASM URL on another origin (VS Code webview)", () => {
    const url = "https://res.example/media/megane_wasm_bg.wasm";
    const module = { tag: "compiled" } as unknown as WebAssembly.Module;

    function stubWasm(fetchImpl: () => Promise<unknown>, compile = vi.fn(async () => module)) {
      vi.stubGlobal("fetch", vi.fn(fetchImpl));
      vi.spyOn(WebAssembly, "compile").mockImplementation(compile);
      (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__ = url;
      return compile;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete (globalThis as Record<string, unknown>).__MEGANE_WASM_URL__;
    });

    it("compiles the module on the page once and hands it to the worker, in order", async () => {
      const compile = stubWasm(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      }));
      const client = await freshClient();
      client.prewarmParseWorker();
      // Nothing reaches the worker before the module is ready.
      expect(state.posted).toBe(0);
      const out = await client.parseStructureFile(fakeFile("a.pdb"));
      expect(out).toEqual({ tag: "worker" });
      await client.parseStructureFile(fakeFile("b.pdb"));
      expect(state.reqs.map((r) => r.op)).toEqual(["init", "structure", "structure"]);
      expect(state.reqs.every((r) => r.wasm === module)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(url);
      expect(compile).toHaveBeenCalledTimes(1);
    });

    it("queues requests without a WASM field behind the module too", async () => {
      stubWasm(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
      const client = await freshClient();
      client.prewarmParseWorker();
      client.disposeTrajectoryLazy(5);
      expect(state.posted).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      expect(state.reqs.map((r) => r.op)).toEqual(["init", "disposeTrajectory"]);
      expect(state.reqs[1].wasm).toBeUndefined();
    });

    it("falls back to the main thread when the module cannot be fetched", async () => {
      stubWasm(async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      }));
      const client = await freshClient();
      expect(await client.parseStructureFile(fakeFile("a.pdb"))).toEqual({ tag: "sync" });
      expect(state.posted).toBe(0);
    });

    it("falls back to the main thread when the module does not compile", async () => {
      stubWasm(
        async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
        vi.fn(async () => {
          throw new Error("bad wasm");
        }),
      );
      const client = await freshClient();
      expect(await client.parseStructureFile(fakeFile("a.pdb"))).toEqual({ tag: "sync" });
      expect(state.posted).toBe(0);
    });
  });
});

describe("isCrossOriginWasm", () => {
  it("tells the page's own URLs from another origin's", async () => {
    const { isCrossOriginWasm } = await import("@/parsers/parseClient");
    const page = "http://localhost:5173/index.html";
    expect(isCrossOriginWasm("/assets/a.wasm", page)).toBe(false);
    expect(isCrossOriginWasm("http://localhost:5173/a.wasm", page)).toBe(false);
    expect(isCrossOriginWasm("https://cdn.example/a.wasm", page)).toBe(true);
    expect(isCrossOriginWasm("blob:http://localhost:5173/x", page)).toBe(false);
    expect(isCrossOriginWasm("data:application/wasm;base64,AA==", page)).toBe(false);
  });

  it("treats every http(s) URL as foreign to an opaque-origin webview page", async () => {
    const { isCrossOriginWasm } = await import("@/parsers/parseClient");
    const page = "vscode-webview://abc/index.html?id=1";
    expect(isCrossOriginWasm("https://x.vscode-resource.vscode-cdn.net/m.wasm", page)).toBe(true);
  });

  it("is false without a page URL or for an unparsable URL", async () => {
    const { isCrossOriginWasm } = await import("@/parsers/parseClient");
    expect(isCrossOriginWasm("https://cdn.example/a.wasm", undefined)).toBe(false);
    expect(isCrossOriginWasm("http://[bad", "http://localhost/")).toBe(false);
  });
});
