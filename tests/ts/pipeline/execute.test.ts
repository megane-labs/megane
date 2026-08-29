import { describe, it, expect } from "vitest";
import { executePipeline } from "@/pipeline/execute";
import type { PipelineNodeData } from "@/pipeline/execute";
import type { Node, Edge } from "@xyflow/react";
import type { Snapshot, Frame, TrajectoryMeta } from "@/types";
import type { ParticleData, BondData, ViewportState } from "@/pipeline/types";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeSnapshot(opts: {
  nAtoms: number;
  positions: number[];
  elements: number[];
  bonds?: number[];
  bondOrders?: number[];
  box?: number[];
}): Snapshot {
  const nBonds = (opts.bonds?.length ?? 0) / 2;
  return {
    nAtoms: opts.nAtoms,
    nBonds,
    nFileBonds: nBonds,
    positions: new Float32Array(opts.positions),
    elements: new Uint8Array(opts.elements),
    bonds: new Uint32Array(opts.bonds ?? []),
    bondOrders: opts.bondOrders ? new Uint8Array(opts.bondOrders) : null,
    box: opts.box ? new Float32Array(opts.box) : null,
  };
}

function makeNode(
  id: string,
  type: string,
  params: Record<string, unknown>,
  enabled = true,
): Node<PipelineNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      params: { type, ...params } as any,
      enabled,
    },
  };
}

function makeEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): Edge {
  return {
    id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  };
}

// Water molecule: O at origin, H nearby
const waterSnapshot = makeSnapshot({
  nAtoms: 3,
  positions: [0, 0, 0, 0.96, 0, 0, -0.96, 0, 0],
  elements: [8, 1, 1],
  bonds: [0, 1, 0, 2],
  bondOrders: [1, 1],
});

// 5-atom system: C, N, O, H, H at x = 0,1,2,3,4
const fiveAtomSnapshot = makeSnapshot({
  nAtoms: 5,
  positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0],
  elements: [6, 7, 8, 1, 1],
});

// ─── Tests ───────────────────────────────────────────────────────────

