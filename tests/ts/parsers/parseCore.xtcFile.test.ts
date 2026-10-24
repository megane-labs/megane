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
    expect(await decoder.decodeFrame(0)).toHaveLength(N_ATOMS * 3);
  });
});
