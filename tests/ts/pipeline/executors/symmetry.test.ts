import { describe, it, expect } from "vitest";
import { executeSymmetry, parseSymop } from "@/pipeline/executors/symmetry";
import type { SymmetryParams, ParticleData, PipelineData, TrajectoryData } from "@/pipeline/types";
import { MemoryFrameProvider, defaultParams } from "@/pipeline/types";
import type { Snapshot, Frame, TrajectoryMeta } from "@/types";

const CUBIC = () => new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

/** P2_1/a-style operation set (the glycine_csd.cif space group). */
const P21A_OPS = ["x,y,z", "-x,-y,-z", "-x+1/2,y+1/2,-z", "x+1/2,-y+1/2,z"];

/** Two bonded atoms at a general position in a 10 Å cubic cell. */
function makeSnapshot(box: Float32Array | null, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    nFileBonds: 0,
    positions: new Float32Array([3, 3, 3, 4, 4, 4]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
    symmetryOps: ["x,y,z", "-x,-y,-z"],
    ...overrides,
  } as Snapshot;
}

function makeParticle(snapshot: Snapshot, opts: Partial<ParticleData> = {}): ParticleData {
  return {
    type: "particle",
    source: snapshot,
    sourceNodeId: "loader-1",
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
    ...opts,
  };
}

function params(mode: SymmetryParams["mode"]): SymmetryParams {
  return { type: "symmetry", mode };
}

function makeTrajectory(frames: Frame[], nAtoms = 2): TrajectoryData {
  const meta: TrajectoryMeta = { nFrames: frames.length, timestepPs: 1, nAtoms };
  return {
    type: "trajectory",
    provider: new MemoryFrameProvider(frames, meta),
    meta,
    source: "file",
  };
}

function inputs(particle?: ParticleData, trajectory?: TrajectoryData): Map<string, PipelineData[]> {
  const m = new Map<string, PipelineData[]>();
  if (particle) m.set("particle", [particle]);
  if (trajectory) m.set("trajectory", [trajectory]);
  return m;
}

/** Element-wise float32-tolerant comparison. */
function expectClose(actual: ArrayLike<number>, expected: number[]) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 4);
  }
}

describe('defaultParams("symmetry")', () => {
  it("defaults to the expand mode", () => {
    expect(defaultParams("symmetry")).toEqual({ type: "symmetry", mode: "expand" });
  });
});

describe("parseSymop", () => {
  it("parses the identity", () => {
    const op = parseSymop("x,y,z")!;
    expect(op.rot).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(op.trans).toEqual([0, 0, 0]);
  });

  it("parses fractional translations", () => {
    const op = parseSymop("-x+1/2,y+1/2,-z")!;
    expect(op.rot).toEqual([-1, 0, 0, 0, 1, 0, 0, 0, -1]);
    expect(op.trans[0]).toBeCloseTo(0.5, 6);
    expect(op.trans[1]).toBeCloseTo(0.5, 6);
    expect(op.trans[2]).toBeCloseTo(0, 6);
  });

  it("parses a constant-first component", () => {
    const op = parseSymop("1/2-y,x,z")!;
    expect(op.rot.slice(0, 3)).toEqual([0, -1, 0]);
    expect(op.trans[0]).toBeCloseTo(0.5, 6);
  });

  it("returns null for a malformed operation", () => {
    expect(parseSymop("x,y")).toBeNull();
  });
});

