/**
 * The RDKit embedding client: requests go through a (fake) Web Worker, the
 * first conformer of the answer becomes an `EmbeddedSketch`, RDKit errors
 * come back as rejections, and a crashed or silent worker is torn down so
 * the next call starts a new one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { state, FakeWorker } = vi.hoisted(() => {
  const state = {
    mode: "ok" as "ok" | "error" | "silent" | "crash",
    requests: [] as { id: number; wasmUrl: string; molfile: string; options: unknown }[],
    created: 0,
    terminated: 0,
    last: null as null | { onmessage: ((e: { data: unknown }) => void) | null },
  };
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
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
  default: "/assets/megane-rdkit.wasm",
}));

async function freshClient() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  return import("@/builder/library/embed");
}

beforeEach(() => {
  state.mode = "ok";
  state.requests = [];
  state.created = 0;
  state.terminated = 0;
});
afterEach(() => {
  vi.useRealTimers();
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
