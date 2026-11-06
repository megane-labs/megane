/**
 * The RDKit embedding client: requests go through a (fake) Web Worker, the
 * first conformer of the answer becomes an `EmbeddedSketch`, RDKit errors
 * come back as rejections, and a crashed or silent worker is torn down so
 * the next call starts a new one. A `.wasm` on another origin than the page
 * (a VS Code webview's resource URL) is fetched by the page and reaches the
 * worker as a `blob:` URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { state, FakeWorker } = vi.hoisted(() => {
  const state = {
    mode: "ok" as "ok" | "error" | "silent" | "crash" | "crash-message" | "unreadable",
    wasmAsset: "/assets/megane-rdkit.wasm",
    requests: [] as { id: number; wasmUrl: string; molfile: string; options: unknown }[],
    created: 0,
    terminated: 0,
    last: null as null | { onmessage: ((e: { data: unknown }) => void) | null },
  };
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessageerror: ((e: unknown) => void) | null = null;
    constructor() {
      state.created++;
      state.last = this;
    }
    postMessage(req: { id: number; wasmUrl: string; molfile: string; options: unknown }) {
      state.requests.push(req);
      queueMicrotask(() => {
        if (state.mode === "ok") {
          this.onmessage?.({
            data: {
              id: req.id,
              ok: true,
              version: "2026.03.6",
              result: {
                molblocks: ["MOLBLOCK-3D"],
                energies: [-12.5],
                converged: [true],
                forceField: "MMFF94s",
                numAtoms: 9,
                numHeavyAtoms: 3,
                warnings: ["note"],
              },
            },
          });
        } else if (state.mode === "error") {
          this.onmessage?.({ data: { id: req.id, ok: false, error: "Could not sanitize" } });
        } else if (state.mode === "crash") {
          this.onerror?.(new Event("error"));
        } else if (state.mode === "crash-message") {
          this.onerror?.(new ErrorEvent("error", { message: "RuntimeError: unreachable" }));
        } else if (state.mode === "unreadable") {
          this.onmessageerror?.(new Event("messageerror"));
        }
      });
    }
    terminate() {
      state.terminated++;
    }
  }
  return { state, FakeWorker };
});

vi.mock("@/builder/library/embed.worker?worker", () => ({ default: FakeWorker }));
vi.mock("megane-rdkit/dist/megane-rdkit.wasm?url", () => ({
  get default() {
    return state.wasmAsset;
  },
}));

async function freshClient() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  return import("@/builder/library/embed");
}

beforeEach(() => {
  state.mode = "ok";
  state.wasmAsset = "/assets/megane-rdkit.wasm";
  state.requests = [];
  state.created = 0;
  state.terminated = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).Worker;
});

describe("embedSketch", () => {
  it("sends the molfile with RDKit options and returns the first conformer", async () => {
    const { embedSketch } = await freshClient();
    const out = await embedSketch("MOL", { addHydrogens: false, forceField: "UFF", randomSeed: 7 });
    expect(out).toEqual({
      molblock: "MOLBLOCK-3D",
      energy: -12.5,
      converged: true,
      forceField: "MMFF94s",
      warnings: ["note"],
      rdkitVersion: "2026.03.6",
    });
    expect(state.requests).toHaveLength(1);
    const req = state.requests[0];
    expect(req.molfile).toBe("MOL");
    expect(req.wasmUrl).toMatch(/\/assets\/megane-rdkit\.wasm$/);
    expect(req.options).toEqual({
      format: "auto",
      sanitize: true,
      addHs: false,
      removeHs: false,
      numConfs: 1,
      forceField: "UFF",
      randomSeed: 7,
    });
  });

  it("defaults to hydrogens on, MMFF94s and RDKit's own seed, and reuses the worker", async () => {
    const { embedSketch } = await freshClient();
    await embedSketch("A");
    await embedSketch("B");
    expect(state.created).toBe(1);
    expect(state.requests.map((r) => r.id)).toEqual([0, 1]);
    expect(state.requests[0].options).toEqual({
      format: "auto",
      sanitize: true,
      addHs: true,
      removeHs: false,
      numConfs: 1,
      forceField: "MMFF94s",
    });
  });

  it("rejects with RDKit's message when embedding fails, and the worker survives", async () => {
    const { embedSketch } = await freshClient();
    state.mode = "error";
    await expect(embedSketch("bad")).rejects.toThrow("Could not sanitize");
    state.mode = "ok";
    await expect(embedSketch("good")).resolves.toMatchObject({ molblock: "MOLBLOCK-3D" });
    expect(state.created).toBe(1);
    expect(state.terminated).toBe(0);
  });

  it("tears the worker down when it crashes, so the next call gets a fresh one", async () => {
    const { embedSketch } = await freshClient();
    state.mode = "crash";
    await expect(embedSketch("x")).rejects.toThrow(/crashed/);
    expect(state.terminated).toBe(1);
    state.mode = "ok";
    await expect(embedSketch("y")).resolves.toMatchObject({ energy: -12.5 });
    expect(state.created).toBe(2);
  });

  it("passes the worker's own error message on, and survives an unreadable answer", async () => {
    const { embedSketch } = await freshClient();
    state.mode = "crash-message";
    await expect(embedSketch("x")).rejects.toThrow(
      "The RDKit worker crashed: RuntimeError: unreachable",
    );
    state.mode = "unreadable";
    await expect(embedSketch("y")).rejects.toThrow("The RDKit worker sent an unreadable answer.");
    expect(state.terminated).toBe(2);
    state.mode = "ok";
    await expect(embedSketch("z")).resolves.toMatchObject({ molblock: "MOLBLOCK-3D" });
    expect(state.created).toBe(3);
  });

  it("times out a silent worker", async () => {
    vi.useFakeTimers();
    const { embedSketch, EMBED_TIMEOUT_MS } = await freshClient();
    state.mode = "silent";
    const p = embedSketch("slow");
    const caught = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS + 1);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not answer/);
    expect(state.terminated).toBe(1);
  });

  it("ignores an answer for a request it no longer holds", async () => {
    const { embedSketch } = await freshClient();
    state.mode = "silent";
    const p = embedSketch("A");
    // A stray answer (wrong id) is dropped; the real one still resolves.
    state.last!.onmessage!({ data: { id: 999, ok: true, result: {}, version: "x" } });
    state.last!.onmessage!({
      data: {
        id: 0,
        ok: true,
        version: "v",
        result: {
          molblocks: ["MB"],
          energies: [],
          converged: [],
          forceField: "none",
          warnings: [],
        },
      },
    });
    // Missing per-conformer entries fall back to null / false.
    expect(await p).toEqual({
      molblock: "MB",
      energy: null,
      converged: false,
      forceField: "none",
      warnings: [],
      rdkitVersion: "v",
    });
  });

  it("refuses without Web Workers and reports it through canEmbed", async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).Worker;
    const { embedSketch, canEmbed } = await import("@/builder/library/embed");
    expect(canEmbed()).toBe(false);
    await expect(embedSketch("x")).rejects.toThrow(/Web Workers/);
    expect(state.created).toBe(0);
  });

  it("disposeEmbedWorker rejects in-flight requests and drops the worker", async () => {
    const { embedSketch, disposeEmbedWorker } = await freshClient();
    state.mode = "silent";
    const p = embedSketch("x").catch((e: Error) => e.message);
    disposeEmbedWorker();
    expect(await p).toMatch(/disposed/);
    expect(state.terminated).toBe(1);
    // Disposing again with nothing running is a no-op.
    disposeEmbedWorker();
    expect(state.terminated).toBe(1);
  });
});

describe("setRDKitWasmSource", () => {
  it("takes the .wasm URL from the installed provider, then the bundle again once removed", async () => {
    const { embedSketch, setRDKitWasmSource } = await freshClient();
    const source = vi.fn(async () => "blob:rdkit");
    setRDKitWasmSource(source);
    await embedSketch("A");
    expect(source).toHaveBeenCalledTimes(1);
    expect(state.requests[0].wasmUrl).toBe("blob:rdkit");
    setRDKitWasmSource(null);
    await embedSketch("B");
    expect(state.requests[1].wasmUrl).toMatch(/\/assets\/megane-rdkit\.wasm$/);
  });

  it("rejects with the provider's error and sends nothing", async () => {
    const { embedSketch, setRDKitWasmSource } = await freshClient();
    setRDKitWasmSource(async () => {
      throw new Error("no kernel");
    });
    await expect(embedSketch("A")).rejects.toThrow("no kernel");
    expect(state.requests).toHaveLength(0);
    setRDKitWasmSource(null);
  });
});

describe("a .wasm on another origin than the page", () => {
  // A VS Code webview: the page is vscode-webview://, the bundle's assets are
  // on the extension's resource origin, which a worker cannot rely on reaching.
  const RESOURCE = "https://file+.vscode-resource.vscode-cdn.net/ext/media/builder/rdkit.wasm";

  function stubPageFetch(fetchMock: ReturnType<typeof vi.fn>): void {
    vi.stubGlobal("fetch", fetchMock);
    let n = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:page/rdkit-${++n}`);
  }

  it("is fetched by the page and handed to the worker as a blob: URL, once", async () => {
    state.wasmAsset = RESOURCE;
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["\0asm"]) }));
    stubPageFetch(fetchMock);
    const { embedSketch } = await freshClient();
    await expect(embedSketch("A")).resolves.toMatchObject({ molblock: "MOLBLOCK-3D" });
    await embedSketch("B");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(RESOURCE);
    expect(state.requests.map((r) => r.wasmUrl)).toEqual([
      "blob:page/rdkit-1",
      "blob:page/rdkit-1",
    ]);
  });

  it("reports a failed page fetch as RDKit not loading, sends nothing, and tries again", async () => {
    state.wasmAsset = RESOURCE;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 408 })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["\0asm"]) });
    stubPageFetch(fetchMock);
    const { embedSketch } = await freshClient();
    await expect(embedSketch("A")).rejects.toThrow(
      `Could not load RDKit: failed to fetch ${RESOURCE}: HTTP 408`,
    );
    expect(state.requests).toHaveLength(0);
    await expect(embedSketch("B")).resolves.toMatchObject({ molblock: "MOLBLOCK-3D" });
    expect(state.requests[0].wasmUrl).toBe("blob:page/rdkit-1");
  });
});
