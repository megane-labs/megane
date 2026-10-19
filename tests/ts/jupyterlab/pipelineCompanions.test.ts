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

/**
 * A Contents manager serving `files`, plus the `/files/` request it pairs
 * with. `raw: false` makes every download fail, so reads fall back to the
 * Contents API's base64.
 */
function fakeContents(
  files: Record<string, Uint8Array>,
  { raw = true }: { raw?: boolean } = {},
): {
  contents: Contents.IManager;
  get: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (path: string, opts: { format?: string }) => {
    if (opts.format !== "base64") throw new Error("expected a base64 fetch");
    const bytes = files[path];
    if (!bytes) throw new Error(`404 ${path}`);
    return { content: base64(bytes) };
  });
  const getDownloadUrl = vi.fn(async (path: string) => `/files/${path}`);
  const request = vi.fn(async (url: string) => {
    const bytes = raw ? files[url.replace(/^\/files\//, "")] : undefined;
    return bytes
      ? { ok: true, arrayBuffer: async () => bytes.slice().buffer }
      : { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  return { contents: { get, getDownloadUrl } as unknown as Contents.IManager, get, request };
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
  it("downloads the file's exact bytes raw, binary included", async () => {
    const traj = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28]);
    const { contents, get, request } = fakeContents({ "work/water.traj": traj });
    const file = await fetchCompanion(contents, request, "work/water.traj");
    expect(request).toHaveBeenCalledWith("/files/work/water.traj");
    expect(get).not.toHaveBeenCalled();
    expect(file?.name).toBe("water.traj");
    expect(await bytesOf(file!)).toEqual(traj);
  });

  it("falls back to the Contents API's base64 when the download fails", async () => {
    const traj = new Uint8Array([0x00, 0xff, 0x80]);
    const { contents, get, request } = fakeContents({ "work/water.traj": traj }, { raw: false });
    const file = await fetchCompanion(contents, request, "work/water.traj");
    expect(get).toHaveBeenCalledWith("work/water.traj", {
      type: "file",
      content: true,
      format: "base64",
    });
    expect(await bytesOf(file!)).toEqual(traj);
  });

  it("falls back when the download request itself throws", async () => {
    const { contents, get } = fakeContents({ "a.pdb": new Uint8Array([7]) });
    const request = vi.fn(async () => {
      throw new Error("network");
    });
    const file = await fetchCompanion(contents, request, "a.pdb");
    expect(get).toHaveBeenCalled();
    expect(await bytesOf(file!)).toEqual(new Uint8Array([7]));
  });

  it("returns null when the file cannot be fetched", async () => {
    const { contents, request } = fakeContents({});
    expect(await fetchCompanion(contents, request, "work/missing.pdb")).toBeNull();
  });

  it("treats a base64 model with no content as an empty file", async () => {
    const contents = {
      get: vi.fn(async () => ({ content: null })),
      getDownloadUrl: vi.fn(async () => "/files/empty.pdb"),
    } as unknown as Contents.IManager;
    const request = vi.fn(async () => ({ ok: false }));
    const file = await fetchCompanion(contents, request as never, "empty.pdb");
    expect(file?.size).toBe(0);
  });
});

describe("fetchPipelineCompanions", () => {
  it("fetches every companion and drops the unreadable ones", async () => {
    const { contents, request } = fakeContents({
      "work/a.traj": new Uint8Array([1]),
      "work/f.top": new Uint8Array([2]),
    });
    const files = await fetchPipelineCompanions(
      contents,
      request,
      {
        nodes: [
          { id: "s", type: "load_structure", fileName: "a.traj" },
          { id: "g", type: "load_volumetric", fileName: "missing.cube" },
          { id: "ab", type: "add_bond", bondFileName: "f.top" },
        ],
      },
      "work",
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(files.map((f) => f.name)).toEqual(["a.traj", "f.top"]);
  });
});
