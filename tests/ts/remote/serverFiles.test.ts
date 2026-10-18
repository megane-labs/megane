import { describe, it, expect, vi } from "vitest";
import { createServerFileSource, detectServerFileSource } from "@/remote/serverFiles";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const listing = {
  path: "run",
  parent: "",
  entries: [{ name: "a.pdb", path: "run/a.pdb", isDir: false, size: 3 }],
};

describe("createServerFileSource", () => {
  it("lists a folder through /api/files", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(listing));
    const source = createServerFileSource("http://host:1", fetchImpl);
    expect(source.mode).toBe("browse");
    expect(source.label).toBe("Open from server...");
    await expect(source.list("run dir/x")).resolves.toEqual(listing);
    expect(fetchImpl).toHaveBeenCalledWith("http://host:1/api/files?path=run%20dir%2Fx");
  });

  it("surfaces the server's error detail", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ detail: "Path is outside the served folder" }, { status: 400 }));
    await expect(createServerFileSource("", fetchImpl).list("..")).rejects.toThrow(
      "Path is outside the served folder",
    );
  });

  it("falls back to the status line when the error is not JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500, statusText: "Server Error" }));
    await expect(createServerFileSource("", fetchImpl).read("a.pdb")).rejects.toThrow(
      "500 Server Error",
    );
  });

  it("falls back to the status line when the JSON has no detail", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}, { status: 404, statusText: "" }));
    await expect(createServerFileSource("", fetchImpl).list("")).rejects.toThrow("404");
  });

  it("rejects a body that is not a listing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ hello: 1 }));
    await expect(createServerFileSource("", fetchImpl).list("")).rejects.toThrow(
      "Unexpected response",
    );
  });

  it("reads a file into a File named after its last path segment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ATOM"));
    const file = await createServerFileSource("", fetchImpl).read("run/a.pdb");
    expect(fetchImpl).toHaveBeenCalledWith("/api/files/content?path=run%2Fa.pdb");
    expect(file.name).toBe("a.pdb");
    expect(file.size).toBe(4);
  });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(listing));
    await createServerFileSource().list("");
    expect(spy).toHaveBeenCalledWith("/api/files?path=", undefined);
    spy.mockRestore();
  });
});

describe("detectServerFileSource", () => {
  it("returns a source when megane serve answers with a listing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(listing));
    const source = await detectServerFileSource("", fetchImpl);
    expect(source?.mode).toBe("browse");
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/files?path=");
  });

  it("ignores an HTML fallback page (Vite, static hosting)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    await expect(detectServerFileSource("", fetchImpl)).resolves.toBeNull();
  });

  it("ignores a refused or disabled API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ detail: "x" }, { status: 403 }));
    await expect(detectServerFileSource("", fetchImpl)).resolves.toBeNull();
  });

  it("ignores JSON that is not a listing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json([1, 2]));
    await expect(detectServerFileSource("", fetchImpl)).resolves.toBeNull();
  });

  it("ignores a response without a content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, headers: new Headers() } as Response);
    await expect(detectServerFileSource("", fetchImpl)).resolves.toBeNull();
  });

  it("never throws on a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(detectServerFileSource("", fetchImpl)).resolves.toBeNull();
  });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    await expect(detectServerFileSource()).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
