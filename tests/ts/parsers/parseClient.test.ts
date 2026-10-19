/**
 * Unit tests for the worker-backed parse client's fallback behaviour.
 *
 * jsdom does not implement `Worker`, so `parseClient` naturally takes its
 * synchronous fallback path. We mock `parseClientSync` and assert every public
 * entry point delegates to it — the safety property that guarantees no host is
 * ever left unable to open a file when a worker is unavailable.
 *
 * The real worker path (message plumbing + buffer transfer) is exercised by the
 * Playwright `format-loading` / `playback` specs, which run in a real browser.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/parsers/parseClientSync", () => ({
  parseStructureFile: vi.fn(async () => ({ tag: "structFile" })),
  parseStructureText: vi.fn(async () => ({ tag: "structText" })),
  parseXTCFile: vi.fn(async () => ({ tag: "xtc" })),
  parseDCDFile: vi.fn(async () => ({ tag: "dcd" })),
  parseLammpstrjFile: vi.fn(async () => ({ tag: "lammpstrj" })),
  parseNetCDFFile: vi.fn(async () => ({ tag: "netcdf" })),
}));

import * as client from "@/parsers/parseClient";
import * as sync from "@/parsers/parseClientSync";

function file(name: string): File {
  return new File(["dummy"], name);
}

describe("parseClient falls back to the synchronous path when no Worker exists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no Worker; make the guard explicit and robust to environment.
    // @ts-expect-error deleting a possibly-undefined global for the test
    delete (globalThis as Record<string, unknown>).Worker;
  });

  it("parseStructureFile delegates to sync", async () => {
    const f = file("x.pdb");
    const out = await client.parseStructureFile(f);
    expect(sync.parseStructureFile).toHaveBeenCalledWith(f);
    expect(out).toEqual({ tag: "structFile" });
  });

  it("parseStructureText delegates to sync", async () => {
    const out = await client.parseStructureText("ATOM", "x.pdb");
    expect(sync.parseStructureText).toHaveBeenCalledWith("ATOM", "x.pdb");
    expect(out).toEqual({ tag: "structText" });
  });

  it("parseXTCFile delegates to sync with atom count", async () => {
    const f = file("t.xtc");
    await client.parseXTCFile(f, 42);
    expect(sync.parseXTCFile).toHaveBeenCalledWith(f, 42);
  });

  it("parseDCDFile delegates to sync", async () => {
    const f = file("t.dcd");
    await client.parseDCDFile(f, 7);
    expect(sync.parseDCDFile).toHaveBeenCalledWith(f, 7);
  });

  it("parseLammpstrjFile delegates to sync", async () => {
    const f = file("t.lammpstrj");
    await client.parseLammpstrjFile(f, 3);
    expect(sync.parseLammpstrjFile).toHaveBeenCalledWith(f, 3);
  });

  it("parseNetCDFFile delegates to sync", async () => {
    const f = file("t.nc");
    await client.parseNetCDFFile(f, 9);
    expect(sync.parseNetCDFFile).toHaveBeenCalledWith(f, 9);
  });

  it("lazy structure entry points no-op without a worker", async () => {
    // No worker ⇒ null (caller falls back to eager parse) and no streaming.
    expect(await client.indexStructureLazy(file("m.xyz"), "xyz")).toBeNull();
    expect(await client.parseStructurePrefix(file("m.xyz"), "xyz")).toBeNull();
    expect(client.shouldUseLazyStructure("xyz", 1024 * 1024 * 1024)).toBe(false);
  });

  it("lazy trajectory entry points no-op without a worker", async () => {
    // No worker ⇒ null so loadXtc falls back to a full read / eager parse.
    expect(await client.indexTrajectoryLazy(file("t.xtc"), "xtc", 4)).toBeNull();
    expect(await client.decodeTrajectoryFrame0(file("t.xtc"), "xtc", 4)).toBeNull();
    expect(client.shouldUseLazyTrajectory("xtc", 1024 * 1024 * 1024)).toBe(false);
  });

  it("prewarmParseWorker is a no-op without a worker", () => {
    expect(() => client.prewarmParseWorker()).not.toThrow();
  });
});
