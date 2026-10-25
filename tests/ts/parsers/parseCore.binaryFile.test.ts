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

/**
 * A CDF-1 AMBER NetCDF of `nFrames` frames of `nAtoms` atoms with `time`,
 * `coordinates`, `velocities` (with AMBER's `scale_factor` 20.455) and `forces`
 * record variables. Frame f's coordinate k is `f*100 + k`, its stored velocity
 * `f + k/10`, its force `-(f + k)`.
 */
function netcdfWithVectors(nAtoms: number, nFrames: number): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v);
    out.push(...b);
  };
  const f32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v);
    out.push(...b);
  };
  const name = (s: string) => {
    u32(s.length);
    out.push(...new TextEncoder().encode(s));
    while (out.length % 4 !== 0) out.push(0);
  };
  const vsize = nAtoms * 12;
  const header = (begin: number) => {
    out.length = 0;
    out.push(...new TextEncoder().encode("CDF\x01"));
    u32(nFrames);
    u32(10); // NC_DIMENSION
    u32(3);
    for (const [dim, size] of [
      ["frame", 0],
      ["atom", nAtoms],
      ["spatial", 3],
    ] as const) {
      name(dim);
      u32(size);
    }
    u32(0); // no global attributes
    u32(0);
    u32(11); // NC_VARIABLE
    u32(4);
    let at = begin;
    for (const [v, dims, size] of [
      ["time", [0], 4],
      ["coordinates", [0, 1, 2], vsize],
      ["velocities", [0, 1, 2], vsize],
      ["forces", [0, 1, 2], vsize],
    ] as const) {
      name(v);
      u32(dims.length);
      for (const d of dims) u32(d);
      if (v === "velocities") {
        u32(12); // NC_ATTRIBUTE
        u32(1);
        name("scale_factor");
        u32(5); // NC_FLOAT
        u32(1);
        f32(20.455);
      } else {
        u32(0);
        u32(0);
      }
      u32(5); // NC_FLOAT
      u32(size);
      u32(at);
      at += size;
    }
    return out.length;
  };
  header(header(0));
  for (let f = 0; f < nFrames; f++) {
    f32(f);
    for (let k = 0; k < nAtoms * 3; k++) f32(f * 100 + k);
    for (let k = 0; k < nAtoms * 3; k++) f32(f + k / 10);
    for (let k = 0; k < nAtoms * 3; k++) f32(-(f + k));
  }
  return Uint8Array.from(out);
}

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(readFileSync(join(ROOT, "crates/megane-wasm/pkg/megane_wasm_bg.wasm"))),
  );
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

  it("streams NetCDF velocities and forces with each frame, as the eager parse has them", async () => {
    const bytes = netcdfWithVectors(2, 3);
    const eager = parseTrajectoryCore({ kind: "netcdf", bytes, expectedNAtoms: 2 });
    expect(eager.vectorChannels.map((c) => c.name)).toEqual(["velocity", "force"]);
    const [velocity, force] = eager.vectorChannels;
    // Stored velocities times the file's scale_factor (Å/ps).
    expect(velocity.frames[1].vectors[0]).toBeCloseTo(1 * 20.455, 3);
    expect(Array.from(force.frames[2].vectors)).toEqual([-2, -3, -4, -5, -6, -7]);
    const { decoder, index } = await indexBinaryTrajectoryFileCore(new Blob([bytes]), "netcdf", 2);
    expect(index.vectorChannelNames).toEqual(["velocity", "force"]);
    for (let f = 0; f < 3; f++) {
      const got = await decoder.decodeFrame(f);
      expect(got.positions).toEqual(eager.frames[f].positions);
      expect(Array.from(got.vectors)).toEqual([
        ...velocity.frames[f].vectors,
        ...force.frames[f].vectors,
      ]);
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
