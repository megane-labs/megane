/**
 * The labextension's stand-in for Vite's `./embed.worker?worker`: `new` on it
 * starts the RDKit worker from the worker module's URL.
 */

import { describe, it, expect, afterEach } from "vitest";
import EmbedWorker from "@/builder/library/embedWorker.webpack";

const original = globalThis.Worker;
afterEach(() => {
  globalThis.Worker = original;
});

describe("EmbedWorker (webpack)", () => {
  it("starts a worker on embed.worker.ts", () => {
    const urls: string[] = [];
    globalThis.Worker = class {
      constructor(url: URL | string) {
        urls.push(String(url));
      }
    } as unknown as typeof Worker;
    const w = new (EmbedWorker as unknown as new () => Worker)();
    expect(w).toBeTruthy();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/embed\.worker\.ts($|\?)/);
  });
});
