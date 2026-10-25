// @vitest-environment node
/**
 * The file-backed lazy decoders for multi-frame text files
 * (`indexStructureFileCore` for XYZ / PDB, `indexDumpFileCore` for LAMMPS
 * dumps) against the real WASM module: same index, frame 0 and frames as the
 * decoders that hold the whole file in WASM memory, whatever window the scan
 * reads, while reading only the bytes each step needs.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureInit,
  indexStructureCore,
  indexStructureFileCore,
  indexTrajectoryCore,
  indexDumpFileCore,
  decodeLazyFrameCore,
  TEXT_INDEX_WINDOW,
  readAheadReader,
  type BlobRangeReader,
} from "@/parsers/parseCore";

const ROOT = process.cwd();
const enc = new TextEncoder();

function recordingReader(bytes: Uint8Array) {
  const reads: [number, number][] = [];
  const read: BlobRangeReader = async (_blob, start, end) => {
    reads.push([start, end]);
    return bytes.slice(start, end).buffer;
  };
  return { read, reads };
}

/** A multi-frame XYZ of `nFrames` frames of a 3-atom water drifting along x. */
function xyzText(nFrames: number): string {
  let out = "";
  for (let f = 0; f < nFrames; f++) {
    out += `3\nframe ${f}\n`;
    out += `O ${(f * 0.1).toFixed(3)} 0.000 0.000\n`;
    out += `H ${(0.96 + f * 0.1).toFixed(3)} 0.000 0.000\n`;
    out += `H ${(f * 0.1).toFixed(3)} 0.960 0.000\n`;
  }
  return out;
}

/** A multi-MODEL PDB with shared CONECT records after the last model. */
function pdbText(nModels: number, between = ""): string {
  let out = "CRYST1   20.000   20.000   20.000  90.00  90.00  90.00 P 1           1\n";
  for (let m = 0; m < nModels; m++) {
    out += `MODEL     ${String(m + 1).padStart(4)}\n`;
    ["O", "H", "H"].forEach((el, a) => {
      const x = (a * 0.9 + m * 0.05).toFixed(3).padStart(8);
      out += `HETATM${String(a + 1).padStart(5)}  ${el.padEnd(3)} HOH A   1    ${x}   0.000   0.000  1.00  0.00           ${el.padStart(2)}  \n`;
    });
    out += "ENDMDL\n";
    if (m === 0) out += between;
  }
  return out + "CONECT    1    2    3\nEND\n";
}

/** A LAMMPS dump with velocities: `nFrames` frames of 4 atoms. */
function dumpText(nFrames: number): string {
  let out = "";
  for (let f = 0; f < nFrames; f++) {
    out += `ITEM: TIMESTEP\n${f * 10}\nITEM: NUMBER OF ATOMS\n4\n`;
    out += "ITEM: BOX BOUNDS pp pp pp\n-1.0 9.0\n0.0 10.0\n0.0 10.0\n";
    out += "ITEM: ATOMS id type x y z vx vy vz\n";
    for (let a = 4; a >= 1; a--) {
      out += `${a} 1 ${a + f * 0.01} ${a * 2} 0.5 ${f} ${a} -1\n`;
    }
  }
  return out;
}

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(readFileSync(join(ROOT, "crates/megane-wasm/pkg/megane_wasm_bg.wasm"))),
  );
});

describe("indexStructureFileCore", () => {
  it.each(["xyz", "pdb"] as const)(
    "matches the in-memory %s decoder's index, frame 0 and frames",
    async (kind) => {
      const bytes = enc.encode(kind === "xyz" ? xyzText(12) : pdbText(12));
      const whole = indexStructureCore(bytes, kind);
      for (const window of [TEXT_INDEX_WINDOW, 64, 7]) {
        const { read } = recordingReader(bytes);
        const got = await indexStructureFileCore(new Blob([bytes]), kind, read, window);
        expect(got.index).toEqual(whole.index);
        expect(got.frame0.snapshot.positions).toEqual(whole.frame0.snapshot.positions);
        expect(got.frame0.snapshot.elements).toEqual(whole.frame0.snapshot.elements);
        expect(got.frame0.snapshot.bonds).toEqual(whole.frame0.snapshot.bonds);
        expect(got.frame0.snapshot.nFileBonds).toBe(whole.frame0.snapshot.nFileBonds);
        expect(got.frame0.snapshot.box).toEqual(whole.frame0.snapshot.box);
        for (const frame of [0, 5, whole.index.nFrames - 1]) {
          const a = await decodeLazyFrameCore(got.decoder, frame);
          const b = await decodeLazyFrameCore(whole.decoder, frame);
          expect(a.positions).toEqual(b.positions);
        }
        got.decoder.free();
      }
      whole.decoder.free();
    },
  );

  it("reads frame 0 and each later frame from just their bytes", async () => {
    const text = xyzText(20);
    const bytes = enc.encode(text);
    const { read, reads } = recordingReader(bytes);
    const { decoder } = await indexStructureFileCore(new Blob([bytes]), "xyz", read, 50);
    // The scan read the file in order, each window where the last complete line ended.
    const scan = reads.filter(([s, e]) => e - s <= 50);
    expect(scan[0][0]).toBe(0);
    expect(scan[scan.length - 1][1]).toBe(bytes.length);
    // Frame 0 came from the bytes before the second frame, not the whole file.
    const frame1At = text.indexOf("3\nframe 1");
    expect(reads).toContainEqual([0, frame1At]);
    reads.length = 0;
    const { positions } = await decodeLazyFrameCore(decoder, 2); // frame 3 of the file
    // One read from frame 3 on brings in the frames after it too…
    expect(reads).toEqual([[text.indexOf("3\nframe 3"), bytes.length]]);
    expect(positions[0]).toBeCloseTo(0.3);
    // …so the next frames need no read of their own.
    const next = await decodeLazyFrameCore(decoder, 3);
    expect(next.positions[0]).toBeCloseTo(0.4);
    expect(reads).toHaveLength(1);
    await expect(decoder.decodeFrame(19)).rejects.toThrow(/out of range/);
  });

  it("takes a PDB's trailing records into model 0", async () => {
    const bytes = enc.encode(pdbText(3));
    const { frame0, index } = await indexStructureFileCore(new Blob([bytes]), "pdb");
    expect(index.nFrames).toBe(2);
    expect(frame0.snapshot.nFileBonds).toBe(2);
  });

  it("parses model 0 from the whole file when records sit between models", async () => {
    const bytes = enc.encode(pdbText(3, "CONECT    2    3\n"));
    const got = await indexStructureFileCore(new Blob([bytes]), "pdb");
    // The in-memory decoder (it decodes frames itself, synchronously).
    expect("decode_frame" in got.decoder).toBe(true);
    expect(got.index.nFrames).toBe(2);
    got.decoder.free();
  });

  it("grows the window for a line longer than it", async () => {
    const bytes = enc.encode(xyzText(3).replace("frame 1", "frame 1 " + "x".repeat(300)));
    const { index } = await indexStructureFileCore(new Blob([bytes]), "xyz", undefined, 16);
    expect(index.nFrames).toBe(2);
  });

  it("rejects a file that is not text", async () => {
    await expect(
      indexStructureFileCore(new Blob([new Uint8Array([0xff, 0xfe, 0x0a])]), "xyz"),
    ).rejects.toThrow(/UTF-8/);
  });
});

