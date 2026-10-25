// @vitest-environment node
/**
 * The file-backed lazy XTC decoder (`indexXtcFileCore`) against the real WASM
 * module: it must produce the same index and bit-identical frames as the
 * decoder that holds the whole file in WASM memory, whatever window size the
 * index scan reads, while reading only the bytes it needs.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureInit,
  indexTrajectoryCore,
  indexXtcFileCore,
  decodeLazyFrameCore,
  parseTrajectoryCore,
  XTC_INDEX_WINDOW_MIN,
  type BlobRangeReader,
} from "@/parsers/parseCore";

const ROOT = process.cwd();
const XTC = readFileSync(join(ROOT, "tests/fixtures/1crn_vibration.xtc"));
const N_ATOMS = 327;

/** A reader over `bytes` that records every range it was asked for. */
function recordingReader(bytes: Uint8Array) {
  const reads: [number, number][] = [];
  const read: BlobRangeReader = async (_blob, start, end) => {
    reads.push([start, end]);
    return bytes.slice(start, end).buffer;
  };
  return { read, reads };
}

/**
 * An uncompressed 2-atom XTC (natoms ≤ 9 stores plain floats) whose cubic box
 * edge is `edges[f]` nm in frame f, as an NPT run writes it.
 */
function xtcWithBoxes(edges: number[]): Uint8Array {
  const words: number[] = [];
  const view = new DataView(new ArrayBuffer(4));
  const i32 = (v: number) => {
    view.setInt32(0, v);
    words.push(...new Uint8Array(view.buffer));
  };
  const f32 = (v: number) => {
    view.setFloat32(0, v);
    words.push(...new Uint8Array(view.buffer));
  };
  edges.forEach((edge, f) => {
    i32(1995); // magic
    i32(2); // natoms
    i32(f); // step
    f32(f); // time (ps)
    for (const v of [edge, 0, 0, 0, edge, 0, 0, 0, edge]) f32(v);
    i32(2); // lsize
    for (let c = 0; c < 6; c++) f32(f + c * 0.1);
  });
  return Uint8Array.from(words);
}

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(readFileSync(join(ROOT, "crates/megane-wasm/pkg/megane_wasm_bg.wasm"))),
  );
});

describe("indexXtcFileCore", () => {
  it("matches the in-memory decoder's index and frames", async () => {
    const whole = indexTrajectoryCore(new Uint8Array(XTC), "xtc", N_ATOMS);
    const { decoder, index } = await indexXtcFileCore(new Blob([XTC]), N_ATOMS);
    expect(index).toEqual({ ...whole.index, boxOrigin: null });
    for (const frame of [0, 1, 50, index.nFrames - 1]) {
      const fromFile = await decodeLazyFrameCore(decoder, frame);
      const fromMemory = await decodeLazyFrameCore(whole.decoder, frame);
      expect(fromFile.positions).toEqual(fromMemory.positions);
      expect(fromFile.vectors).toHaveLength(0);
    }
    decoder.free();
    whole.decoder.free();
  });

  it("indexes from windows and reads each frame's own bytes", async () => {
    const { read, reads } = recordingReader(new Uint8Array(XTC));
    const { decoder, index } = await indexXtcFileCore(new Blob([XTC]), N_ATOMS, read);
    // The scan windows run through the file in order — each starts at the next
    // frame header, re-reading at most the part of one it could not finish —
    // and grow from the first window size while they keep holding several frames.
    expect(reads[0]).toEqual([0, XTC_INDEX_WINDOW_MIN]);
    for (let i = 1; i < reads.length; i++) {
      expect(reads[i][0]).toBeGreaterThan(reads[i - 1][1] - 92);
    }
    expect(reads[reads.length - 1][1]).toBe(XTC.length);
    expect(reads[1][1] - reads[1][0]).toBe(
      Math.min(2 * XTC_INDEX_WINDOW_MIN, XTC.length - reads[1][0]),
    );
    reads.length = 0;
    await decoder.decodeFrame(3);
    await decoder.decodeFrame(index.nFrames - 1);
    const frameBytes = XTC.length / index.nFrames;
    expect(reads).toHaveLength(2);
    for (const [start, end] of reads) expect(end - start).toBeCloseTo(frameBytes, -3);
    expect(reads[1][1]).toBe(XTC.length);
  });

  it("rejects a trajectory whose atom count does not match the structure", async () => {
    await expect(indexXtcFileCore(new Blob([XTC]), 12)).rejects.toThrow(/atom count \(327\)/);
  });

  it("rejects a truncated file and frames out of range", async () => {
    await expect(
      indexXtcFileCore(new Blob([XTC.subarray(0, XTC.length - 8)]), N_ATOMS),
    ).rejects.toThrow();
    const { decoder, index } = await indexXtcFileCore(new Blob([XTC]), N_ATOMS);
    await expect(decoder.decodeFrame(index.nFrames)).rejects.toThrow(/out of range/);
    await expect(decoder.decodeFrame(-1)).rejects.toThrow(/out of range/);
  });

  it("reads through the Blob API by default", async () => {
    const { decoder } = await indexXtcFileCore(new Blob([XTC]), N_ATOMS);
    expect((await decoder.decodeFrame(0)).positions).toHaveLength(N_ATOMS * 3);
  });

  it("gives every frame its own box when the box changes, as the eager parse does", async () => {
    // Box 3 → 4 → 5 nm: the eager frames carry 30 / 40 / 50 Å cells.
    const bytes = xtcWithBoxes([3, 4, 5]);
    const eager = parseTrajectoryCore({ kind: "xtc", bytes, expectedNAtoms: 2 });
    expect(eager.frames.map((f) => f.box?.[0])).toEqual([30, 40, 50]);
    const file = await indexXtcFileCore(new Blob([bytes]), 2);
    const memory = indexTrajectoryCore(bytes, "xtc", 2);
    for (const { decoder, index } of [file, memory]) {
      expect(index.frameCells).toBe(true);
      // Frame 0's box is the representative cell, not the last frame's.
      expect(index.box?.[0]).toBe(30);
      for (let f = 0; f < eager.frames.length; f++) {
        const got = await decodeLazyFrameCore(decoder, f);
        expect(got.positions).toEqual(eager.frames[f].positions);
        expect(got.box).toEqual(eager.frames[f].box);
      }
    }
    memory.decoder.free();
  });

  it("leaves frames on the base cell when the box stays put", async () => {
    const bytes = xtcWithBoxes([3, 3]);
    const eager = parseTrajectoryCore({ kind: "xtc", bytes, expectedNAtoms: 2 });
    const file = await indexXtcFileCore(new Blob([bytes]), 2);
    const memory = indexTrajectoryCore(bytes, "xtc", 2);
    for (const { decoder, index } of [file, memory]) {
      expect(index.frameCells).toBe(false);
      expect(index.box?.[0]).toBe(30);
      for (let f = 0; f < 2; f++) {
        expect(eager.frames[f].box).toBeUndefined();
        expect((await decodeLazyFrameCore(decoder, f)).box).toBeUndefined();
      }
    }
    memory.decoder.free();
  });
});
