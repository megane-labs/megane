import { describe, it, expect, vi } from "vitest";

// Byte-sized pieces instead of 8 MB / 4 MB, so the cases stay fast.
vi.mock("@megane/hosts/progressiveFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hosts/progressiveFile")>();
  return {
    ...actual,
    PROGRESSIVE_HEAD_BYTES: 64,
    PROGRESSIVE_TAIL_BYTES: 32,
  };
});
import {
  contentRangeTotal,
  progressivePiecesFor,
  readServerFile,
  readServerFileBytes,
  type ServerRequest,
} from "../../../jupyterlab-megane/src/serverFileBytes";
const PROGRESSIVE_HEAD_BYTES = 64;
const PROGRESSIVE_TAIL_BYTES = 32;
const PIECES = { head: PROGRESSIVE_HEAD_BYTES, tail: PROGRESSIVE_TAIL_BYTES };
const MB = 10;

/** A file of `size` bytes whose byte i is i % 251, so pieces can be checked. */
function fileBytes(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = i % 251;
  return b;
}

function response(
  status: number,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    arrayBuffer: async () => body.slice().buffer,
  } as unknown as Response;
}

/**
 * A Jupyter-like `/files/` endpoint over `data`: honours `Range: bytes=a-b`
 * with a 206 and a Content-Range, answers 200 with everything otherwise, and
 * (like Tornado) answers 200 to a range that covers the whole file.
 */
function server(data: Uint8Array, opts: { ranges?: boolean; failMiddle?: boolean } = {}) {
  const calls: Array<string | null> = [];
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    calls.push(range);
    if (!range || opts.ranges === false) return response(200, data);
    const [first, lastReq] = range.replace("bytes=", "").split("-").map(Number);
    const last = Math.min(lastReq, data.length - 1);
    if (first === 0 && last === data.length - 1) return response(200, data);
    if (opts.failMiddle && first > 0 && last < data.length - 1)
      return response(500, new Uint8Array());
    return response(206, data.subarray(first, last + 1), {
      "Content-Range": `bytes ${first}-${last}/${data.length}`,
    });
  });
  return { request: request as unknown as ServerRequest, calls, mock: request };
}

const contents = (overrides: Record<string, unknown> = {}) => ({
  getDownloadUrl: vi.fn(async (p: string) => `/files/${p}`),
  get: vi.fn(async () => ({ content: btoa("fallback") })),
  ...overrides,
});

// The whole file as the viewer gets it; carries its bytes for the checks.
const toFile = (bytes: Uint8Array, name: string) => ({ name, bytes }) as unknown as File;

describe("contentRangeTotal", () => {
  it("reads the total from a Content-Range header", () => {
    expect(
      contentRangeTotal(response(206, new Uint8Array(), { "Content-Range": "bytes 0-9/1234" })),
    ).toBe(1234);
    expect(
      contentRangeTotal(response(206, new Uint8Array(), { "Content-Range": "bytes 0-9/*" })),
    ).toBeNull();
    expect(contentRangeTotal(response(206, new Uint8Array()))).toBeNull();
  });
});

describe("progressivePiecesFor", () => {
  it("fetches a small head and a token tail first for an ASE .traj", () => {
    expect(progressivePiecesFor("runs/OPT.TRAJ")).toEqual({
      head: 2 * 1024 * 1024,
      tail: 64 * 1024,
    });
  });
  it("uses the shared head and tail for every other format", () => {
    // The shared sizes are mocked to 64 / 32 bytes in this file.
    expect(progressivePiecesFor("movie.xyz")).toEqual({ head: 64, tail: 32 });
  });
});

