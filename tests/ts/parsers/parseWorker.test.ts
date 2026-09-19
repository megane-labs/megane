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
      ca_res_nums: () => new Uint32Array(0),
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

  it("parses a structure request and posts an ok response", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: { id: 1, op: "structure", wasmUrl: undefined, ext: ".pdb", text: "ATOM" },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("structure");
    expect(posts[0].result).toBeDefined();
  });

  it("parses a trajectory request and posts an ok response", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 2,
        op: "trajectory",
        wasmUrl: undefined,
        kind: "xtc",
        bytes: new Uint8Array([1, 2]).buffer,
        expectedNAtoms: 4,
      },
    });
    expect(posts[0].ok).toBe(true);
    expect(posts[0].op).toBe("trajectory");
  });

  it("posts an error response when parsing throws", async () => {
    const { handler, posts } = await loadWorker();
    // expectedNAtoms mismatch makes extractFrames throw.
    await handler({
      data: {
        id: 3,
        op: "trajectory",
        wasmUrl: undefined,
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
        wasmUrl: undefined,
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

  it("indexes a LAMMPS dump (kind=lammpstrj) and decodes a frame with vectors", async () => {
    const { handler, posts } = await loadWorker();
    await handler({
      data: {
        id: 30,
        op: "indexTrajectory",
        wasmUrl: undefined,
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
        wasmUrl: undefined,
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
        wasmUrl: undefined,
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
        wasmUrl: undefined,
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
        wasmUrl: undefined,
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
