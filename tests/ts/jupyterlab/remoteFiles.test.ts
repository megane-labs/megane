import { describe, it, expect, vi } from "vitest";
import { createJupyterFileSource } from "../../../jupyterlab-megane/src/remoteFiles";

function contentsWith(models: Record<string, unknown>) {
  return {
    get: vi.fn(async (path: string) => {
      const model = models[path];
      if (!model) throw new Error(`No such file: ${path}`);
      return model;
    }),
    getDownloadUrl: vi.fn(async (path: string) => `http://lab/files/${path}`),
  };
}

const noRequest = vi.fn(async () => new Response(""));

describe("createJupyterFileSource", () => {
  it("lists a folder from the Contents API, folders first", async () => {
    const contents = contentsWith({
      "work/run": {
        type: "directory",
        path: "work/run",
        content: [
          { name: "b.pdb", path: "work/run/b.pdb", type: "file", size: 10 },
          { name: "Data", path: "work/run/Data", type: "directory" },
          { name: "a.xtc", path: "work/run/a.xtc", type: "file", size: 20 },
          { name: "nb.ipynb", path: "work/run/nb.ipynb", type: "notebook", size: 5 },
          { name: "aux", path: "work/run/aux", type: "directory" },
        ],
      },
    });
    const source = createJupyterFileSource(contents as never, noRequest, () => "work/run");
    expect(source.mode).toBe("browse");
    expect(source.initialPath?.()).toBe("work/run");

    const listing = await source.list("work/run");
    expect(contents.get).toHaveBeenCalledWith("work/run", { content: true });
    expect(listing.path).toBe("work/run");
    expect(listing.parent).toBe("work");
    expect(listing.entries.map((e) => e.name)).toEqual([
      "aux",
      "Data",
      "a.xtc",
      "b.pdb",
      "nb.ipynb",
    ]);
    expect(listing.entries[0]).toEqual({
      name: "aux",
      path: "work/run/aux",
      isDir: true,
      size: null,
    });
    expect(listing.entries[2].size).toBe(20);
  });

  it("has no parent at the root and tolerates an empty folder", async () => {
    const source = createJupyterFileSource(
      contentsWith({ "": { type: "directory", path: "", content: null } }) as never,
      noRequest,
    );
    expect(source.initialPath?.()).toBe("");
    await expect(source.list("")).resolves.toEqual({ path: "", parent: null, entries: [] });
  });

  it("refuses to list a file", async () => {
    const source = createJupyterFileSource(
      contentsWith({ "a.pdb": { type: "file", path: "a.pdb" } }) as never,
      noRequest,
    );
    await expect(source.list("a.pdb")).rejects.toThrow("Not a folder: a.pdb");
  });

  it("downloads the file's bytes from the server and names it after its basename", async () => {
    const contents = contentsWith({});
    const request = vi.fn(async () => new Response("ATOM"));
    const source = createJupyterFileSource(contents as never, request);
    const file = await source.read("work/a.pdb");
    expect(contents.getDownloadUrl).toHaveBeenCalledWith("work/a.pdb");
    expect(request).toHaveBeenCalledWith("http://lab/files/work/a.pdb");
    expect(file.name).toBe("a.pdb");
    expect(file.size).toBe(4);
  });

  it("reports a failed download", async () => {
    const request = vi.fn(async () => new Response("", { status: 403, statusText: "Forbidden" }));
    const source = createJupyterFileSource(contentsWith({}) as never, request);
    await expect(source.read("secret.pdb")).rejects.toThrow(
      "Could not read secret.pdb: 403 Forbidden",
    );
  });
});