describe("executePipeline", () => {
  describe("LoadStructure node", () => {
    it("produces particle output from snapshot", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.particles).toHaveLength(1);
      expect(result.particles[0].source).toBe(waterSnapshot);
      expect(result.particles[0].indices).toBeNull();
    });

    it("produces cell output when box is present", () => {
      const boxSnapshot = makeSnapshot({
        nAtoms: 1,
        positions: [0, 0, 0],
        elements: [6],
        box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
      });
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: true }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "vp", "particle"),
        makeEdge("ls", "cell", "vp", "cell"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: boxSnapshot });
      expect(result.cells).toHaveLength(1);
      expect(result.cells[0].box[0]).toBe(10);
    });

    it("replicates particles and enlarges the cell through a replicate node", () => {
      const boxSnapshot = makeSnapshot({
        nAtoms: 1,
        positions: [1, 1, 1],
        elements: [6],
        box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
      });
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: true }),
        makeNode("rep", "replicate", { nx: 2, ny: 1, nz: 1 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "rep", "particle"),
        makeEdge("ls", "cell", "rep", "cell"),
        makeEdge("rep", "particle", "vp", "particle"),
        makeEdge("rep", "cell", "vp", "cell"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: boxSnapshot,
      });
      expect(result.particles[0].source.nAtoms).toBe(2);
      expect(result.cells[0].box[0]).toBe(20);
      expect(nodeErrors.get("rep")).toBeUndefined();
    });

    it("warns when a replicate node has no unit cell but counts > 1", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("rep", "replicate", { nx: 2, ny: 2, nz: 2 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "rep", "particle"),
        makeEdge("rep", "particle", "vp", "particle"),
      ];

      const { nodeErrors } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(nodeErrors.get("rep")?.[0].message).toContain("unit cell");
    });

    it("expands the asymmetric unit through a symmetry node", () => {
      const cifSnapshot: Snapshot = {
        ...makeSnapshot({
          nAtoms: 1,
          positions: [3, 3, 3],
          elements: [8],
          box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
        }),
        symmetryOps: ["x,y,z", "-x,-y,-z"],
      };
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: true }),
        makeNode("sym", "symmetry", { mode: "expand" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "sym", "particle"),
        makeEdge("sym", "particle", "vp", "particle"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: cifSnapshot,
      });
      expect(result.particles[0].source.nAtoms).toBe(2);
      expect(nodeErrors.get("sym")).toBeUndefined();
    });

    it("symmetry mode none passes the asymmetric unit through", () => {
      const cifSnapshot: Snapshot = {
        ...makeSnapshot({
          nAtoms: 1,
          positions: [3, 3, 3],
          elements: [8],
          box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
        }),
        symmetryOps: ["x,y,z", "-x,-y,-z"],
      };
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: true }),
        makeNode("sym", "symmetry", { mode: "none" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "sym", "particle"),
        makeEdge("sym", "particle", "vp", "particle"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: cifSnapshot,
      });
      expect(result.particles[0].source.nAtoms).toBe(1);
      expect(nodeErrors.get("sym")).toBeUndefined();
    });

    it("warns when a symmetry node has operations but no unit cell", () => {
      const cifSnapshot: Snapshot = {
        ...makeSnapshot({ nAtoms: 1, positions: [3, 3, 3], elements: [8] }),
        symmetryOps: ["x,y,z", "-x,-y,-z"],
      };
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("sym", "symmetry", { mode: "expand" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "sym", "particle"),
        makeEdge("sym", "particle", "vp", "particle"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: cifSnapshot,
      });
      expect(nodeErrors.get("sym")?.[0].message).toContain("unit cell");
      // Pass-through: the particles still reach the viewport unchanged.
      expect(result.particles).toHaveLength(1);
      expect(result.particles[0].source.nAtoms).toBe(1);
    });

    it("stays silent for a structure without symmetry operations", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("sym", "symmetry", { mode: "expand" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "sym", "particle"),
        makeEdge("sym", "particle", "vp", "particle"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: waterSnapshot,
      });
      expect(nodeErrors.get("sym")).toBeUndefined();
      expect(result.particles[0].source.nAtoms).toBe(3);
    });

    it("warns and passes through when a symmetry node also receives a trajectory", () => {
      const frames: Frame[] = [{ frameId: 0, nAtoms: 1, positions: new Float32Array(3) }];
      const meta: TrajectoryMeta = { nFrames: 1, timestepPs: 1.0, nAtoms: 1 };
      const cifSnapshot: Snapshot = {
        ...makeSnapshot({
          nAtoms: 1,
          positions: [3, 3, 3],
          elements: [8],
          box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
        }),
        symmetryOps: ["x,y,z", "-x,-y,-z"],
      };
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: true, hasCell: true }),
        makeNode("sym", "symmetry", { mode: "expand" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "sym", "particle"),
        makeEdge("ls", "trajectory", "sym", "trajectory"),
        makeEdge("sym", "particle", "vp", "particle"),
        makeEdge("sym", "trajectory", "vp", "trajectory"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: cifSnapshot,
        structureFrames: frames,
        structureMeta: meta,
      });
      expect(nodeErrors.get("sym")?.[0].message).toContain("trajectory");
      expect(result.particles[0].source.nAtoms).toBe(1);
      expect(result.trajectories).toHaveLength(1);
    });

    it("warns when a symmetry node has no input", () => {
      const nodes = [
        makeNode("sym", "symmetry", { mode: "expand" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("sym", "particle", "vp", "particle")];

      const { nodeErrors } = executePipeline(nodes, edges, {});
      expect(nodeErrors.get("sym")?.[0].message).toContain("No input data");
    });

    it("wraps particles into the cell through a wrap node", () => {
      const boxSnapshot = makeSnapshot({
        nAtoms: 1,
        positions: [11, 1, 1],
        elements: [6],
        box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
      });
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: true }),
        makeNode("wrap", "wrap", { mode: "wrap" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "wrap", "particle"),
        makeEdge("wrap", "particle", "vp", "particle"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: boxSnapshot,
      });
      expect(result.particles[0].source.positions[0]).toBeCloseTo(1, 5);
      expect(nodeErrors.get("wrap")).toBeUndefined();
    });

    it("warns when an active wrap node has no unit cell", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("wrap", "wrap", { mode: "unwrap" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "wrap", "particle"),
        makeEdge("wrap", "particle", "vp", "particle"),
      ];

      const { viewportState: result, nodeErrors } = executePipeline(nodes, edges, {
        snapshot: waterSnapshot,
      });
      expect(nodeErrors.get("wrap")?.[0].message).toContain("unit cell");
      // Pass-through: the particles still reach the viewport unchanged.
      expect(result.particles).toHaveLength(1);
    });

    it("warns when a wrap node has no input", () => {
      const nodes = [
        makeNode("wrap", "wrap", { mode: "none" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("wrap", "particle", "vp", "particle")];

      const { nodeErrors } = executePipeline(nodes, edges, {});
      expect(nodeErrors.get("wrap")?.[0].message).toContain("No input data");
    });

    it("produces trajectory output when frames exist", () => {
      const frames: Frame[] = [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9) }];
      const meta: TrajectoryMeta = { nFrames: 1, timestepPs: 1.0, nAtoms: 3 };

      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: true, hasCell: false }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "vp", "particle"),
        makeEdge("ls", "trajectory", "vp", "trajectory"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: waterSnapshot,
        structureFrames: frames,
        structureMeta: meta,
      });
      expect(result.trajectories).toHaveLength(1);
      expect(result.trajectories[0].source).toBe("structure");
    });

    it("returns default state when no snapshot", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: null });
      expect(result.particles).toHaveLength(0);
    });
  });

  describe("Filter node", () => {
    it("passes through on empty query", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: "" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "f", "in"), makeEdge("f", "out", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: fiveAtomSnapshot,
      });
      expect(result.particles).toHaveLength(1);
      expect(result.particles[0].indices).toBeNull(); // all atoms
    });

    it("filters by element", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'element == "H"' }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "f", "in"), makeEdge("f", "out", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: fiveAtomSnapshot,
      });
      expect(result.particles).toHaveLength(1);
      const indices = Array.from(result.particles[0].indices!);
      expect(indices).toEqual([3, 4]);
    });

    it("passes through on invalid query", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: "invalid_syntax!!!" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "f", "in"), makeEdge("f", "out", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: fiveAtomSnapshot,
      });
      expect(result.particles).toHaveLength(1);
      // Should pass through unchanged on parse error
      expect(result.particles[0].indices).toBeNull();
    });
  });

  describe("Modify node", () => {
    it("applies global scale override", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("m", "modify", { scale: 0.5, opacity: 1.0 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "m", "in"), makeEdge("m", "out", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: fiveAtomSnapshot,
      });
      const p = result.particles[0];
      expect(p.scaleOverrides).not.toBeNull();
      expect(p.scaleOverrides!.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(p.scaleOverrides![i]).toBe(0.5);
      }
    });

    it("applies scale only to filtered indices", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'element == "H"' }),
        makeNode("m", "modify", { scale: 2.0, opacity: 1.0 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "f", "in"),
        makeEdge("f", "out", "m", "in"),
        makeEdge("m", "out", "vp", "particle"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: fiveAtomSnapshot,
      });
      const p = result.particles[0];
      expect(p.scaleOverrides).not.toBeNull();
      // H atoms at indices 3,4 should be 2.0; others 1.0
      expect(p.scaleOverrides![0]).toBe(1.0); // C
      expect(p.scaleOverrides![3]).toBe(2.0); // H
      expect(p.scaleOverrides![4]).toBe(2.0); // H
    });
  });

  describe("AddBond node", () => {
    it("uses structure bonds when bondSource is 'structure'", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("ab", "add_bond", { bondSource: "structure" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "ab", "particle"),
        makeEdge("ab", "bond", "vp", "bond"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.bonds).toHaveLength(1);
      expect(result.bonds[0].nBonds).toBe(2);
    });

    it("computes distance-based bonds", () => {
      // Two carbons at 1.5 Å
      const closeAtoms = makeSnapshot({
        nAtoms: 2,
        positions: [0, 0, 0, 1.5, 0, 0],
        elements: [6, 6],
      });
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("ab", "add_bond", { bondSource: "distance" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "ab", "particle"),
        makeEdge("ab", "bond", "vp", "bond"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: closeAtoms });
      expect(result.bonds).toHaveLength(1);
      expect(result.bonds[0].nBonds).toBe(1);
    });

    it("processes PBC bonds with ghost atoms", () => {
      // Water molecule where one H is wrapped to the opposite side of a 4 Å box
      // O at (0.5, 2, 2), H1 at (1.4, 2, 2) (normal), H2 at (3.6, 2, 2) (wrapped)
      // O-H1 distance = 0.9 Å (keep), O-H2 distance = 3.1 Å > 4/2 = 2.0 Å (PBC bond)
      const wrappedWater = makeSnapshot({
        nAtoms: 3,
        positions: [0.5, 2, 2, 1.4, 2, 2, 3.6, 2, 2],
        elements: [8, 1, 1],
        bonds: [0, 1, 0, 2],
        bondOrders: [1, 1],
        box: [4, 0, 0, 0, 4, 0, 0, 0, 4],
      });
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: true }),
        makeNode("ab", "add_bond", { bondSource: "structure" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "ab", "particle"),
        makeEdge("ab", "bond", "vp", "bond"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: wrappedWater });
      expect(result.bonds).toHaveLength(1);
      const bond = result.bonds[0];
      // 1 normal bond (O-H1) + 2 half-bonds for PBC bond (O-H2)
      expect(bond.nBonds).toBe(3);
      // First bond: O-H1 (normal, indices 0,1)
      expect(bond.bondIndices[0]).toBe(0);
      expect(bond.bondIndices[1]).toBe(1);
      // Second bond: O → ghost_H2 (index 3, first ghost atom)
      expect(bond.bondIndices[2]).toBe(0);
      expect(bond.bondIndices[3]).toBe(3);
      // Third bond: H2 → ghost_O (index 4, second ghost atom)
      expect(bond.bondIndices[4]).toBe(2);
      expect(bond.bondIndices[5]).toBe(4);
      // Extended positions/elements include ghost atoms
      expect(bond.positions).not.toBeNull();
      expect(bond.elements).not.toBeNull();
      expect(bond.nAtoms).toBe(5); // 3 original + 2 ghosts
      // Ghost_H2 should be near O (minimum-image of H2 near O)
      // O at (0.5, 2, 2), H2 at (3.6, 2, 2), min-image displacement = -0.4-0.5 = -0.9? No...
      // dx = 3.6 - 0.5 = 3.1, fractional = 3.1/4 = 0.775, wrapped = 0.775 - 1 = -0.225
      // dxMin = -0.225 * 4 = -0.9, ghost_H2 = 0.5 + (-0.9) = -0.4
      expect(bond.positions![3 * 3]).toBeCloseTo(-0.4, 1); // ghost_H2 x
      expect(bond.positions![3 * 3 + 1]).toBeCloseTo(2, 1); // ghost_H2 y
      // ghost_O = H2 - dMin = 3.6 - (-0.9) = 4.5
      expect(bond.positions![4 * 3]).toBeCloseTo(4.5, 1); // ghost_O x
    });

    it("PBC processing keeps all bonds when no box", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("ab", "add_bond", { bondSource: "structure" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "ab", "particle"),
        makeEdge("ab", "bond", "vp", "bond"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.bonds).toHaveLength(1);
      expect(result.bonds[0].nBonds).toBe(2);
    });

    it("distance-based bond detection finds bonds across PBC boundaries", () => {
      // Two H atoms at opposite edges of a 3 Å box
      // H1 at (0.1, 1.5, 1.5), H2 at (2.9, 1.5, 1.5)
      // Cartesian distance = 2.8 Å (too far for H-H bond)
      // PBC minimum-image distance = 0.2 Å... too close (< MIN_BOND_DIST=0.4)
      // Let's use: H1 at (0.2, 1.5, 1.5), H2 at (2.5, 1.5, 1.5) in a 3 Å box
      // Cartesian distance = 2.3 Å, PBC min-image distance = 0.7 Å
      // VDW_RADII[H] = 1.2, threshold = (1.2+1.2)*0.6 = 1.44 Å
      // 0.7 < 1.44 so bond should be found via PBC
      const pbcAtoms = makeSnapshot({
        nAtoms: 2,
        positions: [0.2, 1.5, 1.5, 2.5, 1.5, 1.5],
        elements: [1, 1],
        bonds: [],
        bondOrders: [],
        box: [3, 0, 0, 0, 3, 0, 0, 0, 3],
      });
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: true }),
        makeNode("ab", "add_bond", { bondSource: "distance" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "ab", "particle"),
        makeEdge("ab", "bond", "vp", "bond"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: pbcAtoms });
      expect(result.bonds).toHaveLength(1);
      // Bond should be found (PBC minimum-image distance ~0.7 Å < 1.44 Å threshold)
      expect(result.bonds[0].nBonds).toBeGreaterThanOrEqual(1);
    });

    it("returns no bonds for 'none' source", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("ab", "add_bond", { bondSource: "none" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "ab", "particle"),
        makeEdge("ab", "bond", "vp", "bond"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.bonds).toHaveLength(0);
    });
  });

  describe("LabelGenerator node", () => {
    it("generates element labels", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("lg", "label_generator", { source: "element" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "lg", "particle"),
        makeEdge("lg", "label", "vp", "label"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].labels).toEqual(["O", "H", "H"]);
    });

    it("generates index labels", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("lg", "label_generator", { source: "index" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "lg", "particle"),
        makeEdge("lg", "label", "vp", "label"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.labels[0].labels).toEqual(["0", "1", "2"]);
    });
  });

  describe("Viewport node", () => {
    it("sets perspective and cellAxesVisible from params", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("vp", "viewport", { perspective: true, cellAxesVisible: false }),
      ];
      const edges = [makeEdge("ls", "particle", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.perspective).toBe(true);
      expect(result.cellAxesVisible).toBe(false);
    });

    it("prioritizes file trajectory over structure trajectory", () => {
      const structFrames: Frame[] = [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9) }];
      const fileFrames: Frame[] = [
        { frameId: 0, nAtoms: 3, positions: new Float32Array(9) },
        { frameId: 1, nAtoms: 3, positions: new Float32Array(9) },
      ];
      const structMeta: TrajectoryMeta = { nFrames: 1, timestepPs: 1.0, nAtoms: 3 };
      const fileMeta: TrajectoryMeta = { nFrames: 2, timestepPs: 1.0, nAtoms: 3 };

      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: true, hasCell: false }),
        makeNode("lt", "load_trajectory", { fileName: null }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "vp", "particle"),
        makeEdge("ls", "trajectory", "vp", "trajectory"),
        makeEdge("lt", "trajectory", "vp", "trajectory"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: waterSnapshot,
        structureFrames: structFrames,
        structureMeta: structMeta,
        fileFrames: fileFrames,
        fileMeta: fileMeta,
      });
      expect(result.trajectories).toHaveLength(2);
      // File trajectory should come first
      expect(result.trajectories[0].source).toBe("file");
    });
  });

  describe("Disabled nodes", () => {
    it("passes through data when node is disabled", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'element == "H"' }, false), // disabled
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "f", "in"), makeEdge("f", "out", "vp", "particle")];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: fiveAtomSnapshot,
      });
      expect(result.particles).toHaveLength(1);
      // Should pass through all atoms (filter disabled)
      expect(result.particles[0].indices).toBeNull();
    });
  });

  describe("Full pipeline", () => {
    it("executes LoadStructure → Filter → Modify → Viewport", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'element == "C" or element == "N"' }),
        makeNode("m", "modify", { scale: 0.3, opacity: 0.8 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "f", "in"),
        makeEdge("f", "out", "m", "in"),
        makeEdge("m", "out", "vp", "particle"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, {
        snapshot: fiveAtomSnapshot,
      });
      expect(result.particles).toHaveLength(1);

      const p = result.particles[0];
      // Filter should select C(0) and N(1)
      const indices = Array.from(p.indices!);
      expect(indices).toEqual([0, 1]);

      // Modify should set scale for indices 0,1
      expect(p.scaleOverrides![0]).toBeCloseTo(0.3);
      expect(p.scaleOverrides![1]).toBeCloseTo(0.3);
      // Others should be 1.0
      expect(p.scaleOverrides![2]).toBeCloseTo(1.0);
    });
  });

  // Regression: `resname` selections must work using the structure's parsed
  // residue labels (stored per load_structure node in ctx.nodeSnapshots) even
  // when no display label source is active (ctx.atomLabels is null). Before the
  // fix, `resname == "HOH"` matched nothing and `resname != "HOH"` matched all
  // atoms, so "make the water semi-transparent" left the water fully opaque.
  describe("resname filter + opacity (regression)", () => {
    // 5 atoms: first three are water (HOH), last two are caffeine (CAF).
    const labels = ["HOH", "HOH", "HOH", "CAF", "CAF"];
    const nodeSnapshots = {
      ls: { snapshot: fiveAtomSnapshot, frames: null, meta: null, labels },
    };

    it('resname == "HOH" + opacity applies only to the water atoms', () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'resname == "HOH"' }),
        makeNode("m", "modify", { scale: 1.0, opacity: 0.25 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "f", "in"),
        makeEdge("f", "out", "m", "in"),
        makeEdge("m", "out", "vp", "particle"),
      ];

      // Note: ctx.atomLabels is intentionally NOT set — this mirrors the real
      // default (display label source = "none").
      const { viewportState: result } = executePipeline(nodes, edges, { nodeSnapshots });
      const p = result.particles[0];

      // Filter selects only the water atoms.
      expect(Array.from(p.indices!)).toEqual([0, 1, 2]);
      // Water faded to 0.25, caffeine untouched at 1.0.
      expect(p.opacityOverrides![0]).toBeCloseTo(0.25);
      expect(p.opacityOverrides![1]).toBeCloseTo(0.25);
      expect(p.opacityOverrides![2]).toBeCloseTo(0.25);
      expect(p.opacityOverrides![3]).toBeCloseTo(1.0);
      expect(p.opacityOverrides![4]).toBeCloseTo(1.0);
    });

    it('resname != "HOH" selects only the caffeine atoms', () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'resname != "HOH"' }),
        makeNode("m", "modify", { scale: 1.0, opacity: 0.25 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "f", "in"),
        makeEdge("f", "out", "m", "in"),
        makeEdge("m", "out", "vp", "particle"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { nodeSnapshots });
      const p = result.particles[0];

      expect(Array.from(p.indices!)).toEqual([3, 4]);
      expect(p.opacityOverrides![3]).toBeCloseTo(0.25);
      expect(p.opacityOverrides![4]).toBeCloseTo(0.25);
      expect(p.opacityOverrides![0]).toBeCloseTo(1.0);
    });

    it("explicit ctx.atomLabels (display label source) take priority over structure labels", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'resname == "HOH"' }),
        makeNode("m", "modify", { scale: 1.0, opacity: 0.25 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "f", "in"),
        makeEdge("f", "out", "m", "in"),
        makeEdge("m", "out", "vp", "particle"),
      ];

      // Display labels say everything is CAF; with these taking priority,
      // `resname == "HOH"` should match nothing — proving the structure-label
      // fallback only kicks in when no display source is active.
      const { viewportState: result } = executePipeline(nodes, edges, {
        nodeSnapshots,
        atomLabels: ["CAF", "CAF", "CAF", "CAF", "CAF"],
      });
      const p = result.particles[0];
      expect(Array.from(p.indices!)).toEqual([]);
    });
  });

  // Regression: color-by-residue must likewise resolve residue names from the
  // structure's parsed labels without an active display label source.
  describe("color byResidue uses structure labels by default", () => {
    const threeAtom = makeSnapshot({
      nAtoms: 3,
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
      elements: [6, 6, 7],
    });

    function run(ctx: Parameters<typeof executePipeline>[2]) {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("c", "color", { mode: "byResidue", uniformColor: "#ffffff" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("ls", "particle", "c", "in"), makeEdge("c", "out", "vp", "particle")];
      return executePipeline(nodes, edges, ctx).viewportState.particles[0];
    }

    it("paints distinct residue colors from node-snapshot labels", () => {
      const p = run({
        nodeSnapshots: {
          ls: { snapshot: threeAtom, frames: null, meta: null, labels: ["ALA", "ALA", "GLY"] },
        },
      });
      const co = p.colorOverrides!;
      // ALA shapely color and GLY shapely color (stable constants).
      expect([co[0], co[1], co[2]]).toEqual([
        expect.closeTo(0.78),
        expect.closeTo(0.78),
        expect.closeTo(0.78),
      ]);
      expect([co[6], co[7], co[8]]).toEqual([
        expect.closeTo(1.0),
        expect.closeTo(1.0),
        expect.closeTo(1.0),
      ]);
    });

    it("falls back to the default residue color when no labels are available", () => {
      // No nodeSnapshots labels and no atomLabels → resname unknown → default.
      const p = run({ snapshot: threeAtom });
      const co = p.colorOverrides!;
      expect([co[0], co[1], co[2]]).toEqual([
        expect.closeTo(0.65),
        expect.closeTo(0.65),
        expect.closeTo(0.65),
      ]);
    });
  });

  describe("SurfaceMesh node", () => {
    it("produces a mesh output when connected to a particle source", () => {
      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("sm", "surface_mesh", { alphaRadius: 3.0, color: "#4488ff", opacity: 0.5 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "sm", "particle"),
        makeEdge("sm", "mesh", "vp", "mesh"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot: waterSnapshot });
      expect(result.meshes).toHaveLength(1);
    });

    it("adds a warning error when no particle is connected", () => {
      const nodes = [
        makeNode("sm", "surface_mesh", { alphaRadius: 3.0, color: "#4488ff", opacity: 0.5 }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [makeEdge("sm", "mesh", "vp", "mesh")];

      const { nodeErrors } = executePipeline(nodes, edges, {});
      expect(nodeErrors.get("sm")).toBeDefined();
    });
  });

  describe("bond filtering by particles", () => {
    it("filters bonds when particle stream has filtered indices", () => {
      // Snapshot with bonds 0-1 and 0-2
      const snapshot = makeSnapshot({
        nAtoms: 3,
        positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
        elements: [6, 1, 1], // C, H, H
        bonds: [0, 1, 0, 2],
        bondOrders: [1, 1],
      });

      const nodes = [
        makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
        makeNode("f", "filter", { query: 'element == "C" or index == 1' }), // only C(0) and H(1)
        makeNode("ab", "add_bond", { bondSource: "structure" }),
        makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
      ];
      const edges = [
        makeEdge("ls", "particle", "f", "in"),
        makeEdge("f", "out", "vp", "particle"),
        makeEdge("ls", "particle", "ab", "particle"),
        makeEdge("ab", "bond", "vp", "bond"),
      ];

      const { viewportState: result } = executePipeline(nodes, edges, { snapshot });
      // Both particle streams: filtered (indices 0,1) and unfiltered (from ab→particle)
      // Since ab gets unfiltered particle (all), bonds should pass through
      // The unfiltered particle stream has indices=null, so no bond filtering
      expect(result.bonds).toHaveLength(1);
    });
  });
});

describe("executePipeline isosurface color-by-volume", () => {
  function makeVolParams(gradientAxis: "x" | "y") {
    const nx = 3,
      ny = 2,
      nz = 2;
    const data = new Float32Array(nx * ny * nz);
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          data[ix * ny * nz + iy * nz + iz] = gradientAxis === "x" ? ix : iy;
        }
      }
    }
    return {
      fileName: "field.cube",
      volumetricData: {
        type: "volumetric",
        nx,
        ny,
        nz,
        origin: new Float32Array([0, 0, 0]),
        step: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        data,
        dataMin: 0,
        dataMax: gradientAxis === "x" ? nx - 1 : ny - 1,
      },
    };
  }

  it("warns when colorMode is 'volume' but no color volume is connected", () => {
    const nodes = [
      makeNode("lv", "load_volumetric", makeVolParams("x")),
      makeNode("iso", "isosurface", {
        isoLevel: 1.5,
        color: "#4488ff",
        opacity: 0.7,
        showNegative: false,
        negativeColor: "#ff4444",
        colorMode: "volume",
        colormap: "rwb",
      }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [
      makeEdge("lv", "volumetric", "iso", "volumetric"),
      makeEdge("iso", "mesh", "vp", "mesh"),
    ];

    const { viewportState, nodeErrors } = executePipeline(nodes, edges, {});
    expect(viewportState.meshes).toHaveLength(1);
    expect(nodeErrors.get("iso")?.some((e) => e.message.includes("Color Volume"))).toBe(true);
  });

  it("colors the mesh from a second volume connected to colorVolumetric", () => {
    const nodes = [
      makeNode("lv", "load_volumetric", makeVolParams("x")),
      makeNode("cv", "load_volumetric", makeVolParams("y")),
      makeNode("iso", "isosurface", {
        isoLevel: 1.5,
        color: "#4488ff",
        opacity: 0.7,
        showNegative: false,
        negativeColor: "#ff4444",
        colorMode: "volume",
        colormap: "rainbow",
      }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [
      makeEdge("lv", "volumetric", "iso", "volumetric"),
      makeEdge("cv", "volumetric", "iso", "colorVolumetric"),
      makeEdge("iso", "mesh", "vp", "mesh"),
    ];

    const { viewportState, nodeErrors } = executePipeline(nodes, edges, {});
    expect(nodeErrors.get("iso")).toBeUndefined();
    expect(viewportState.meshes).toHaveLength(1);
    const mesh = viewportState.meshes[0];
    expect(mesh.positions.length).toBeGreaterThan(0);
    // The y-gradient color volume must produce non-uniform vertex colors on
    // the x = 1.5 isosurface plane.
    const first = [mesh.colors[0], mesh.colors[1], mesh.colors[2]];
    let varies = false;
    for (let i = 1; i < mesh.colors.length / 4; i++) {
      if (
        Math.abs(mesh.colors[i * 4] - first[0]) > 1e-3 ||
        Math.abs(mesh.colors[i * 4 + 1] - first[1]) > 1e-3 ||
        Math.abs(mesh.colors[i * 4 + 2] - first[2]) > 1e-3
      ) {
        varies = true;
        break;
      }
    }
    expect(varies).toBe(true);
  });
});
