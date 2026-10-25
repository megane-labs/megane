import { describe, it, expect } from "vitest";
import { executeWrap } from "@/pipeline/executors/wrap";
import type { WrapParams, ParticleData, PipelineData, TrajectoryData } from "@/pipeline/types";
import { MemoryFrameProvider, defaultParams } from "@/pipeline/types";
import type { Snapshot, Frame, TrajectoryMeta } from "@/types";

const CUBIC = () => new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

/** Two bonded atoms in a 10 Å cubic cell, atom 1 wrapped across the +x face. */
function makeSnapshot(box: Float32Array | null, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    nFileBonds: 1,
    positions: new Float32Array([0.5, 1, 1, 9.9, 1, 1]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
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

function params(mode: WrapParams["mode"]): WrapParams {
  return { type: "wrap", mode };
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
    expect(actual[i]).toBeCloseTo(expected[i], 5);
  }
}

describe('defaultParams("wrap")', () => {
  it("defaults to the pass-through mode", () => {
    expect(defaultParams("wrap")).toEqual({ type: "wrap", mode: "none" });
  });
});

describe("executeWrap", () => {
  it("returns empty output when no particle input", () => {
    const out = executeWrap(params("wrap"), new Map());
    expect(out.size).toBe(0);
  });

  it("passes the input through unchanged for mode none", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([{ frameId: 0, nAtoms: 2, positions: new Float32Array(6) }]);
    const out = executeWrap(params("none"), inputs(particle, traj));
    expect(out.get("particle")).toBe(particle);
    expect(out.get("trajectory")).toBe(traj);
  });

  it("passes through unchanged when there is no unit cell", () => {
    const particle = makeParticle(makeSnapshot(null));
    const out = executeWrap(params("wrap"), inputs(particle));
    expect(out.get("particle")).toBe(particle);
  });

  it("passes through unchanged for a singular cell matrix", () => {
    const particle = makeParticle(makeSnapshot(new Float32Array(9)));
    const out = executeWrap(params("unwrap"), inputs(particle));
    expect(out.get("particle")).toBe(particle);
  });

  it("wrap folds atoms outside the cell into [0, L)", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      positions: new Float32Array([11, 1, 1, -1, 2, 2]),
    });
    const before = Array.from(snapshot.positions);
    const out = executeWrap(params("wrap"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    expectClose(result.source.positions, [1, 1, 1, 9, 2, 2]);
    // The input snapshot must not be mutated.
    expect(Array.from(snapshot.positions)).toEqual(before);
  });

  it("wrap respects the box origin anchor", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      positions: new Float32Array([4, 6, 6, 16, 6, 6]),
      boxOrigin: new Float32Array([5, 5, 5]),
    });
    const out = executeWrap(params("wrap"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    // Cell spans [5, 15) on every axis: 4 → 14, 16 → 6.
    expect(Array.from(result.source.positions)).toEqual([14, 6, 6, 6, 6, 6]);
  });

  it("wrap handles a triclinic cell", () => {
    const box = new Float32Array([10, 0, 0, 5, 10, 0, 0, 0, 10]);
    // Atom at 1.5·a: fractional (1.5, 0, 0) wraps to (0.5, 0, 0) → 0.5·a.
    const snapshot = makeSnapshot(box, { positions: new Float32Array([15, 0, 0, 1, 1, 1]) });
    const out = executeWrap(params("wrap"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    expect(Array.from(result.source.positions.slice(0, 3))).toEqual([5, 0, 0]);
  });

  it("unwrap makes a file-bonded molecule split across the boundary whole", () => {
    const snapshot = makeSnapshot(CUBIC());
    const before = Array.from(snapshot.positions);
    const out = executeWrap(params("unwrap"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    // Atom 0 (the component seed) stays put; atom 1 shifts by −a.
    expectClose(result.source.positions, [0.5, 1, 1, -0.1, 1, 1]);
    // Topology channels are untouched — only coordinates move.
    expect(result.source.bonds).toBe(snapshot.bonds);
    expect(Array.from(snapshot.positions)).toEqual(before);
  });

  it("unwrap leaves a contiguous molecule untouched", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      positions: new Float32Array([4, 4, 4, 5, 4, 4]),
    });
    const out = executeWrap(params("unwrap"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    expect(Array.from(result.source.positions)).toEqual([4, 4, 4, 5, 4, 4]);
  });

  it("unwrap infers connectivity when the snapshot carries no bonds", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      nBonds: 0,
      nFileBonds: 0,
      bonds: new Uint32Array(0),
      // C–O across the +x face, 0.6 Å apart via minimum image.
      positions: new Float32Array([0.5, 5, 5, 9.9, 5, 5]),
    });
    const out = executeWrap(params("unwrap"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    expect(result.source.positions[3]).toBeCloseTo(-0.1, 5);
  });

  it("unwrap keeps unbonded atoms in place", () => {
    const snapshot = makeSnapshot(CUBIC(), {
      nBonds: 0,
      nFileBonds: 0,
      bonds: new Uint32Array(0),
      // 4 Å apart — far beyond any VDW bond threshold.
      positions: new Float32Array([1, 5, 5, 5, 5, 5]),
    });
    const out = executeWrap(params("unwrap"), inputs(makeParticle(snapshot)));
    const result = out.get("particle") as ParticleData;
    expect(Array.from(result.source.positions)).toEqual([1, 5, 5, 5, 5, 5]);
  });

  it("wrap remaps every trajectory frame", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([
      { frameId: 0, nAtoms: 2, positions: new Float32Array([11, 1, 1, 2, 2, 2]) },
      { frameId: 1, nAtoms: 2, positions: new Float32Array([-3, 1, 1, 2, 2, 2]) },
    ]);
    const out = executeWrap(params("wrap"), inputs(particle, traj));
    const result = out.get("trajectory") as TrajectoryData;
    expectClose(result.provider.getFrame(0)!.positions.slice(0, 3), [1, 1, 1]);
    expectClose(result.provider.getFrame(1)!.positions.slice(0, 3), [7, 1, 1]);
    expect(result.meta).toBe(traj.meta);
  });

  it("reports the wrapped provider's held bytes (it keeps no frames of its own)", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([
      { frameId: 0, nAtoms: 2, positions: new Float32Array(6) },
      { frameId: 1, nAtoms: 2, positions: new Float32Array(6) },
    ]);
    const out = executeWrap(params("wrap"), inputs(particle, traj));
    const result = out.get("trajectory") as TrajectoryData;
    expect(result.provider.heldBytes?.()).toBe(2 * 6 * 4);
  });

  it("reports 0 held bytes over a provider that does not count them", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const meta: TrajectoryMeta = { nFrames: 1, timestepPs: 1, nAtoms: 2 };
    const traj: TrajectoryData = {
      type: "trajectory",
      provider: { kind: "memory", meta, getFrame: () => null },
      meta,
      source: "file",
    };
    const out = executeWrap(params("wrap"), inputs(particle, traj));
    expect((out.get("trajectory") as TrajectoryData).provider.heldBytes?.()).toBe(0);
  });

  it("wrap prefers a frame's own cell over the snapshot cell", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([
      {
        frameId: 0,
        nAtoms: 2,
        positions: new Float32Array([11, 1, 1, 2, 2, 2]),
        box: new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20]),
      },
    ]);
    const out = executeWrap(params("wrap"), inputs(particle, traj));
    const result = out.get("trajectory") as TrajectoryData;
    // 11 < 20, so the atom is already inside the per-frame cell.
    expect(Array.from(result.provider.getFrame(0)!.positions.slice(0, 3))).toEqual([11, 1, 1]);
  });

  it("unwrap recomputes lattice shifts per trajectory frame", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([
      // Frame 0: already whole — no shift.
      { frameId: 0, nAtoms: 2, positions: new Float32Array([4, 4, 4, 5, 4, 4]) },
      // Frame 1: split across the boundary like the static snapshot.
      { frameId: 1, nAtoms: 2, positions: new Float32Array([0.5, 1, 1, 9.9, 1, 1]) },
    ]);
    const out = executeWrap(params("unwrap"), inputs(particle, traj));
    const result = out.get("trajectory") as TrajectoryData;
    expect(Array.from(result.provider.getFrame(0)!.positions)).toEqual([4, 4, 4, 5, 4, 4]);
    expect(result.provider.getFrame(1)!.positions[3]).toBeCloseTo(-0.1, 5);
  });

  it("unwrap passes a frame through when its atom count differs from the topology", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const framePositions = new Float32Array([0.5, 1, 1, 9.9, 1, 1, 3, 3, 3]);
    const traj = makeTrajectory([{ frameId: 0, nAtoms: 3, positions: framePositions }], 3);
    const out = executeWrap(params("unwrap"), inputs(particle, traj));
    const result = out.get("trajectory") as TrajectoryData;
    expect(result.provider.getFrame(0)!.positions).toBe(framePositions);
  });

  it("mapped provider returns null for unavailable frames", () => {
    const particle = makeParticle(makeSnapshot(CUBIC()));
    const traj = makeTrajectory([{ frameId: 0, nAtoms: 2, positions: new Float32Array(6) }]);
    const out = executeWrap(params("wrap"), inputs(particle, traj));
    const result = out.get("trajectory") as TrajectoryData;
    expect(result.provider.getFrame(5)).toBeNull();
  });

  it("preserves stream overrides and metadata on the particle output", () => {
    const indices = new Uint32Array([1]);
    const scaleOverrides = new Float32Array([1, 2]);
    const particle = makeParticle(makeSnapshot(CUBIC()), { indices, scaleOverrides });
    const out = executeWrap(params("wrap"), inputs(particle));
    const result = out.get("particle") as ParticleData;
    expect(result.indices).toBe(indices);
    expect(result.scaleOverrides).toBe(scaleOverrides);
    expect(result.sourceNodeId).toBe("loader-1");
  });
});
