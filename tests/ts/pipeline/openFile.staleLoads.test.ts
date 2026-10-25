/**
 * Loads that finish out of order. The parse worker reads each file in full
 * before parsing it, so a small file dropped right after a big one can finish
 * first; the big file's late result must not overwrite it. A trajectory parsed
 * against a structure that was replaced meanwhile must not attach either.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/parsers/structure", () => ({
  parseStructureFile: vi.fn(),
  parseTopBonds: vi.fn(),
  parsePsfBonds: vi.fn(),
}));
vi.mock("@/parsers/xtc", () => ({
  parseXTCFile: vi.fn(),
  parseLammpstrjFile: vi.fn(),
  parseDCDFile: vi.fn(),
  parseNetCDFFile: vi.fn(),
}));

import { parseStructureFile } from "@/parsers/structure";
import { parseXTCFile } from "@/parsers/xtc";
import { createPipelineStore } from "@/pipeline/store";
import type { StructureParseResult } from "@/parsers/structure";
import type { XTCParseResult } from "@/parsers/xtc";
import type { Snapshot, Frame } from "@/types";

const mockParseStructureFile = vi.mocked(parseStructureFile);
const mockParseXTCFile = vi.mocked(parseXTCFile);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function structure(nAtoms: number): StructureParseResult {
  const snapshot: Snapshot = {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms).fill(6),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
  return { snapshot, frames: [], meta: null, labels: null, vectorChannels: [] };
}

function trajectory(nAtoms: number, nFrames: number): XTCParseResult {
  const frames: Frame[] = Array.from({ length: nFrames }, (_, i) => ({
    frameId: i + 1,
    nAtoms,
    positions: new Float32Array(nAtoms * 3),
  }));
  return { frames, meta: { nFrames, timestepPs: 1, nAtoms }, vectorChannels: null };
}

type Store = ReturnType<typeof createPipelineStore>;

function loaderIds(store: Store): string[] {
  return store
    .getState()
    .nodes.filter((n) => n.type === "load_structure")
    .map((n) => n.id);
}

function fileNameOf(store: Store, id: string): string | null | undefined {
  const node = store.getState().nodes.find((n) => n.id === id);
  return (node?.data.params as { fileName?: string | null } | undefined)?.fileName;
}

function trajectoryFileName(store: Store): string | null | undefined {
  const node = store.getState().nodes.find((n) => n.type === "load_trajectory");
  return (node?.data.params as { fileName?: string | null } | undefined)?.fileName;
}

let store: Store;

beforeEach(async () => {
  mockParseStructureFile.mockReset();
  mockParseXTCFile.mockReset();
  store = createPipelineStore();
  // Start from a loaded 3-atom structure in the minimal pipeline.
  mockParseStructureFile.mockResolvedValueOnce(structure(3));
  await store.getState().openFile(new File(["x"], "start.pdb"), { mode: "replace" });
});

describe("structure loads finishing out of order", () => {
  it("keeps the later file when an earlier, slower parse finishes last", async () => {
    const big = deferred<StructureParseResult>();
    const small = deferred<StructureParseResult>();
    mockParseStructureFile.mockReturnValueOnce(big.promise).mockReturnValueOnce(small.promise);

    const openBig = store.getState().openFile(new File(["x"], "big.pdb"));
    const openSmall = store.getState().openFile(new File(["x"], "small.xyz"));
    small.resolve(structure(5));
    await openSmall;
    big.resolve(structure(9000));
    await openBig;

    const [loader] = loaderIds(store);
    expect(fileNameOf(store, loader)).toBe("small.xyz");
    expect(store.getState().nodeSnapshots[loader].snapshot.nAtoms).toBe(5);
  });

  it("does not report the failure of a parse a later load replaced", async () => {
    const big = deferred<StructureParseResult>();
    mockParseStructureFile.mockReturnValueOnce(big.promise).mockResolvedValueOnce(structure(5));

    const openBig = store.getState().openFile(new File(["x"], "big.pdb"));
    await store.getState().openFile(new File(["x"], "small.xyz"));
    big.reject(new Error("malformed big.pdb"));

    await expect(openBig).resolves.toBeUndefined();
    expect(fileNameOf(store, loaderIds(store)[0])).toBe("small.xyz");
  });

  it("still reports the failure of the latest load", async () => {
    mockParseStructureFile.mockRejectedValueOnce(new Error("malformed"));
    await expect(store.getState().openFile(new File(["x"], "bad.pdb"))).rejects.toThrow(
      "malformed",
    );
  });

  it("lets loads into different loader nodes both land", async () => {
    const [first] = loaderIds(store);
    const second = store.getState().addNode("load_structure");
    const slow = deferred<StructureParseResult>();
    mockParseStructureFile.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(structure(7));

    const openFirst = store.getState().openFile(new File(["x"], "a.pdb"), {
      mode: "merge",
      targetNodeId: first,
    });
    await store.getState().openFile(new File(["x"], "b.pdb"), {
      mode: "merge",
      targetNodeId: second,
    });
    slow.resolve(structure(4));
    await openFirst;

    expect(fileNameOf(store, first)).toBe("a.pdb");
    expect(fileNameOf(store, second)).toBe("b.pdb");
  });
});

describe("trajectory loads finishing out of order", () => {
  it("keeps the later trajectory when an earlier, slower parse finishes last", async () => {
    const slow = deferred<XTCParseResult>();
    mockParseXTCFile.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(trajectory(3, 2));

    const openSlow = store.getState().openFile(new File(["x"], "long.xtc"));
    await store.getState().openFile(new File(["x"], "short.xtc"));
    slow.resolve(trajectory(3, 50));
    await openSlow;

    expect(store.getState().fileFrames).toHaveLength(2);
    expect(trajectoryFileName(store)).toBe("short.xtc");
  });

  it("drops frames parsed for a structure that was replaced meanwhile", async () => {
    const slow = deferred<XTCParseResult>();
    mockParseXTCFile.mockReturnValueOnce(slow.promise);

    const openTraj = store.getState().openFile(new File(["x"], "run.xtc"));
    // A different structure lands while the trajectory is still parsing.
    mockParseStructureFile.mockResolvedValueOnce(structure(5));
    await store.getState().openFile(new File(["x"], "other.pdb"));
    slow.resolve(trajectory(3, 10));
    await openTraj;

    expect(store.getState().fileFrames).toBeNull();
    expect(trajectoryFileName(store)).not.toBe("run.xtc");
  });

  it("does not report the failure of a trajectory a later load replaced", async () => {
    const slow = deferred<XTCParseResult>();
    mockParseXTCFile.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(trajectory(3, 2));

    const openSlow = store.getState().openFile(new File(["x"], "long.xtc"));
    await store.getState().openFile(new File(["x"], "short.xtc"));
    slow.reject(new Error("atom count mismatch"));

    await expect(openSlow).resolves.toBeUndefined();
    expect(trajectoryFileName(store)).toBe("short.xtc");
  });
});
