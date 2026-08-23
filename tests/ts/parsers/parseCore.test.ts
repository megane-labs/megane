/**
 * Unit tests for the pure result-extraction logic in parseCore.
 *
 * These feed a hand-built mock WASM result object (no real WASM, no Worker) to
 * `parseWithFn` / `extractFrames` and assert the Snapshot / Frame[] / meta /
 * vectorChannels shapes. This locks the "results unchanged" invariant that the
 * worker and synchronous paths both depend on, and covers the frame striding,
 * has_box / has_bfactors gating, CA arrays, and free() call.
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseWithFn,
  extractFrames,
  collectResultBuffers,
  type StructureParseResult,
  type XTCParseResult,
} from "@/parsers/parseCore";

interface MockStructureOpts {
  nAtoms: number;
  nFrames?: number;
  hasBox?: boolean;
  hasBfactors?: boolean;
  hasChainIds?: boolean;
  caCount?: number;
  labels?: string | null;
  scalarChannelMeta?: string;
  scalarChannelData?: Float32Array;
  warnings?: string;
}

function makeStructureResult(opts: MockStructureOpts) {
  const { nAtoms, nFrames = 0, hasBox = false, hasBfactors = false, hasChainIds = false } = opts;
  const caCount = opts.caCount ?? 0;
  const positions = Float32Array.from({ length: nAtoms * 3 }, (_, i) => i);
  const frameData = Float32Array.from({ length: nFrames * nAtoms * 3 }, (_, i) => 1000 + i);
  const free = vi.fn();
  return {
    result: {
      n_atoms: nAtoms,
      n_bonds: 1,
      n_file_bonds: 0,
      n_frames: nFrames,
      has_box: hasBox,
      has_atom_labels: opts.labels != null,
      has_chain_ids: hasChainIds,
      has_bfactors: hasBfactors,
      atom_labels: opts.labels ?? "",
      vector_channel_count: 0,
      vector_channel_meta: "[]",
      scalar_channel_count: opts.scalarChannelMeta ? 1 : 0,
      scalar_channel_meta: opts.scalarChannelMeta ?? "[]",
      warnings: opts.warnings ?? "",
      ca_count: caCount,
      symmetry_op_count: 0,
      symmetry_ops: "",
      positions: () => positions,
      elements: () => Uint8Array.from({ length: nAtoms }, () => 6),
      bonds: () => Uint32Array.from([0, 1]),
      bond_orders: () => Uint8Array.from([1]),
      box_matrix: () => Float32Array.from({ length: 9 }, (_, i) => i),
      box_origin: () => Float32Array.from([100, 200, 300]),
      frame_data: () => frameData,
      chain_ids: () => Uint8Array.from({ length: nAtoms }, () => 65),
      bfactors: () => Float32Array.from({ length: nAtoms }, () => 1.5),
      vector_channel_data: () => new Float32Array(),
      scalar_channel_data: () => opts.scalarChannelData ?? new Float32Array(),
      ca_indices: () => Uint32Array.from({ length: caCount }, (_, i) => i),
      ca_chain_ids: () => Uint8Array.from({ length: caCount }, () => 65),
      ca_res_nums: () => Uint32Array.from({ length: caCount }, (_, i) => i + 1),
      ca_ss_type: () => Uint8Array.from({ length: caCount }, () => 1),
      free,
    },
    free,
  };
}

describe("parseWithFn", () => {
  it("builds a Snapshot and calls free()", () => {
    const { result, free } = makeStructureResult({ nAtoms: 2 });
    const out: StructureParseResult = parseWithFn(() => result as never, "");
    expect(out.snapshot.nAtoms).toBe(2);
    expect(out.snapshot.positions).toEqual(Float32Array.from([0, 1, 2, 3, 4, 5]));
    expect(out.snapshot.box).toBeNull();
    expect(out.snapshot.atomBFactors).toBeNull();
    expect(out.snapshot.atomChainIds).toBeNull();
    expect(out.frames).toHaveLength(0);
    expect(out.meta).toBeNull();
    expect(free).toHaveBeenCalledOnce();
  });

  it("exposes optional box / bfactors / chainIds / CA arrays when present", () => {
    const { result } = makeStructureResult({
      nAtoms: 2,
      hasBox: true,
      hasBfactors: true,
      hasChainIds: true,
      caCount: 1,
    });
    const out = parseWithFn(() => result as never, "");
    expect(out.snapshot.box).toEqual(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(out.snapshot.boxOrigin).toEqual(Float32Array.from([100, 200, 300]));
    expect(out.snapshot.atomBFactors).toEqual(Float32Array.from([1.5, 1.5]));
    expect(out.snapshot.atomChainIds).toEqual(Uint8Array.from([65, 65]));
    expect(out.snapshot.caIndices).toEqual(Uint32Array.from([0]));
    expect(out.snapshot.caSsType).toEqual(Uint8Array.from([1]));
  });

  it("slices extra frames from one shared backing buffer (frame striding)", () => {
    const { result } = makeStructureResult({ nAtoms: 2, nFrames: 2 });
    const out = parseWithFn(() => result as never, "");
    expect(out.frames).toHaveLength(2);
    // frame N is a view starting at 1000 + N*6
    expect(out.frames[0].frameId).toBe(1);
    expect(Array.from(out.frames[0].positions)).toEqual([1000, 1001, 1002, 1003, 1004, 1005]);
    expect(Array.from(out.frames[1].positions)).toEqual([1006, 1007, 1008, 1009, 1010, 1011]);
    // Both frames share the single frame_data buffer.
    expect(out.frames[0].positions.buffer).toBe(out.frames[1].positions.buffer);
    expect(out.meta).toEqual({ nFrames: 3, timestepPs: 1.0, nAtoms: 2 });
  });

  it("splits atom labels when present", () => {
    const { result } = makeStructureResult({ nAtoms: 2, labels: "A\nB" });
    const out = parseWithFn(() => result as never, "");
    expect(out.labels).toEqual(["A", "B"]);
  });

  it("deserializes per-atom scalar channels (charge etc.)", () => {
    const { result } = makeStructureResult({
      nAtoms: 2,
      scalarChannelMeta: '[{"name":"charge", "n_frames":2}]',
      scalarChannelData: Float32Array.from([0.5, -0.5, 0.25, -0.25]),
    });
    const out = parseWithFn(() => result as never, "");
    expect(out.scalarChannels).toHaveLength(1);
    expect(out.scalarChannels[0].name).toBe("charge");
    expect(out.scalarChannels[0].frames).toHaveLength(2);
    expect(Array.from(out.scalarChannels[0].frames[0].values)).toEqual([0.5, -0.5]);
    expect(Array.from(out.scalarChannels[0].frames[1].values)).toEqual([0.25, -0.25]);
  });

  it("returns empty scalar channels for a channel-free file", () => {
    const { result } = makeStructureResult({ nAtoms: 2 });
    const out = parseWithFn(() => result as never, "");
    expect(out.scalarChannels).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it("surfaces parser warnings via console.warn and the result", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = makeStructureResult({
      nAtoms: 2,
      warnings: "2 atoms without coordinates were dropped\n1 bond skipped",
    });
    const out = parseWithFn(() => result as never, "");
    expect(out.warnings).toEqual(["2 atoms without coordinates were dropped", "1 bond skipped"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[megane parser] 1 bond skipped");
    warn.mockRestore();
  });
});

/**
 * Build a heterogeneous structure result: 2 extra frames with differing atom
 * counts (2 then 3 atoms), per-frame elements, cells, and bonds.
 */
