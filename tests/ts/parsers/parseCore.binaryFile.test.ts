// @vitest-environment node
/**
 * The file-backed lazy DCD / AMBER NetCDF decoder
 * (`indexBinaryTrajectoryFileCore`) against the real WASM module: the index
 * comes from the header bytes alone, and every frame read from its own bytes
 * equals the eager parse.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureInit,
  indexBinaryTrajectoryFileCore,
  parseTrajectoryCore,
  BINARY_HEAD_MIN,
  type BlobRangeReader,
} from "@/parsers/parseCore";

const ROOT = process.cwd();
const fixture = (name: string) => new Uint8Array(readFileSync(join(ROOT, "tests/fixtures", name)));

function recordingReader(bytes: Uint8Array) {
  const reads: [number, number][] = [];
  const read: BlobRangeReader = async (_blob, start, end) => {
    reads.push([start, end]);
    return bytes.slice(start, end).buffer;
  };
  return { read, reads };
}

/** A little-endian CHARMM DCD with a cell per frame (box edge 10 + frame). */
function dcdWithCells(nAtoms: number, nFrames: number, titleBytes = 80): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    parts.push(...b);
  };
  const record = (payload: Uint8Array) => {
    u32(payload.length);
    parts.push(...payload);
    u32(payload.length);
  };
  const header = new Uint8Array(84);
  const hv = new DataView(header.buffer);
  header.set([67, 79, 82, 68]); // "CORD"
  hv.setInt32(4, nFrames, true);
  hv.setInt32(12, 1, true);
  hv.setFloat32(40, 0.5, true);
  hv.setInt32(44, 1, true); // has cell
  hv.setInt32(80, 24, true); // CHARMM
  record(header);
  const title = new Uint8Array(4 + titleBytes);
  new DataView(title.buffer).setInt32(0, 1, true);
  record(title);
  const natom = new Uint8Array(4);
  new DataView(natom.buffer).setInt32(0, nAtoms, true);
  record(natom);
  for (let f = 0; f < nFrames; f++) {
    const cell = new Float64Array([10 + f, 90, 10 + f, 90, 90, 10 + f]);
    record(new Uint8Array(cell.buffer));
    for (let axis = 0; axis < 3; axis++) {
      const c = Float32Array.from({ length: nAtoms }, (_, a) => f + a + axis * 0.5);
      record(new Uint8Array(c.buffer));
    }
  }
  return Uint8Array.from(parts);
}

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(readFileSync(join(ROOT, "crates/megane-wasm/pkg/megane_wasm_bg.wasm"))),
  );
});

describe("parseTrajectoryCore warnings", () => {
  it("reports a DCD's dropped incomplete last frame, and nothing for a whole file", () => {
    const whole = fixture("water.dcd");
    expect(parseTrajectoryCore({ kind: "dcd", bytes: whole, expectedNAtoms: 3 }).warnings).toEqual(
      [],
    );
    // 60 bytes short: the last frame keeps its cell record but loses X, Y, Z.
    const cut = whole.slice(0, whole.length - 60);
    const out = parseTrajectoryCore({ kind: "dcd", bytes: cut, expectedNAtoms: 3 });
    expect(out.frames).toHaveLength(4);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/^DCD: frame 5 is incomplete .*the last 56 bytes/);
  });
});

describe("indexBinaryTrajectoryFileCore", () => {
  it.each([
    ["dcd", "water.dcd"],
    ["netcdf", "water.nc"],
  ] as const)("matches the eager %s parse frame for frame", async (kind, name) => {
    const bytes = fixture(name);
    const eager = parseTrajectoryCore({ kind, bytes, expectedNAtoms: 3 });
    const { decoder, index } = await indexBinaryTrajectoryFileCore(new Blob([bytes]), kind, 3);
    expect(index.nAtoms).toBe(eager.meta.nAtoms);
    expect(index.nFrames).toBe(eager.frames.length);
    expect(index.timestepPs).toBeCloseTo(eager.meta.timestepPs, 5);
    for (let f = 0; f < index.nFrames; f++) {
      const got = await decoder.decodeFrame(f);
      expect(got.positions).toEqual(eager.frames[f].positions);
      expect(got.vectors).toHaveLength(0);
      if (eager.frames[f].box) expect(got.box).toEqual(eager.frames[f].box);
    }
    await expect(decoder.decodeFrame(index.nFrames)).rejects.toThrow(/out of range/);
    decoder.free();
  });

  it("reads the header, then each frame's own bytes, and follows a changing cell", async () => {
    const bytes = dcdWithCells(4, 6);
    const eager = parseTrajectoryCore({ kind: "dcd", bytes, expectedNAtoms: 4 });
    const { read, reads } = recordingReader(bytes);
    const file = new Blob([bytes]);
    const { decoder, index } = await indexBinaryTrajectoryFileCore(file, "dcd", 4, read);
    expect(reads[0]).toEqual([0, Math.min(BINARY_HEAD_MIN, bytes.length)]);
    expect(index.hasBox).toBe(true);
    expect(index.box?.[0]).toBeCloseTo(10);
    for (const f of [5, 2]) {
      const got = await decoder.decodeFrame(f);
      expect(got.positions).toEqual(eager.frames[f].positions);
      expect(got.box?.[0]).toBeCloseTo(10 + f);
      expect(got.box).toEqual(eager.frames[f].box);
    }
    decoder.free();
  });

  it("reads a longer head when the header does not fit the first one", async () => {
    const bytes = dcdWithCells(2, 2, BINARY_HEAD_MIN + 1000);
    const { index, decoder } = await indexBinaryTrajectoryFileCore(new Blob([bytes]), "dcd", 2);
    expect(index.nFrames).toBe(2);
    decoder.free();
  });

  it("rejects a file that is not the format, or the wrong atom count", async () => {
    const junk = new Blob([new Uint8Array(100)]);
    await expect(indexBinaryTrajectoryFileCore(junk, "dcd", 3)).rejects.toThrow(/DCD/);
    await expect(indexBinaryTrajectoryFileCore(junk, "netcdf", 3)).rejects.toThrow(/NetCDF/);
    const dcd = new Blob([fixture("water.dcd")]);
    await expect(indexBinaryTrajectoryFileCore(dcd, "dcd", 7)).rejects.toThrow(/atom count \(3\)/);
    const nc = new Blob([fixture("water.nc")]);
    await expect(indexBinaryTrajectoryFileCore(nc, "netcdf", 7)).rejects.toThrow(
      /NetCDF atom count/,
    );
  });
});
