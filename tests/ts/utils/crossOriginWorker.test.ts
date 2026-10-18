/**
 * Workers from another origin (a VS Code webview's resource URLs) start from
 * a same-origin blob: bootstrap that imports the real script; everything the
 * page may load directly is passed through.
 */

import { describe, it, expect, vi } from "vitest";
import { installCrossOriginWorker, workerBootstrapUrl } from "@/utils/crossOriginWorker";

const PAGE = "vscode-webview://abc/index.html";
const RESOURCE = "https://file+.vscode-resource.vscode-cdn.net/ext/media/builder/w.js";

async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

describe("workerBootstrapUrl", () => {
  it("imports a cross-origin module worker from a blob: bootstrap", async () => {
    const blobs: Blob[] = [];
    const out = workerBootstrapUrl(RESOURCE, { type: "module" }, PAGE, (b) => {
      blobs.push(b);
      return "blob:boot";
    });
    expect(out).toBe("blob:boot");
    expect(await blobText(blobs[0])).toBe(`import ${JSON.stringify(RESOURCE)};\n`);
  });

  it("uses importScripts for a classic worker and resolves relative URLs against the page", async () => {
    const blobs: Blob[] = [];
    workerBootstrapUrl(new URL(RESOURCE), undefined, PAGE, (b) => {
      blobs.push(b);
      return "blob:x";
    });
    expect(await blobText(blobs[0])).toBe(`importScripts(${JSON.stringify(RESOURCE)});\n`);
  });

  it("passes same-origin, blob: and data: URLs through", () => {
    const create = vi.fn(() => "blob:never");
    const page = "https://example.org/app/index.html";
    expect(workerBootstrapUrl("worker.js", undefined, page, create)).toBe("worker.js");
    expect(workerBootstrapUrl("https://example.org/w.js", undefined, page, create)).toBe(
      "https://example.org/w.js",
    );
    expect(workerBootstrapUrl("blob:abc", undefined, page, create)).toBe("blob:abc");
    expect(workerBootstrapUrl("data:text/javascript,1", undefined, page, create)).toBe(
      "data:text/javascript,1",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("bootstraps everything from an opaque-origin page, and leaves unparsable input alone", () => {
    const create = vi.fn(() => "blob:b");
    expect(workerBootstrapUrl(RESOURCE, undefined, "about:blank", create)).toBe("blob:b");
    expect(workerBootstrapUrl("w.js", undefined, "not a url", create)).toBe("w.js");
  });
});

describe("installCrossOriginWorker", () => {
  it("wraps Worker once and starts cross-origin scripts from the bootstrap", () => {
    const seen: (string | URL)[] = [];
    class NativeWorker {
      constructor(url: string | URL) {
        seen.push(url);
      }
    }
    const target: { Worker?: unknown; location: { href: string } } = {
      Worker: NativeWorker,
      location: { href: "https://example.org/" },
    };
    installCrossOriginWorker(target);
    const Wrapped = target.Worker as new (u: string, o?: WorkerOptions) => unknown;
    expect(Wrapped).not.toBe(NativeWorker);
    installCrossOriginWorker(target);
    expect(target.Worker).toBe(Wrapped);

    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:boot");
    new Wrapped("https://cdn.example.net/w.js", { type: "module" });
    new Wrapped("https://example.org/local.js");
    expect(seen).toEqual(["blob:boot", "https://example.org/local.js"]);
    created.mockRestore();
  });

  it("does nothing without Worker", () => {
    const target: { Worker?: unknown } = {};
    installCrossOriginWorker(target);
    expect(target.Worker).toBeUndefined();
  });
});