function makeHeteroResult() {
  const free = vi.fn();
  const nAtoms0 = 2; // frame 0 (the snapshot)
  const positions0 = Float32Array.from({ length: nAtoms0 * 3 }, (_, i) => i);
  // Extra frames: frame1 = 2 atoms, frame2 = 3 atoms.
  const atomOffsets = Uint32Array.from([0, 2, 5]); // prefix sum over extra frames
  const framePos = Float32Array.from({ length: 5 * 3 }, (_, i) => 100 + i);
  const frameElems = Uint8Array.from([6, 6, 7, 7, 7]); // C,C then N,N,N
  const frameCells = Float32Array.from({ length: 2 * 9 }, (_, i) => i);
  const bondOffsets = Uint32Array.from([0, 1, 2]); // 1 bond each frame (pairs)
  const frameBonds = Uint32Array.from([0, 1, 1, 2]);
  return {
    result: {
      n_atoms: nAtoms0,
      n_bonds: 1,
      n_file_bonds: 0,
      n_frames: 2,
      has_box: true,
      has_atom_labels: false,
      has_chain_ids: false,
      has_bfactors: false,
      atom_labels: "",
      vector_channel_count: 0,
      vector_channel_meta: "[]",
      ca_count: 0,
      symmetry_op_count: 0,
      symmetry_ops: "",
      positions: () => positions0,
      elements: () => Uint8Array.from({ length: nAtoms0 }, () => 6),
      bonds: () => Uint32Array.from([0, 1]),
      bond_orders: () => Uint8Array.from([1]),
      box_matrix: () => Float32Array.from({ length: 9 }, (_, i) => i),
      box_origin: () => new Float32Array(),
      frame_data: () => framePos,
      chain_ids: () => new Uint8Array(),
      bfactors: () => new Float32Array(),
      vector_channel_data: () => new Float32Array(),
      ca_indices: () => new Uint32Array(),
      ca_chain_ids: () => new Uint8Array(),
      ca_res_nums: () => new Uint32Array(),
      ca_ss_type: () => new Uint8Array(),
      // Heterogeneous side table.
      heterogeneous: true,
      varies_atoms: true,
      varies_cell: true,
      varies_topology: true,
      max_atoms: 3,
      frame_atom_offsets: () => atomOffsets,
      frame_elements: () => frameElems,
      frame_cells: () => frameCells,
      frame_bond_offsets: () => bondOffsets,
      frame_bonds: () => frameBonds,
      free,
    },
    free,
  };
}