describe("executeSymmetry", () => {
  it("returns empty output when no particle input", () => {
    const out = executeSymmetry(params("expand"), new Map());
    expect(out.size).toBe(0);
  });

  it("passes the input through unchanged for mode none", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([{ frameId: 0, nAtoms: 2, positions: new Float32Array(6) }]);
    const out = executeSymmetry(params("none"), inputs(particle, traj));
    expect(out.get("particle")).toBe(particle);
    expect(out.get("trajectory")).toBe(traj);
  });

  it("passes through when the snapshot carries no symmetry operations", () => {
    const particle = makeParticle(makeSnapshot(CUBIC(), { symmetryOps: undefined }));
    const out = executeSymmetry(params("expand"), inputs(particle));
    expect(out.get("particle")).toBe(particle);
  });

  it("passes through for identity-only operations", () => {
    const particle = makeParticle(makeSnapshot(CUBIC(), { symmetryOps: ["x,y,z"] }));
    const out = executeSymmetry(params("expand"), inputs(particle));
    expect(out.get("particle")).toBe(particle);
  });

  it("passes through when there is no unit cell", () => {
    const particle = makeParticle(makeSnapshot(null));
    const out = executeSymmetry(params("expand"), inputs(particle));
    expect(out.get("particle")).toBe(particle);
  });

  it("passes through for a singular cell matrix", () => {
    const particle = makeParticle(makeSnapshot(new Float32Array(9)));
    const out = executeSymmetry(params("expand"), inputs(particle));
    expect(out.get("particle")).toBe(particle);
  });

  it("inversion doubles atoms and replicates the bond by index offset", () => {
    const snapshot = makeSnapshot(CUBIC());
    const before = Array.from(snapshot.positions);
    const out = executeSymmetry(params("expand"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    const s = result.source;
    expect(s.nAtoms).toBe(4);
    expect(s.positions.length).toBe(12);
    expect(Array.from(s.elements)).toEqual([6, 8, 6, 8]);
    // First image is the untouched asymmetric unit.
    expectClose(s.positions.slice(0, 6), [3, 3, 3, 4, 4, 4]);
    // Second image: inversion, centroid-wrapped into the home cell.
    expectClose(s.positions.slice(6, 12), [7, 7, 7, 6, 6, 6]);
    // Bond replicated per image with the n_base offset.
    expect(s.nBonds).toBe(2);
    expect(Array.from(s.bonds)).toEqual([0, 1, 2, 3]);
    // The input snapshot must not be mutated.
    expect(Array.from(snapshot.positions)).toEqual(before);
    expect(snapshot.nAtoms).toBe(2);
  });

  it("applies fractional-translation operations (P2_1/a fills 4 images)", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      nAtoms: 1,
      nBonds: 0,
      positions: new Float32Array([1, 2, 3]),
      elements: new Uint8Array([8]),
      bonds: new Uint32Array(0),
      symmetryOps: P21A_OPS,
    });
    const out = executeSymmetry(params("expand"), inputs(makeParticle(snapshot)));
    const s = (out.get("particle") as ParticleData).source;
    expect(s.nAtoms).toBe(4);
    // frac (0.1,0.2,0.3) under the 4 ops, each image wrapped into the cell.
    expectClose(s.positions, [1, 2, 3, 9, 8, 7, 4, 7, 7, 6, 3, 3]);
  });

  it("drops symmetry images that coincide (special positions)", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      nAtoms: 1,
      nBonds: 0,
      positions: new Float32Array([0, 0, 0]),
      elements: new Uint8Array([11]),
      bonds: new Uint32Array(0),
      symmetryOps: ["x,y,z", "-x,-y,-z"],
    });
    const out = executeSymmetry(params("expand"), inputs(makeParticle(snapshot)));
    const s = (out.get("particle") as ParticleData).source;
    // The inversion image of the origin coincides with the identity image.
    expect(s.nAtoms).toBe(1);
    expectClose(s.positions, [0, 0, 0]);
    expect(s).not.toBe(snapshot);
  });

  it("tiles bond orders and multiplies the bond counters", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      nFileBonds: 1,
      bondOrders: new Uint8Array([2]),
    });
    const out = executeSymmetry(params("expand"), inputs(makeParticle(snapshot)));
    const s = (out.get("particle") as ParticleData).source;
    expect(s.nBonds).toBe(2);
    expect(s.nFileBonds).toBe(2);
    expect(Array.from(s.bondOrders!)).toEqual([2, 2]);
  });

  it("keeps the symmetry operations and the cell on the expanded snapshot", () => {
    const snapshot = makeSnapshot(CUBIC());
    const out = executeSymmetry(params("expand"), inputs(makeParticle(snapshot)));
    const s = (out.get("particle") as ParticleData).source;
    expect(s.symmetryOps).toEqual(["x,y,z", "-x,-y,-z"]);
    expect(s.box).toBe(snapshot.box);
  });

  it("tiles stream overrides with per-image index offsets", () => {
    const indices = new Uint32Array([1]);
    const scaleOverrides = new Float32Array([1, 2]);
    const particle = makeParticle(makeSnapshot(CUBIC()), { indices, scaleOverrides });
    const out = executeSymmetry(params("expand"), inputs(particle));
    const result = out.get("particle") as ParticleData;
    expect(Array.from(result.indices!)).toEqual([1, 3]);
    expect(Array.from(result.scaleOverrides!)).toEqual([1, 2, 1, 2]);
    expect(result.sourceNodeId).toBe("loader-1");
  });

  it("passes everything through untouched when a trajectory input is present", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([{ frameId: 0, nAtoms: 2, positions: new Float32Array(6) }]);
    const out = executeSymmetry(params("expand"), inputs(particle, traj));
    expect(out.get("particle")).toBe(particle);
    expect(out.get("trajectory")).toBe(traj);
  });

  it("tiles per-atom channels and shifts backbone indices per image", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      atomChainIds: new Uint8Array([65, 65]),
      atomBFactors: new Float32Array([1.5, 2.5]),
      caIndices: new Uint32Array([1]),
      caChainIds: new Uint8Array([65]),
      caResNums: new Uint32Array([7]),
      caSsType: new Uint8Array([2]),
    });
    const out = executeSymmetry(params("expand"), inputs(makeParticle(snapshot)));
    const s = (out.get("particle") as ParticleData).source;
    expect(Array.from(s.atomChainIds!)).toEqual([65, 65, 65, 65]);
    expect(Array.from(s.atomBFactors!)).toEqual([1.5, 2.5, 1.5, 2.5]);
    expect(Array.from(s.caIndices!)).toEqual([1, 3]);
    expect(Array.from(s.caChainIds!)).toEqual([65, 65]);
    expect(Array.from(s.caResNums!)).toEqual([7, 7]);
    expect(Array.from(s.caSsType!)).toEqual([2, 2]);
  });

  it("skips unparsable operations but expands the rest", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      symmetryOps: ["x,y,z", "garbage", "-x,-y,-z"],
    });
    const out = executeSymmetry(params("expand"), inputs(makeParticle(snapshot)));
    const s = (out.get("particle") as ParticleData).source;
    // "garbage" is not a 3-component operation, so only the two real
    // operations contribute images.
    expect(s.nAtoms).toBe(4);
  });
});
