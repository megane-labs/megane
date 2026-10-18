import { describe, it, expect, vi } from "vitest";
import type { Contents } from "@jupyterlab/services";
import {
  basename,
  collectCompanionTargets,
  dirname,
  fetchCompanion,
  fetchPipelineCompanions,
  joinUnderDir,
} from "../../../jupyterlab-megane/src/pipelineCompanions";

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fakeContents(files: Record<string, Uint8Array>): {
  contents: Contents.IManager;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (path: string, opts: { format?: string }) => {
    if (opts.format !== "base64") throw new Error("expected a base64 fetch");
    const bytes = files[path];
    if (!bytes) throw new Error(`404 ${path}`);
    return { content: base64(bytes) };
  });
  return { contents: { get } as unknown as Contents.IManager, get };
}

async function bytesOf(file: File): Promise<Uint8Array> {
  const buf = await new Promise<ArrayBuffer>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
  return new Uint8Array(buf);
}

describe("path helpers", () => {
  it("dirname / basename split on the last slash", () => {
    expect(dirname("a/b/c.json")).toBe("a/b");
    expect(dirname("c.json")).toBe("");
    expect(basename("a/b/c.json")).toBe("c.json");
    expect(basename("c.json")).toBe("c.json");
  });

  it("joinUnderDir resolves relative paths and refuses escapes", () => {
    expect(joinUnderDir("work", "data/x.traj")).toBe("work/data/x.traj");
    expect(joinUnderDir("work", "./a/../b.pdb")).toBe("work/b.pdb");
    expect(joinUnderDir("", "x.pdb")).toBe("x.pdb");
    expect(joinUnderDir("work", "/etc/passwd")).toBeNull();
    expect(joinUnderDir("work", "../other/x.pdb")).toBeNull();
    expect(joinUnderDir("", "../x.pdb")).toBeNull();
  });
});

describe("collectCompanionTargets", () => {
  it("takes every file-bearing node type, each under its own param", () => {
    const targets = collectCompanionTargets(
      {
        nodes: [
          { id: "s", type: "load_structure", fileName: "a.traj" },
          { id: "t", type: "load_trajectory", fileName: "b.xtc" },
          { id: "v", type: "load_vector", fileName: "c.vec" },
          { id: "g", type: "load_volumetric", fileName: "grids/d.cube" },
          { id: "sp", type: "load_spectrum", fileName: "e.jdx" },
          { id: "ab", type: "add_bond", bondFileName: "f.top" },
        ],
      },
      "work",
    );
    expect(targets).toEqual([
      "work/a.traj",
      "work/b.xtc",
      "work/c.vec",
      "work/grids/d.cube",
      "work/e.jdx",
      "work/f.top",
    ]);
  });

  it("skips nodes without a file, embedded vectors, other node types and escapes", () => {
    const targets = collectCompanionTargets(
      {
        nodes: [
          { id: "a", type: "load_structure", fileName: null },
          { id: "b", type: "load_vector", fileName: "[embedded] velocities" },
          { id: "c", type: "filter", fileName: "x.pdb" },
          { id: "d", type: "add_bond", bondSource: "distance" },
          { id: "e", type: "load_structure", fileName: "../up.pdb" },
        ],
      },
      "work",
    );
    expect(targets).toEqual([]);
  });

  it("tolerates a pipeline with no nodes", () => {
    expect(collectCompanionTargets({}, "")).toEqual([]);
  });
});

describe("fetchCompanion", () => {
  it("returns the file's exact bytes, binary included", async () => {
    const traj = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28]);
    const { contents, get } = fakeContents({ "work/water.traj": traj });
    const file = await fetchCompanion(contents, "work/water.traj");
    expect(get).toHaveBeenCalledWith("work/water.traj", { content: true, format: "base64" });
    expect(file?.name).toBe("water.traj");
    expect(await bytesOf(file!)).toEqual(traj);
  });

  it("returns null when the file cannot be fetched", async () => {
    const { contents } = fakeContents({});
    expect(await fetchCompanion(contents, "work/missing.pdb")).toBeNull();
  });

  it("treats a model with no content as an empty file", async () => {
    const contents = {
      get: vi.fn(async () => ({ content: null })),
    } as unknown as Contents.IManager;
    const file = await fetchCompanion(contents, "empty.pdb");
    expect(file?.size).toBe(0);
  });
});

describe("fetchPipelineCompanions", () => {
  it("fetches every companion and drops the unreadable ones", async () => {
    const { contents, get } = fakeContents({
      "work/a.traj": new Uint8Array([1]),
      "work/f.top": new Uint8Array([2]),
    });
    const files = await fetchPipelineCompanions(
      contents,
      {
        nodes: [
          { id: "s", type: "load_structure", fileName: "a.traj" },
          { id: "g", type: "load_volumetric", fileName: "missing.cube" },
          { id: "ab", type: "add_bond", bondFileName: "f.top" },
        ],
      },
      "work",
    );
    expect(get).toHaveBeenCalledTimes(3);
    expect(files.map((f) => f.name)).toEqual(["a.traj", "f.top"]);
  });
});
