/**
 * The labextension's stand-in for Vite's `./parse.worker?worker`: `new` on it
 * starts the parse worker from the worker module's URL.
 */

import { describe, it, expect, afterEach } from "vitest";
import ParseWorker from "@/parsers/parseWorker.webpack";

const original = globalThis.Worker;
afterEach(() => {
  globalThis.Worker = original;
});

describe("ParseWorker (webpack)", () => {
  it("starts a worker on parse.worker.ts", () => {
    const urls: string[] = [];
    globalThis.Worker = class {
      constructor(url: URL | string) {
        urls.push(String(url));
      }
    } as unknown as typeof Worker;
    const w = new (ParseWorker as unknown as new () => Worker)();
    expect(w).toBeTruthy();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/parse\.worker\.ts($|\?)/);
  });
});
