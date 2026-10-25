/**
 * Unit tests for the parse worker's message handler.
 *
 * Importing parse.worker.ts installs `self.onmessage`. With the WASM module
 * mocked, we can invoke the handler directly and assert it posts back an
 * ok/error response — covering the worker wrapper without a real Worker.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { wasmMock } = vi.hoisted(() => {
  function mockStructResult(nAtoms: number, nFrames = 0) {
    return {
      n_atoms: nAtoms,
      n_bonds: 0,
      n_file_bonds: 0,
      n_frames: nFrames,
      has_box: false,
      has_atom_labels: false,
      has_chain_ids: false,
      has_bfactors: false,
      atom_labels: "",
      vector_channel_count: 0,
      vector_channel_meta: "[]",
      ca_count: 0,
      symmetry_op_count: 0,
      symmetry_ops: "",
      positions: () => new Float32Array(nAtoms * 3),
      elements: () => new Uint8Array(nAtoms),
      bonds: () => new Uint32Array(0),
      bond_orders: () => new Uint8Array(0),
      box_matrix: () => new Float32Array(9),
      frame_data: () => new Float32Array(nFrames * nAtoms * 3),
      chain_ids: () => new Uint8Array(nAtoms),
      bfactors: () => new Float32Array(nAtoms),
      vector_channel_data: () => new Float32Array(),
      ca_indices: () => new Uint32Array(0),
      ca_chain_ids: () => new Uint8Array(0),
      ca_res_nums: () => new Int32Array(0),
      ca_ss_type: () => new Uint8Array(0),
      free: () => {},
    };
  }
  function mockXtcResult(nAtoms: number, nFrames: number) {
    return {
      n_atoms: nAtoms,
      n_frames: nFrames,
      timestep_ps: 1,
      has_box: false,
      vector_channel_count: 0,
      vector_channel_meta: "[]",
      box_matrix: () => new Float32Array(9),
      frame_data: () => new Float32Array(nFrames * nAtoms * 3),
      vector_channel_data: () => new Float32Array(),
      free: () => {},
    };
  }
  const wasmMock = {
    default: async () => {},
    parse_pdb: () => mockStructResult(3),
    parse_gro: () => mockStructResult(3),
    parse_xyz: () => mockStructResult(3),
    parse_molden: () => mockStructResult(3),
    parse_xsf: () => mockStructResult(3),
    parse_c3xml: () => mockStructResult(3),
    parse_odydata: () => mockStructResult(3),
    parse_cml: () => mockStructResult(3),
    parse_magres: () => mockStructResult(3),
    parse_gamess: () => mockStructResult(3),
    parse_phonon: () => mockStructResult(3),
    parse_vasp: () => mockStructResult(3),
    parse_structure_prefix: () => mockStructResult(3, 0),
    parse_structure_bytes: (_ext: string, data: Uint8Array) => mockStructResult(data.length),
    parse_traj_frame0: () => mockStructResult(4, 0),
    decode_trajectory_frame0: () => new Float32Array(4 * 3),
    parse_mol: () => mockStructResult(3),
    parse_mol2: () => mockStructResult(3),
    parse_cif: () => mockStructResult(3),
    parse_mmcif: () => mockStructResult(3),
    parse_lammps_data: () => mockStructResult(3),
    parse_prmtop: () => mockStructResult(3),
    parse_traj: () => mockStructResult(3, 1),
    parse_lammpstrj_structure: () => mockStructResult(3, 1),
    parse_xtc_file: () => mockXtcResult(4, 2),
    parse_dcd_file: () => mockXtcResult(4, 2),
    parse_netcdf_file: () => mockXtcResult(4, 2),
    parse_lammpstrj_file: () => mockXtcResult(4, 2),
    infer_bonds_vdw: () => new Uint32Array(),
    parse_top_bonds: () => new Uint32Array(),
    parse_top_bonds_with_includes: () => new Uint32Array(),
    parse_psf_bonds: () => new Uint32Array(),
    parse_pdb_bonds: () => new Uint32Array(),
    extract_labels: () => "",
    write_structure: () => "",
    XtcDecoder: class {
      n_atoms = 4;
      n_frames = 2;
      timestep_ps = 1;
      has_box = false;
      box_matrix() {
        return new Float32Array(9);
      }
      times() {
        return new Float32Array(2);
      }
      decode_frame() {
        return new Float32Array(4 * 3);
      }
      free() {}
    },
    // Windowed text indexer: every window is used whole; two 10-byte frames
    // follow a 10-byte frame 0 (n_atoms 3); a dump has one vector channel.
    TextFrameIndexer: class {
      next_offset = 0;
      n_atoms = 3;
      n_frames = 2;
      heterogeneous = false;
      frame0_end = 10;
      tail_start = 30;
      frame0_needs_whole_file = false;
      timestep_ps = 2;
      has_box = true;
      vector_channel_names = "velocity";
      constructor(public kind: string) {}
      scan(window: Uint8Array) {
        this.next_offset += window.length;
        return window.length;
      }
      finish() {}
      offsets() {
        return new Float64Array([10, 20]);
      }
      frames_end(len: number) {
        return len;
      }
      box_matrix() {
        return new Float32Array(9);
      }
      box_origin() {
        return new Float32Array([1, 2, 3]);
      }
      free() {}
    },
    // Fixed-layout binary trajectory: 3 atoms, 2 frames of 8 bytes after a
    // 16-byte header, each with a cell of edge 10 + frame and time 2 × frame.
    BinaryFrameLayout: class {
      n_atoms = 3;
      n_frames = 2;
      timestep_ps = NaN;
      has_cell = true;
      frame_len = 8;
      frame_start(i: number) {
        return 16 + i * 8;
      }
      decode(_bytes: Uint8Array, i: number) {
        return {
          positions: () => new Float32Array(9).fill(i),
          cell: () => new Float32Array([10 + i, 0, 0, 0, 10 + i, 0, 0, 0, 10 + i]),
          time: 2 * i,
          free: () => {},
        };
      }
      free() {}
    },
    // An ASE .traj of three 20-byte frames (JSON 2 bytes long, 10 bytes in)
    // and a 24-byte offset table at 100; 3 atoms; the cell changes.
    TrajFileIndexer: class {
      table_start = 100;
      table_end = 124;
      n_items = 3;
      n_atoms = 3;
      n_frames = 2;
      heterogeneous = false;
      varying_cells = true;
      next_start = 0;
      set_table() {}
      json_offset(item: number) {
        return item * 20 + 10;
      }
      json_len() {
        return 2;
      }
      add_frame(bytes: Uint8Array) {
        this.next_start += bytes.length;
      }
      frame0() {
        return mockStructResult(3);
      }
      frame_cell(frame: number) {
        return new Float32Array(9).fill(10 + frame);
      }
      frame_start(frame: number) {
        return (frame + 1) * 20;
      }
      frame_end(frame: number) {
        return (frame + 2) * 20;
      }
      decode(frame: number) {
        return new Float32Array(9).fill(frame);
      }
      free() {}
    },
    netcdf_timestep: (_n: number, t0: number, t1: number) => t1 - t0,
    decode_text_frame: (kind: string, _data: Uint8Array, nAtoms: number) => ({
      positions: () => new Float32Array(nAtoms * 3),
      vectors: () => new Float32Array(kind === "lammpstrj" ? nAtoms * 3 : 0),
      free: () => {},
    }),
    // Windowed indexer over 8-byte "frames" (n_atoms 4).
    XtcIndexer: class {
      next_offset = 0;
      n_atoms = 4;
      n_frames = 0;
      timestep_ps = 1;
      has_box = true;
      scan(window: Uint8Array) {
        // A 7-byte window holds no frame: the scan cannot move on.
        if (window.length === 7) return 0;
        const found = Math.floor(window.length / 8);
        this.next_offset += found * 8;
        this.n_frames += found;
        return found;
      }
      finish() {}
      box_matrix() {
        return new Float32Array(9);
      }
      offsets() {
        return Float64Array.from({ length: this.n_frames }, (_, i) => i * 8);
      }
      times() {
        return new Float32Array(this.n_frames);
      }
      free() {}
    },
    LammpstrjDecoder: class {
      n_atoms = 4;
      n_frames = 2;
      timestep_ps = 1;
      has_box = false;
      vector_channel_count = 1;
      vector_channel_names = "velocity";
      box_matrix() {
        return new Float32Array(9);
      }
      decode_frame() {
        return new Float32Array(4 * 3);
      }
      decode_frame_vectors() {
        return new Float32Array(4 * 3);
      }
      free() {}
    },
    StructureFrameDecoder: class {
      n_atoms = 3;
      n_frames = 2;
      frame0() {
        return mockStructResult(3, 0);
      }
      decode_frame() {
        return new Float32Array(3 * 3);
      }
      free() {}
    },
  };
  return { wasmMock };
});

vi.mock("../../../crates/megane-wasm/pkg", () => wasmMock);

type Handler = (e: { data: unknown }) => Promise<void> | void;

interface WorkerResponse {
  id: number;
  ok: boolean;
  op: string;
  result?: unknown;
  error?: string;
  fatal?: boolean;
  wasmBytes?: number;
}

async function loadWorker(): Promise<{ handler: Handler; posts: WorkerResponse[] }> {
  vi.resetModules();
  const posts: WorkerResponse[] = [];
  (self as unknown as { postMessage: unknown }).postMessage = (msg: WorkerResponse) =>
    posts.push(msg);
  await import("@/parsers/parse.worker");
  const handler = (self as unknown as { onmessage: Handler }).onmessage;
  return { handler, posts };
}

describe("parse.worker onmessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the WASM module for an init request and posts an ok response", async () => {
    const { handler, posts } = await loadWorker();
    await handler({ data: { id: 7, op: "init", wasm: undefined } });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: 7, ok: true, op: "init" });
  });

  it("stamps every response with the worker's WASM heap size", async () => {
    const { handler, posts } = await loadWorker();
    await handler({ data: { id: 9, op: "init", wasm: undefined } });
    await handler({ data: { id: 10, op: "decodeFrame", trajectoryId: 404, frame: 0 } });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ id: 10, ok: false });
    for (const post of posts) expect(post.wasmBytes).toBe(0);
  });

  it("parses a .traj's frame 0 from head and tail chunks", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 8,
        op: "trajFrame0",
        wasm: undefined,
        head: new ArrayBuffer(4),
        tail: new ArrayBuffer(2),
        totalSize: 100,
      },
    });
    expect(posts[0]).toMatchObject({ id: 8, ok: true, op: "trajFrame0" });
    const result = posts[0].result as { snapshot: { nAtoms: number } };
    expect(result.snapshot.nAtoms).toBe(4);
  });

  it("parses a structure request and posts an ok response", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: { id: 1, op: "structure", wasm: undefined, ext: ".pdb", text: "ATOM" },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("structure");
    expect(posts[0].result).toBeDefined();
  });

  it("reads a structure File itself and parses its bytes", async () => {
    const { handler, posts } = await loadWorker();
    const spy = vi.spyOn(wasmMock, "parse_structure_bytes");
    // jsdom's Blob has no arrayBuffer(); the worker only needs that method.
    const file = { arrayBuffer: async () => new Uint8Array([65, 84, 79, 77, 10]).buffer };
    await handler({ data: { id: 4, op: "structure", wasm: undefined, ext: ".gro", file } });
    expect(spy).toHaveBeenCalledWith(".gro", new Uint8Array([65, 84, 79, 77, 10]));
    expect((posts[0].result as { snapshot: { nAtoms: number } }).snapshot.nAtoms).toBe(5);
    spy.mockRestore();
  });

  it("parses structure bytes the page already read", async () => {
    const { handler, posts } = await loadWorker();
    const bytes = new Uint8Array([1, 2]).buffer;
    await handler({ data: { id: 5, op: "structure", wasm: undefined, ext: ".pdb", bytes } });
    expect((posts[0].result as { snapshot: { nAtoms: number } }).snapshot.nAtoms).toBe(2);
  });

  it("posts a structure's labels as one string", async () => {
    const { handler, posts } = await loadWorker();
    const spy = vi.spyOn(wasmMock, "parse_pdb").mockImplementationOnce(() => ({
      ...wasmMock.parse_pdb(),
      has_atom_labels: true,
      atom_labels: "HOH1\nHOH1\nHOH1",
    }));
    await handler({
      data: { id: 3, op: "structure", wasm: undefined, ext: ".pdb", text: "ATOM" },
    });
    const result = posts[0].result as { labels: unknown; labelsText?: string };
    expect(result.labels).toBeNull();
    expect(result.labelsText).toBe("HOH1\nHOH1\nHOH1");
    spy.mockRestore();
  });

  it("parses a trajectory request and posts an ok response", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 2,
        op: "trajectory",
        wasm: undefined,
        kind: "xtc",
        bytes: new Uint8Array([1, 2]).buffer,
        expectedNAtoms: 4,
      },
    });
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("trajectory");
  });

  it("marks an ordinary parse error as not fatal", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 31,
        op: "trajectory",
        wasm: undefined,
        kind: "xtc",
        bytes: new Uint8Array([1]).buffer,
        expectedNAtoms: 999,
      },
    });
    expect(posts[0]).toMatchObject({ id: 31, ok: false });
    expect(posts[0].fatal).toBeUndefined();
  });

  it("marks a WASM module that will not start as fatal", async () => {
    const start = wasmMock.default;
    wasmMock.default = async () => {
      throw new Error("could not fetch the module");
    };
    try {
      const { handler, posts } = await loadWorker();
      await handler({ data: { id: 32, op: "structure", wasm: undefined, ext: ".pdb", text: "" } });
      expect(posts[0]).toMatchObject({ id: 32, ok: false, fatal: true });
      expect(posts[0].error).toMatch(/could not fetch the module/);
    } finally {
      wasmMock.default = start;
    }
  });

  it("marks a trap inside the WASM module as fatal", async () => {
    const parse = wasmMock.parse_pdb;
    wasmMock.parse_pdb = () => {
      throw new WebAssembly.RuntimeError("unreachable");
    };
    try {
      const { handler, posts } = await loadWorker();
      await handler({ data: { id: 33, op: "structure", wasm: undefined, ext: ".pdb", text: "X" } });
      expect(posts[0]).toMatchObject({ id: 33, ok: false, fatal: true });
    } finally {
      wasmMock.parse_pdb = parse;
    }
  });

  it("posts an error response when parsing throws", async () => {
    const { handler, posts } = await loadWorker();
    // expectedNAtoms mismatch makes extractFrames throw.
    await handler({
      data: {
        id: 3,
        op: "trajectory",
        wasm: undefined,
        kind: "xtc",
        bytes: new Uint8Array([1]).buffer,
        expectedNAtoms: 999,
      },
    });
    expect(posts[0].ok).toBe(false);
    expect(posts[0].error).toMatch(/atom count/);
  });

  it("indexes a trajectory, decodes a frame on demand, then disposes it", async () => {
    const { handler, posts } = await loadWorker();

    // 1. Build a lazy decoder (mock XtcDecoder: n_atoms 4, n_frames 2).
    await handler({
      data: {
        id: 10,
        op: "indexTrajectory",
        wasm: undefined,
        kind: "xtc",
        trajectoryId: 100,
        bytes: new Uint8Array([1, 2, 3, 4]).buffer,
        expectedNAtoms: 4,
      },
    });
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("indexTrajectory");
    const index = posts[0].result as { nAtoms: number; nFrames: number };
    expect(index.nAtoms).toBe(4);
    expect(index.nFrames).toBe(2);

    // 2. Decode a single frame from the retained decoder.
    await handler({ data: { id: 11, op: "decodeFrame", trajectoryId: 100, frame: 1 } });
    expect(posts[1].ok).toBe(true);
    expect(posts[1].op).toBe("decodeFrame");
    const decoded = posts[1].result as { frame: number; positions: Float32Array };
    expect(decoded.frame).toBe(1);
    expect(decoded.positions).toHaveLength(4 * 3);

    // 3. Dispose it; a subsequent decode for the same id then errors.
    await handler({ data: { id: 12, op: "disposeTrajectory", trajectoryId: 100 } });
    expect(posts[2].ok).toBe(true);
    expect(posts[2].op).toBe("disposeTrajectory");

    await handler({ data: { id: 13, op: "decodeFrame", trajectoryId: 100, frame: 0 } });
    expect(posts[3].ok).toBe(false);
    expect(posts[3].error).toMatch(/unknown trajectoryId/);
  });

  it("indexes an XTC from its File and decodes a frame by reading just its bytes", async () => {
    const { handler, posts } = await loadWorker();
    // jsdom's Blob cannot be read, so the File is a stand-in recording its reads.
    const reads: [number, number][] = [];
    const file = {
      size: 16,
      slice: (start: number, end: number) => {
        reads.push([start, end]);
        return { arrayBuffer: async () => new ArrayBuffer(end - start) };
      },
    };
    await handler({
      data: {
        id: 20,
        op: "indexTrajectoryFile",
        wasm: undefined,
        trajectoryId: 200,
        file,
        expectedNAtoms: 4,
      },
    });
    expect(posts[0].error).toBeUndefined();
    expect(posts[0]).toMatchObject({ id: 20, ok: true, op: "indexTrajectoryFile" });
    const index = posts[0].result as { nFrames: number; hasBox: boolean; boxOrigin: unknown };
    expect(index.nFrames).toBe(2);
    expect(index.hasBox).toBe(true);
    expect(index.boxOrigin).toBeNull();

    await handler({ data: { id: 21, op: "decodeFrame", trajectoryId: 200, frame: 1 } });
    expect(posts[1]).toMatchObject({ id: 21, ok: true, op: "decodeFrame" });
    const decoded = posts[1].result as { positions: Float32Array; vectorChannelCount: number };
    expect(decoded.positions).toHaveLength(4 * 3);
    expect(decoded.vectorChannelCount).toBe(0);
    expect(reads[reads.length - 1]).toEqual([8, 16]); // frame 1's bytes only

    await handler({ data: { id: 22, op: "disposeTrajectory", trajectoryId: 200 } });
    await handler({ data: { id: 23, op: "decodeFrame", trajectoryId: 200, frame: 0 } });
    expect(posts[3].ok).toBe(false);
  });

  /** A File stand-in (jsdom's Blob cannot be read) recording its reads. */
  function recordingFile(size: number) {
    const reads: [number, number][] = [];
    const file = {
      size,
      slice: (start: number, end: number) => {
        reads.push([start, end]);
        return { arrayBuffer: async () => new ArrayBuffer(end - start) };
      },
    };
    return { file, reads };
  }

  it("indexes a multi-frame structure from its File and reads frames from it", async () => {
    const { handler, posts } = await loadWorker();
    const { file, reads } = recordingFile(30);
    await handler({
      data: { id: 40, op: "indexStructure", wasm: undefined, kind: "xyz", trajectoryId: 400, file },
    });
    expect(posts[0].error).toBeUndefined();
    const { index, frame0 } = posts[0].result as {
      index: { nFrames: number; nAtoms: number };
      frame0: { snapshot: { nAtoms: number } };
    };
    expect(index).toEqual({ nAtoms: 3, nFrames: 2, heterogeneous: false });
    expect(frame0.snapshot.nAtoms).toBe(3);
    expect(reads).toContainEqual([0, 10]); // frame 0's bytes

    await handler({ data: { id: 41, op: "decodeFrame", trajectoryId: 400, frame: 1 } });
    expect((posts[1].result as { positions: Float32Array }).positions).toHaveLength(9);
    expect(reads[reads.length - 1]).toEqual([20, 30]);
  });

  it("indexes an ASE .traj from its File, each frame carrying its cell", async () => {
    const { handler, posts } = await loadWorker();
    const { file, reads } = recordingFile(130);
    await handler({
      data: {
        id: 45,
        op: "indexStructure",
        wasm: undefined,
        kind: "traj",
        trajectoryId: 450,
        file,
      },
    });
    expect(posts[0].error).toBeUndefined();
    const { index, frame0 } = posts[0].result as {
      index: { nFrames: number };
      frame0: { snapshot: { nAtoms: number } };
    };
    expect(index).toEqual({ nAtoms: 3, nFrames: 2, heterogeneous: false });
    expect(frame0.snapshot.nAtoms).toBe(3);
    expect(reads.slice(0, 2)).toEqual([
      [0, 48],
      [100, 124],
    ]);

    await handler({ data: { id: 46, op: "decodeFrame", trajectoryId: 450, frame: 1 } });
    const decoded = posts[1].result as { positions: Float32Array; box: Float32Array };
    expect(Array.from(decoded.positions)).toEqual(new Array(9).fill(1));
    expect(decoded.box[0]).toBe(11);
    await handler({ data: { id: 47, op: "disposeTrajectory", trajectoryId: 450 } });
    expect(posts[2].ok).toBe(true);
  });

  it("refuses to index an ASE .traj without its File", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 48,
        op: "indexStructure",
        wasm: undefined,
        kind: "traj",
        trajectoryId: 480,
        bytes: new ArrayBuffer(130),
      },
    });
    expect(posts[0].ok).toBe(false);
    expect(posts[0].error).toMatch(/from its File/);
  });

  it("indexes a LAMMPS dump from its File, with its vector channels", async () => {
    const { handler, posts } = await loadWorker();
    const { file } = recordingFile(30);
    await handler({
      data: {
        id: 50,
        op: "indexTrajectoryFile",
        wasm: undefined,
        kind: "lammpstrj",
        trajectoryId: 500,
        file,
        expectedNAtoms: 3,
      },
    });
    expect(posts[0].error).toBeUndefined();
    const index = posts[0].result as {
      vectorChannelNames: string[];
      boxOrigin: Float32Array;
      timestepPs: number;
    };
    expect(index.vectorChannelNames).toEqual(["velocity"]);
    expect(Array.from(index.boxOrigin)).toEqual([1, 2, 3]);
    expect(index.timestepPs).toBe(2);

    await handler({ data: { id: 51, op: "decodeFrame", trajectoryId: 500, frame: 0 } });
    expect((posts[1].result as { vectorChannelCount: number }).vectorChannelCount).toBe(1);
  });

  it("indexes a NetCDF trajectory from its header and sends each frame's cell", async () => {
    const { handler, posts } = await loadWorker();
    const { file, reads } = recordingFile(32);
    await handler({
      data: {
        id: 60,
        op: "indexTrajectoryFile",
        wasm: undefined,
        kind: "netcdf",
        trajectoryId: 600,
        file,
        expectedNAtoms: 3,
      },
    });
    expect(posts[0].error).toBeUndefined();
    const index = posts[0].result as { nFrames: number; timestepPs: number; box: Float32Array };
    expect(index.nFrames).toBe(2);
    expect(index.timestepPs).toBe(2);
    expect(index.box[0]).toBe(10);
    expect(reads[0]).toEqual([0, 32]); // the head (the whole small file)

    await handler({ data: { id: 61, op: "decodeFrame", trajectoryId: 600, frame: 1 } });
    const frame = posts[1].result as { positions: Float32Array; box?: Float32Array };
    expect(frame.positions[0]).toBe(1);
    expect(frame.box?.[0]).toBe(11);
  });

  it("fails an XTC index scan that stops making progress", async () => {
    const { handler, posts } = await loadWorker();
    const file = {
      size: 7 + 64 * 1024,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(7) }),
    };
    await handler({
      data: {
        id: 24,
        op: "indexTrajectoryFile",
        wasm: undefined,
        trajectoryId: 240,
        file,
        expectedNAtoms: 4,
      },
    });
    expect(posts[0]).toMatchObject({ id: 24, ok: false });
    expect(posts[0].error).toMatch(/no progress/);
  });

  it("indexes a LAMMPS dump (kind=lammpstrj) and decodes a frame with vectors", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 30,
        op: "indexTrajectory",
        wasm: undefined,
        kind: "lammpstrj",
        trajectoryId: 300,
        bytes: new Uint8Array([1, 2, 3, 4]).buffer,
        expectedNAtoms: 4,
      },
    });
    expect(posts[0].ok).toBe(true);
    const index = posts[0].result as { vectorChannelNames: string[] };
    expect(index.vectorChannelNames).toEqual(["velocity"]);

    await handler({ data: { id: 31, op: "decodeFrame", trajectoryId: 300, frame: 0 } });
    expect(posts[1].ok).toBe(true);
    const decoded = posts[1].result as {
      positions: Float32Array;
      vectors: Float32Array;
      vectorChannelCount: number;
    };
    expect(decoded.positions).toHaveLength(4 * 3);
    // LammpstrjDecoder mock returns one channel of 4*3 floats.
    expect(decoded.vectors).toHaveLength(4 * 3);
    expect(decoded.vectorChannelCount).toBe(1);
  });

  it("errors when the index atom count does not match the structure", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 20,
        op: "indexTrajectory",
        wasm: undefined,
        kind: "xtc",
        trajectoryId: 200,
        bytes: new Uint8Array([1]).buffer,
        expectedNAtoms: 999,
      },
    });
    expect(posts[0].ok).toBe(false);
    expect(posts[0].error).toMatch(/atom count/);
  });

  it("parses frame 0 from a structure prefix", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 45,
        op: "structurePrefix",
        wasm: undefined,
        kind: "xyz",
        text: "3\n\nO 0 0 0\nH 1 0 0\nH 0 1 0\n",
        isWholeFile: false,
      },
    });
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("structurePrefix");
    const result = posts[0].result as { snapshot: { nAtoms: number } };
    expect(result.snapshot.nAtoms).toBe(3);
  });

  it("decodes only frame 0 of a trajectory from a bounded prefix", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 46,
        op: "trajectoryFrame0",
        wasm: undefined,
        kind: "xtc",
        bytes: new Uint8Array([1, 2, 3, 4]).buffer,
        expectedNAtoms: 4,
      },
    });
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("trajectoryFrame0");
    const result = posts[0].result as { positions: Float32Array };
    expect(result.positions).toHaveLength(4 * 3);
  });

  it("indexes a structure file (returning frame 0 too) and decodes an extra frame on demand", async () => {
    const { handler, posts } = await loadWorker();

    // 1. One round-trip: build the decoder (index) AND parse frame 0.
    await handler({
      data: {
        id: 50,
        op: "indexStructure",
        wasm: undefined,
        kind: "xyz",
        trajectoryId: 500,
        bytes: new Uint8Array([1, 2, 3]).buffer,
      },
    });
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("indexStructure");
    const res = posts[0].result as {
      index: { nAtoms: number; nFrames: number };
      frame0: { snapshot: { nAtoms: number }; frames: unknown[] };
    };
    expect(res.index.nAtoms).toBe(3);
    expect(res.index.nFrames).toBe(2);
    // Frame 0 comes back in the same response (no second file read).
    expect(res.frame0.snapshot.nAtoms).toBe(3);
    expect(res.frame0.frames).toHaveLength(0);

    // 2. Decode a single extra frame from the retained decoder (no vectors).
    await handler({ data: { id: 51, op: "decodeFrame", trajectoryId: 500, frame: 1 } });
    expect(posts[1].ok).toBe(true);
    const decoded = posts[1].result as {
      positions: Float32Array;
      vectors: Float32Array;
      vectorChannelCount: number;
    };
    expect(decoded.positions).toHaveLength(3 * 3);
    expect(decoded.vectors).toHaveLength(0);
    expect(decoded.vectorChannelCount).toBe(0);

    // 3. Dispose it via the shared trajectory-decoder path.
    await handler({ data: { id: 52, op: "disposeTrajectory", trajectoryId: 500 } });
    expect(posts[2].ok).toBe(true);
    await handler({ data: { id: 53, op: "decodeFrame", trajectoryId: 500, frame: 0 } });
    expect(posts[3].ok).toBe(false);
    expect(posts[3].error).toMatch(/unknown trajectoryId/);
  });
});