describe("parseWithFn heterogeneous", () => {
  it("keeps uniform frames free of per-frame topology (fast path)", () => {
    const { result } = makeStructureResult({ nAtoms: 2, nFrames: 2 });
    const out = parseWithFn(() => result as never, "");
    expect(out.meta?.heterogeneous).toBeUndefined();
    expect(out.frames[0].elements).toBeUndefined();
    expect(out.frames[0].box).toBeUndefined();
  });

  it("builds jagged frames carrying per-frame elements/bonds/box", () => {
    const { result } = makeHeteroResult();
    const out = parseWithFn(() => result as never, "");
    expect(out.frames).toHaveLength(2);
    // Frame 1: 2 atoms; frame 2: 3 atoms (jagged).
    expect(out.frames[0].nAtoms).toBe(2);
    expect(out.frames[1].nAtoms).toBe(3);
    expect(Array.from(out.frames[0].positions)).toEqual([100, 101, 102, 103, 104, 105]);
    expect(Array.from(out.frames[1].positions)).toEqual([
      106, 107, 108, 109, 110, 111, 112, 113, 114,
    ]);
    // Per-frame elements sliced by offsets.
    expect(Array.from(out.frames[0].elements!)).toEqual([6, 6]);
    expect(Array.from(out.frames[1].elements!)).toEqual([7, 7, 7]);
    // Per-frame cell (9 floats each).
    expect(out.frames[0].box!.length).toBe(9);
    expect(Array.from(out.frames[1].box!)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    // Per-frame bonds.
    expect(Array.from(out.frames[0].bonds!)).toEqual([0, 1]);
    expect(out.frames[1].nBonds).toBe(1);
    // Meta flags.
    expect(out.meta?.heterogeneous).toBe(true);
    expect(out.meta?.maxAtoms).toBe(3);
    expect(out.meta?.variesAtoms).toBe(true);
    expect(out.meta?.nFrames).toBe(3);
  });

  it("omits topology channels that do not vary (cell-only heterogeneity)", () => {
    const { result } = makeHeteroResult();
    // Simulate a var-cell-only trajectory: no per-frame elements/bonds.
    result.frame_elements = () => new Uint8Array();
    result.frame_bonds = () => new Uint32Array();
    result.frame_bond_offsets = () => new Uint32Array();
    result.varies_atoms = false;
    result.varies_topology = false;
    // Same atom count each frame for a valid cell-only case.
    result.frame_atom_offsets = () => Uint32Array.from([0, 2, 4]);
    result.frame_data = () => Float32Array.from({ length: 4 * 3 }, (_, i) => 100 + i);
    const out = parseWithFn(() => result as never, "");
    expect(out.frames[0].elements).toBeUndefined();
    expect(out.frames[0].bonds).toBeUndefined();
    // Cell still present.
    expect(out.frames[0].box!.length).toBe(9);
  });
});

function makeXtcResult(nAtoms: number, nFrames: number) {
  const frameData = Float32Array.from({ length: nFrames * nAtoms * 3 }, (_, i) => i);
  const free = vi.fn();
  return {
    result: {
      n_atoms: nAtoms,
      n_frames: nFrames,
      timestep_ps: 2.0,
      has_box: false,
      vector_channel_count: 0,
      vector_channel_meta: "[]",
      box_matrix: () => new Float32Array(9),
      frame_data: () => frameData,
      vector_channel_data: () => new Float32Array(),
      // Uniform fast path: no side table.
      heterogeneous: false,
      varies_atoms: false,
      varies_cell: false,
      varies_topology: false,
      max_atoms: nAtoms,
      frame_atom_offsets: () => new Uint32Array(0),
      frame_elements: () => new Uint8Array(0),
      frame_cells: () => new Float32Array(0),
      free,
    },
    free,
  };
}

describe("extractFrames", () => {
  it("returns all frames as views with correct meta", () => {
    const { result, free } = makeXtcResult(2, 3);
    const out: XTCParseResult = extractFrames(result as never, 2, "XTC");
    expect(out.frames).toHaveLength(3);
    expect(out.frames[0].frameId).toBe(0);
    expect(Array.from(out.frames[2].positions)).toEqual([12, 13, 14, 15, 16, 17]);
    expect(out.meta).toEqual({ nFrames: 3, timestepPs: 2.0, nAtoms: 2 });
    expect(free).toHaveBeenCalledOnce();
  });

  it("throws and frees on atom-count mismatch", () => {
    const { result, free } = makeXtcResult(2, 1);
    expect(() => extractFrames(result as never, 5, "XTC")).toThrow(/atom count/);
    expect(free).toHaveBeenCalledOnce();
  });

  it("attaches a per-frame box for a variable-cell trajectory (XTC/DCD/NetCDF)", () => {
    // Fixed atom count (frame_atom_offsets empty) but the cell changes each frame.
    const { result } = makeXtcResult(2, 2);
    result.heterogeneous = true;
    result.varies_cell = true;
    result.frame_cells = () =>
      Float32Array.from([10, 0, 0, 0, 10, 0, 0, 0, 10, 12, 0, 0, 0, 12, 0, 0, 0, 12]);
    const out = extractFrames(result as never, 2, "DCD");
    expect(out.frames).toHaveLength(2);
    // Fixed atom count, so positions still slice by stride.
    expect(out.frames[0].nAtoms).toBe(2);
    expect(out.frames[0].box![0]).toBe(10);
    expect(out.frames[1].box![0]).toBe(12);
    expect(out.frames[0].elements).toBeUndefined(); // topology constant
    expect(out.meta.heterogeneous).toBe(true);
    expect(out.meta.variesCell).toBe(true);
  });

  it("slices jagged positions + per-frame elements for a variable-atom trajectory", () => {
    // Frame 0 has 2 atoms, frame 1 has 3 (LAMMPS-style growth).
    const { result } = makeXtcResult(2, 2);
    result.heterogeneous = true;
    result.varies_atoms = true;
    result.varies_topology = true;
    result.max_atoms = 3;
    result.frame_atom_offsets = () => Uint32Array.from([0, 2, 5]);
    result.frame_elements = () => Uint8Array.from([1, 1, 1, 6, 8]);
    result.frame_data = () => Float32Array.from({ length: 5 * 3 }, (_, i) => i);
    const out = extractFrames(result as never, 2, "LAMMPS dump");
    expect(out.frames[0].nAtoms).toBe(2);
    expect(out.frames[1].nAtoms).toBe(3);
    expect(Array.from(out.frames[1].positions)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(Array.from(out.frames[1].elements!)).toEqual([1, 6, 8]);
    expect(out.meta.maxAtoms).toBe(3);
  });
});

describe("remapTrajectoryTypesToElements", () => {
  it("maps LAMMPS type ids to atomic numbers via frame 0 / structure", async () => {
    const { remapTrajectoryTypesToElements } = await import("@/parsers/parseCore");
    // Frame 0: 2 atoms of types [1, 2]; structure elements are [6, 8] (C, O).
    // Frame 1 grows a third atom of type 1 → should become carbon (6).
    const frames = [
      { frameId: 0, nAtoms: 2, positions: new Float32Array(6), elements: Uint8Array.from([1, 2]) },
      {
        frameId: 1,
        nAtoms: 3,
        positions: new Float32Array(9),
        elements: Uint8Array.from([1, 2, 1]),
      },
    ];
    const mapped = remapTrajectoryTypesToElements(frames, Uint8Array.from([6, 8]));
    expect(Array.from(mapped[0].elements!)).toEqual([6, 8]);
    expect(Array.from(mapped[1].elements!)).toEqual([6, 8, 6]);
    // The parser's own frames are never mutated — the raw type ids survive.
    expect(Array.from(frames[0].elements!)).toEqual([1, 2]);
    expect(Array.from(frames[1].elements!)).toEqual([1, 2, 1]);
  });

  it("falls back to element 0 for a type absent from frame 0", async () => {
    const { remapTrajectoryTypesToElements } = await import("@/parsers/parseCore");
    const frames = [
      { frameId: 0, nAtoms: 1, positions: new Float32Array(3), elements: Uint8Array.from([1]) },
      { frameId: 1, nAtoms: 2, positions: new Float32Array(6), elements: Uint8Array.from([1, 9]) },
    ];
    const mapped = remapTrajectoryTypesToElements(frames, Uint8Array.from([7]));
    expect(Array.from(mapped[1].elements!)).toEqual([7, 0]); // type 9 unknown → 0
  });

  it("returns the input untouched when frames carry no per-frame elements", async () => {
    const { remapTrajectoryTypesToElements } = await import("@/parsers/parseCore");
    const frames = [{ frameId: 0, nAtoms: 1, positions: new Float32Array(3) }];
    expect(remapTrajectoryTypesToElements(frames, Uint8Array.from([6]))).toBe(frames);
  });
});

describe("collectResultBuffers", () => {
  it("deduplicates the shared frame buffer for a structure result", () => {
    const { result } = makeStructureResult({ nAtoms: 2, nFrames: 3, hasBox: true });
    const out = parseWithFn(() => result as never, "");
    const buffers = collectResultBuffers(out);
    // positions, elements, bonds, bondOrders, box, and ONE shared frame buffer.
    const frameBuffer = out.frames[0].positions.buffer;
    expect(buffers.filter((b) => b === frameBuffer)).toHaveLength(1);
    // No duplicates overall.
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  it("collects the shared trajectory buffer once", () => {
    const { result } = makeXtcResult(2, 4);
    const out = extractFrames(result as never, 2, "XTC");
    const buffers = collectResultBuffers(out);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]).toBe(out.frames[0].positions.buffer);
  });
});
