// @vitest-environment node
/**
 * The file-backed lazy ASE `.traj` decoder (`indexTrajFileCore`) against the
 * real WASM module: the index comes from the header, the offset table and each
 * frame's own bytes, frame 0 equals the eager parse's snapshot, and every
 * extra frame read from its own bytes equals the eager parse's.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureInit,
  indexTrajFileCore,
  parseStructureCore,
  TRAJ_HEADER_BYTES,
  type BlobRangeReader,
  type FileFrameDecoder,
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

const eagerTraj = (bytes: Uint8Array) => parseStructureCore({ ext: ".traj", bytes });

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(readFileSync(join(ROOT, "crates/megane-wasm/pkg/megane_wasm_bg.wasm"))),
  );
});

describe("indexTrajFileCore", () => {
  it.each(["water.traj", "bond_change.traj"])(
    "matches the eager parse of %s frame for frame",
    async (name) => {
      const bytes = fixture(name);
      const eager = eagerTraj(bytes);
      const { decoder, index, frame0 } = await indexTrajFileCore(new Blob([bytes]));
      expect(index).toEqual({
        nAtoms: eager.snapshot.nAtoms,
        nFrames: eager.frames.length,
        heterogeneous: false,
      });
      expect(frame0.snapshot.positions).toEqual(eager.snapshot.positions);
      expect(frame0.snapshot.elements).toEqual(eager.snapshot.elements);
      expect(frame0.snapshot.bonds).toEqual(eager.snapshot.bonds);
      expect(frame0.snapshot.box).toEqual(eager.snapshot.box);
      const lazy = decoder as FileFrameDecoder;
      expect(lazy.n_atoms).toBe(eager.snapshot.nAtoms);
      for (let f = 0; f < index.nFrames; f++) {
        const got = await lazy.decodeFrame(f);
        expect(got.positions).toEqual(eager.frames[f].positions);
        expect(got.vectors).toHaveLength(0);
        expect(got.box).toBeUndefined();
      }
      await expect(lazy.decodeFrame(index.nFrames)).rejects.toThrow(/out of range/);
      await expect(lazy.decodeFrame(-1)).rejects.toThrow(/out of range/);
      lazy.free();
    },
  );

  it("reads the header, the table and then the frames in order", async () => {
    const bytes = fixture("water.traj");
    const { read, reads } = recordingReader(bytes);
    const { decoder, index } = await indexTrajFileCore(new Blob([bytes]), read);
    expect(reads[0]).toEqual([0, TRAJ_HEADER_BYTES]);
    // The header's table offset and item count.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const nItems = Number(view.getBigInt64(32, true));
    const pos0 = Number(view.getBigInt64(40, true));
    expect(reads[1]).toEqual([pos0, pos0 + nItems * 8]);
    expect(index.nFrames).toBe(nItems - 1);
    // The whole (small) file is then one read-ahead span.
    expect(reads.slice(2)).toEqual([[0, bytes.length]]);
    (decoder as FileFrameDecoder).free();
  });

  it("gives every frame of a changing cell its own box", async () => {
    const bytes = fixture("water_var_cell.traj");
    const eager = eagerTraj(bytes);
    const { decoder, index } = await indexTrajFileCore(new Blob([bytes]));
    expect(index.heterogeneous).toBe(false);
    const lazy = decoder as FileFrameDecoder;
    for (let f = 0; f < index.nFrames; f++) {
      const got = await lazy.decodeFrame(f);
      expect(got.positions).toEqual(eager.frames[f].positions);
      expect(got.box).toEqual(eager.frames[f].box);
    }
    expect((await lazy.decodeFrame(3)).box?.[0]).toBeGreaterThan(eager.snapshot.box![0]);
    lazy.free();
  });

  it.each(["water_var_atoms.traj", "water_var_topology.traj"])(
    "reports %s, whose atoms change, as heterogeneous",
    async (name) => {
      const { decoder, index } = await indexTrajFileCore(new Blob([fixture(name)]));
      expect(index.heterogeneous).toBe(true);
      (decoder as FileFrameDecoder).free();
    },
  );

  it("rejects a file that is not a .traj", async () => {
    await expect(indexTrajFileCore(new Blob([new Uint8Array(100)]))).rejects.toThrow(/ULM/);
    // A table pointing past the end of the file.
    const bytes = fixture("water.traj").slice();
    const view = new DataView(bytes.buffer);
    const pos0 = Number(view.getBigInt64(40, true));
    view.setBigInt64(pos0, 1n << 40n, true);
    await expect(indexTrajFileCore(new Blob([bytes]))).rejects.toThrow(/past EOF/);
  });
});
