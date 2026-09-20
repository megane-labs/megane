/**
 * The embedding worker's message loop against a stubbed `megane-rdkit`:
 * the module loads once per worker (a failed load is retried), `embed` is
 * called with the request's options, and RDKit errors become `ok: false`
 * answers instead of crashing the worker.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { rdkit, loadRDKit } = vi.hoisted(() => {
  const rdkit = {
    version: vi.fn(() => "2026.03.6"),
    setVerbose: vi.fn(),
    embed: vi.fn(),
  };
  const loadRDKit = vi.fn();
  return { rdkit, loadRDKit };
});
vi.mock("megane-rdkit", () => ({ loadRDKit }));

const posted: unknown[] = [];
(globalThis as Record<string, unknown>).self = Object.assign(globalThis.self ?? {}, {
  postMessage: (m: unknown) => posted.push(m),
});

async function freshWorker() {
  vi.resetModules();
  return import("@/builder/library/embed.worker");
}

beforeEach(() => {
  posted.length = 0;
  loadRDKit.mockReset();
  rdkit.embed.mockReset();
  loadRDKit.mockResolvedValue(rdkit);
});

const request = (id: number, molfile = "MOL") => ({
  id,
  wasmUrl: "https://example.test/megane-rdkit.wasm",
  molfile,
  options: { addHs: true, forceField: "MMFF94s" as const },
});

describe("embed worker", () => {
  it("loads RDKit with the wasm URL once and answers with the embedding", async () => {
    const { handleRequest } = await freshWorker();
    const result = {
      molblocks: ["MB"],
      energies: [1],
      converged: [true],
      forceField: "MMFF94s",
      numAtoms: 1,
      numHeavyAtoms: 1,
      warnings: [],
    };
    rdkit.embed.mockReturnValue(result);
    expect(await handleRequest(request(1))).toEqual({
      id: 1,
      ok: true,
      result,
      version: "2026.03.6",
    });
    expect(await handleRequest(request(2, "OTHER"))).toMatchObject({ id: 2, ok: true });
    expect(loadRDKit).toHaveBeenCalledTimes(1);
    const locate = loadRDKit.mock.calls[0][0].locateFile as (p: string, prefix: string) => string;
    expect(locate("megane-rdkit.wasm", "/x/")).toBe("https://example.test/megane-rdkit.wasm");
    expect(rdkit.embed).toHaveBeenLastCalledWith("OTHER", request(2).options);
  });

  it("reports an RDKit error as ok: false and keeps serving", async () => {
    const { handleRequest } = await freshWorker();
    rdkit.embed.mockImplementationOnce(() => {
      throw new Error("Could not embed");
    });
    expect(await handleRequest(request(3))).toEqual({ id: 3, ok: false, error: "Could not embed" });
    rdkit.embed.mockImplementationOnce(() => {
      throw "plain string";
    });
    expect(await handleRequest(request(4))).toEqual({ id: 4, ok: false, error: "plain string" });
  });

  it("retries a failed module load on the next request", async () => {
    const { handleRequest, getRDKit } = await freshWorker();
    loadRDKit.mockRejectedValueOnce(new Error("wasm blocked"));
    expect(await handleRequest(request(5))).toEqual({ id: 5, ok: false, error: "wasm blocked" });
    rdkit.embed.mockReturnValue({ molblocks: ["MB"], energies: [null], converged: [false] });
    expect(await handleRequest(request(6))).toMatchObject({ id: 6, ok: true });
    expect(loadRDKit).toHaveBeenCalledTimes(2);
    // The successful load is cached.
    expect(await getRDKit("ignored")).toBe(rdkit);
    expect(loadRDKit).toHaveBeenCalledTimes(2);
  });

  it("answers postMessage requests through onmessage", async () => {
    await freshWorker();
    rdkit.embed.mockReturnValue({ molblocks: ["MB"], energies: [0], converged: [true] });
    const onmessage = (globalThis.self as unknown as { onmessage: (e: unknown) => Promise<void> })
      .onmessage;
    expect(onmessage).toBeTypeOf("function");
    await onmessage({ data: request(7) });
    expect(posted).toEqual([
      {
        id: 7,
        ok: true,
        result: { molblocks: ["MB"], energies: [0], converged: [true] },
        version: "2026.03.6",
      },
    ]);
  });
});