describe("readServerFile", () => {
  it("takes its pieces from the file name by default", async () => {
    const data = fileBytes(200);
    const s = server(data);
    const got = await readServerFile(contents(), s.request, "a.xyz", "a.xyz", toFile);
    expect(got.kind).toBe("pieces");
    expect(s.calls[0]).toBe("bytes=0-63");
  });

  it("returns a small file whole when the server answers the ranged head with 200", async () => {
    const data = fileBytes(50);
    const s = server(data);
    const got = await readServerFile(contents(), s.request, "a.traj", "a.traj", toFile, PIECES);
    expect(got.kind).toBe("whole");
    expect(got.kind === "whole" && got.bytes).toEqual(data);
    expect(s.calls).toEqual([`bytes=0-${PROGRESSIVE_HEAD_BYTES - 1}`]);
  });

  it("fetches the remainder of a file between the head and the progressive size", async () => {
    const data = fileBytes(PROGRESSIVE_HEAD_BYTES + 3 * MB);
    const s = server(data);
    const got = await readServerFile(contents(), s.request, "a.traj", "a.traj", toFile, PIECES);
    expect(got.kind).toBe("whole");
    expect(got.kind === "whole" && got.bytes).toEqual(data);
    expect(s.calls).toEqual([
      `bytes=0-${PROGRESSIVE_HEAD_BYTES - 1}`,
      `bytes=${PROGRESSIVE_HEAD_BYTES}-${data.length - 1}`,
    ]);
  });

  it("returns a head exactly the file's size whole without another request", async () => {
    const data = fileBytes(PROGRESSIVE_HEAD_BYTES);
    const request = vi.fn(async () =>
      response(206, data, { "Content-Range": `bytes 0-${data.length - 1}/${data.length}` }),
    ) as unknown as ServerRequest;
    const got = await readServerFile(contents(), request, "a.xyz", "a.xyz", toFile, PIECES);
    expect(got.kind === "whole" && got.bytes.length).toBe(data.length);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("delivers a large file head and tail first, then the whole file", async () => {
    const size = PROGRESSIVE_HEAD_BYTES + PROGRESSIVE_TAIL_BYTES + 5 * MB;
    const data = fileBytes(size);
    const s = server(data);
    const got = await readServerFile(
      contents(),
      s.request,
      "dir/big.traj",
      "big.traj",
      toFile,
      PIECES,
    );
    expect(got.kind).toBe("pieces");
    if (got.kind !== "pieces") return;
    expect(got.file.name).toBe("big.traj");
    expect(got.file.size).toBe(size);
    expect(got.file.head).toEqual(data.subarray(0, PROGRESSIVE_HEAD_BYTES));
    expect(got.file.tail).toEqual(data.subarray(size - PROGRESSIVE_TAIL_BYTES));
    const whole = (await got.file.file) as unknown as { name: string; bytes: Uint8Array };
    expect(whole.name).toBe("big.traj");
    expect(whole.bytes).toEqual(data);
    expect(s.calls).toEqual([
      `bytes=0-${PROGRESSIVE_HEAD_BYTES - 1}`,
      `bytes=${size - PROGRESSIVE_TAIL_BYTES}-${size - 1}`,
      `bytes=${PROGRESSIVE_HEAD_BYTES}-${size - PROGRESSIVE_TAIL_BYTES - 1}`,
    ]);
  });

  it("rejects the whole file, not the head, when the middle cannot be read", async () => {
    const size = PROGRESSIVE_HEAD_BYTES + PROGRESSIVE_TAIL_BYTES + MB;
    const s = server(fileBytes(size), { failMiddle: true });
    const got = await readServerFile(contents(), s.request, "big.traj", "big.traj", toFile, PIECES);
    expect(got.kind).toBe("pieces");
    if (got.kind !== "pieces") return;
    await expect(got.file.file).rejects.toThrow(/HTTP 500/);
  });

  it("falls back to one whole download when the server ignores ranges", async () => {
    const data = fileBytes(PROGRESSIVE_HEAD_BYTES + PROGRESSIVE_TAIL_BYTES + MB);
    const s = server(data, { ranges: false });
    const got = await readServerFile(contents(), s.request, "big.traj", "big.traj", toFile, PIECES);
    expect(got.kind === "whole" && got.bytes.length).toBe(data.length);
    expect(s.calls).toHaveLength(1);
  });

  it("falls back to a plain read when the ranged head has no usable size", async () => {
    const data = fileBytes(1000);
    const request = vi.fn(async (_url: string, init?: RequestInit) =>
      init ? response(206, data.subarray(0, 10)) : response(200, data),
    ) as unknown as ServerRequest;
    const got = await readServerFile(contents(), request, "a.pdb", "a.pdb", toFile, PIECES);
    expect(got.kind === "whole" && got.bytes).toEqual(data);
  });

  it("falls back when a range comes back short", async () => {
    const data = fileBytes(PROGRESSIVE_HEAD_BYTES + MB);
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      if (!range) return response(200, data);
      if (range.startsWith("bytes=0-"))
        return response(206, data.subarray(0, PROGRESSIVE_HEAD_BYTES), {
          "Content-Range": `bytes 0-${PROGRESSIVE_HEAD_BYTES - 1}/${data.length}`,
        });
      return response(206, data.subarray(PROGRESSIVE_HEAD_BYTES, PROGRESSIVE_HEAD_BYTES + 5));
    }) as unknown as ServerRequest;
    const got = await readServerFile(contents(), request, "a.xyz", "a.xyz", toFile, PIECES);
    expect(got.kind === "whole" && got.bytes.length).toBe(data.length);
  });

  it("falls back to the Contents API when the drive has no download URL", async () => {
    const c = contents({ getDownloadUrl: vi.fn(async () => Promise.reject(new Error("no url"))) });
    const request = vi.fn() as unknown as ServerRequest;
    const got = await readServerFile(c, request, "a.pdb", "a.pdb", toFile, PIECES);
    expect(got.kind === "whole" && new TextDecoder().decode(got.bytes)).toBe("fallback");
  });
});

describe("readServerFileBytes", () => {
  it("reads /files/ and falls back to base64 contents on a failed response", async () => {
    const ok = vi.fn(async () =>
      response(200, new TextEncoder().encode("raw")),
    ) as unknown as ServerRequest;
    expect(new TextDecoder().decode(await readServerFileBytes(contents(), ok, "a.pdb"))).toBe(
      "raw",
    );
    const bad = vi.fn(async () => response(404, new Uint8Array())) as unknown as ServerRequest;
    expect(new TextDecoder().decode(await readServerFileBytes(contents(), bad, "a.pdb"))).toBe(
      "fallback",
    );
  });
});
