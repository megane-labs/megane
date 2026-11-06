/**
 * Files a worker must not fetch itself: which URLs count as another origin
 * than the page, and the page-side fetch that hands a worker a `blob:` URL
 * instead (once per URL, retried after a failure).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

async function freshModule() {
  vi.resetModules();
  return import("@/utils/workerAssets");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isCrossOriginAsset", () => {
  it("tells the page's own URLs from another origin's", async () => {
    const { isCrossOriginAsset } = await freshModule();
    const page = "http://localhost:5173/index.html";
    expect(isCrossOriginAsset("/assets/a.wasm", page)).toBe(false);
    expect(isCrossOriginAsset("http://localhost:5173/a.wasm", page)).toBe(false);
    expect(isCrossOriginAsset("https://cdn.example/a.wasm", page)).toBe(true);
    expect(isCrossOriginAsset("blob:http://localhost:5173/x", page)).toBe(false);
    expect(isCrossOriginAsset("data:application/wasm;base64,AA==", page)).toBe(false);
  });

  it("treats every http(s) URL as foreign to an opaque-origin webview page", async () => {
    const { isCrossOriginAsset } = await freshModule();
    const page = "vscode-webview://abc/index.html?id=1";
    expect(isCrossOriginAsset("https://x.vscode-resource.vscode-cdn.net/m.wasm", page)).toBe(true);
  });

  it("is false without a page URL or for an unparsable URL", async () => {
    const { isCrossOriginAsset } = await freshModule();
    expect(isCrossOriginAsset("https://cdn.example/a.wasm", undefined)).toBe(false);
    expect(isCrossOriginAsset("http://[bad", "http://localhost/")).toBe(false);
  });
});

describe("fetchAsBlobUrl", () => {
  const URL_A = "https://file+.vscode-resource.vscode-cdn.net/ext/media/builder/a.wasm";

  function stubBlobUrls(): Blob[] {
    const made: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b: Blob | MediaSource) => {
      made.push(b as Blob);
      return `blob:page/${made.length}`;
    });
    return made;
  }

  it("fetches on the page once per URL and hands out a typed blob: URL", async () => {
    const made = stubBlobUrls();
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["\0asm"]) }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAsBlobUrl } = await freshModule();
    expect(await fetchAsBlobUrl(URL_A, "application/wasm")).toBe("blob:page/1");
    expect(await fetchAsBlobUrl(URL_A, "application/wasm")).toBe("blob:page/1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_A);
    expect(made[0].type).toBe("application/wasm");
    expect(made[0].size).toBe(4);
  });

  it("rejects on an HTTP error and fetches again on the next call", async () => {
    stubBlobUrls();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 408 })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["x"]) });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAsBlobUrl } = await freshModule();
    await expect(fetchAsBlobUrl(URL_A, "application/wasm")).rejects.toThrow(
      `failed to fetch ${URL_A}: HTTP 408`,
    );
    expect(await fetchAsBlobUrl(URL_A, "application/wasm")).toBe("blob:page/1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