describe("indexDumpFileCore", () => {
  it("matches the in-memory dump decoder's index, frames and vectors", async () => {
    const bytes = enc.encode(dumpText(15));
    const whole = indexTrajectoryCore(bytes, "lammpstrj", 4);
    for (const window of [TEXT_INDEX_WINDOW, 100]) {
      const { read } = recordingReader(bytes);
      const { decoder, index } = await indexDumpFileCore(new Blob([bytes]), 4, read, window);
      expect(index).toEqual(whole.index);
      expect(index.vectorChannelNames).toEqual(["velocity"]);
      for (const frame of [0, 7, 14]) {
        const a = await decodeLazyFrameCore(decoder, frame);
        const b = await decodeLazyFrameCore(whole.decoder, frame);
        expect(a.positions).toEqual(b.positions);
        expect(a.vectors).toEqual(b.vectors);
        expect(a.vectors.length).toBe(12);
      }
    }
    whole.decoder.free();
  });

  it("rejects a dump whose atom count does not match the structure", async () => {
    const file = new Blob([enc.encode(dumpText(2))]);
    await expect(indexDumpFileCore(file, 9)).rejects.toThrow(/atom count \(4\)/);
  });

  it("reports a jagged dump as heterogeneous", async () => {
    const file = new Blob([readFileSync(join(ROOT, "tests/fixtures/hetero_atoms.lammpstrj"))]);
    const { index } = await indexDumpFileCore(file, 2);
    expect(index.heterogeneous).toBe(true);
  });
});

describe("readAheadReader", () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const file = new Blob([bytes]);

  it("serves ranges inside the last spans it read without reading again", async () => {
    const { read, reads } = recordingReader(bytes);
    const r = readAheadReader(file, read, 30);
    expect(Array.from(await r(10, 12))).toEqual([10, 11]);
    expect(Array.from(await r(20, 22))).toEqual([20, 21]);
    expect(reads).toEqual([[10, 40]]);
    await r(50, 52); // a second span…
    await r(12, 14); // …the first is still held
    expect(reads).toEqual([
      [10, 40],
      [50, 80],
    ]);
    await r(90, 95); // a third drops the oldest
    await r(10, 12);
    expect(reads).toHaveLength(4);
  });

  it("shares one read between requests made at once", async () => {
    const { read, reads } = recordingReader(bytes);
    const r = readAheadReader(file, read, 30);
    const got = await Promise.all([r(0, 5), r(5, 10), r(25, 30)]);
    expect(got.map((g) => g[0])).toEqual([0, 5, 25]);
    expect(reads).toEqual([[0, 30]]);
  });

  it("reads a range larger than a span on its own, and stops at the end", async () => {
    const { read, reads } = recordingReader(bytes);
    const r = readAheadReader(file, read, 30);
    expect((await r(0, 60)).length).toBe(60);
    expect((await r(90, 100)).length).toBe(10);
    expect(reads).toEqual([
      [0, 60],
      [90, 100],
    ]);
  });

  it("forgets a span whose read failed", async () => {
    let fail = true;
    const read: BlobRangeReader = async (_b, s, e) => {
      if (fail) throw new Error("gone");
      return bytes.slice(s, e).buffer;
    };
    const r = readAheadReader(file, read, 30);
    await expect(r(0, 4)).rejects.toThrow("gone");
    fail = false;
    expect(Array.from(await r(0, 2))).toEqual([0, 1]);
  });
});
