import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import {
  NODE_EXECUTORS,
  getNodeExecutor,
  particleSourceNodeId,
  resolveEffectiveLabels,
  type NodeExecutorContext,
  type NodeExecutorResult,
  type NodeParamsOf,
} from "@/pipeline/executors/registry";
import { executePipeline, type PipelineNodeData } from "@/pipeline/execute";
import { NODE_CATALOG } from "@/pipeline/catalog";
import {
  NODE_PORTS,
  NODE_TYPE_LABELS,
  defaultParams,
  type CoordinationData,
  type NodeError,
  type ParticleData,
  type PipelineData,
  type PipelineNodeType,
  type TrajectoryData,
} from "@/pipeline/types";
import type { Snapshot } from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────

function snapshot(opts: { nAtoms?: number; box?: boolean; symmetryOps?: string[] } = {}): Snapshot {
  const nAtoms = opts.nAtoms ?? 1;
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3).map((_, i) => i * 10),
    elements: new Uint8Array(nAtoms).fill(6),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: opts.box ? new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]) : null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
    ...(opts.symmetryOps ? { symmetryOps: opts.symmetryOps } : {}),
  };
}

function particle(snap: Snapshot = snapshot(), indices: Uint32Array | null = null): ParticleData {
  return {
    type: "particle",
    source: snap,
    sourceNodeId: "ls",
    indices,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
  };
}

const trajectory: TrajectoryData = {
  type: "trajectory",
  provider: { getFrame: () => null } as unknown as TrajectoryData["provider"],
  meta: { nFrames: 2, timestepPs: 1, nAtoms: 1 } as TrajectoryData["meta"],
  source: "file",
};

interface Run {
  result: NodeExecutorResult;
  errors: NodeError[];
}

function run<T extends PipelineNodeType>(
  type: T,
  opts: {
    params?: Partial<NodeParamsOf<T>>;
    inputs?: Record<string, PipelineData[]>;
    ctx?: NodeExecutorContext<T>["ctx"];
    nodes?: Node<PipelineNodeData>[];
    id?: string;
  } = {},
): Run {
  const errors: NodeError[] = [];
  const params = { ...defaultParams(type), ...opts.params } as NodeParamsOf<T>;
  const executor = NODE_EXECUTORS[type] as (c: NodeExecutorContext<T>) => NodeExecutorResult;
  const result = executor({
    id: opts.id ?? "n",
    params,
    inputs: new Map(Object.entries(opts.inputs ?? {})),
    nodes: opts.nodes ?? [],
    ctx: opts.ctx ?? {},
    addError: (e) => errors.push(e),
  });
  return { result, errors };
}

const messages = (r: Run) => r.errors.map((e) => e.message);
const NO_INPUT = "No input data (check upstream nodes)";

// ─── Exhaustiveness ──────────────────────────────────────────────────

describe("NODE_EXECUTORS registry", () => {
  const types = Object.keys(NODE_PORTS) as PipelineNodeType[];

  it("has exactly one executor per node type in NODE_CATALOG / NODE_PORTS", () => {
    expect(Object.keys(NODE_EXECUTORS).sort()).toEqual(Object.keys(NODE_CATALOG).sort());
    expect(Object.keys(NODE_EXECUTORS).sort()).toEqual([...types].sort());
    expect(Object.keys(NODE_EXECUTORS).sort()).toEqual(Object.keys(NODE_TYPE_LABELS).sort());
    for (const t of types) expect(typeof NODE_EXECUTORS[t]).toBe("function");
  });

  it("only the viewport executor yields a ViewportState; every other node publishes outputs", () => {
    for (const t of types) {
      const { result } = run(t);
      if (t === "viewport") {
        expect(result.outputs).toBeUndefined();
        expect(result.viewportState).toBeDefined();
      } else {
        expect(result.outputs).toBeInstanceOf(Map);
        expect(result.viewportState).toBeUndefined();
      }
    }
  });
});

describe("getNodeExecutor", () => {
  it("returns the registered executor for a known type", () => {
    expect(getNodeExecutor("filter")).toBe(NODE_EXECUTORS.filter);
  });

  it("returns undefined for unknown types and prototype keys", () => {
    expect(getNodeExecutor("no_such_node")).toBeUndefined();
    expect(getNodeExecutor("toString")).toBeUndefined();
    expect(getNodeExecutor("__proto__")).toBeUndefined();
  });

  it("executePipeline skips an enabled node of unknown type without publishing outputs", () => {
    const nodes: Node<PipelineNodeData>[] = [
      {
        id: "x",
        position: { x: 0, y: 0 },
        data: { params: { type: "mystery" } as never, enabled: true },
      },
    ];
    const res = executePipeline(nodes, []);
    expect(res.nodeErrors.size).toBe(0);
  });
});

// ─── Label helpers ───────────────────────────────────────────────────

describe("label helpers", () => {
  it("resolveEffectiveLabels prefers display labels, then per-node residue labels", () => {
    const labels = ["HOH"];
    expect(resolveEffectiveLabels({ atomLabels: ["A"] }, "ls")).toEqual(["A"]);
    expect(
      resolveEffectiveLabels(
        { nodeSnapshots: { ls: { snapshot: snapshot(), frames: null, meta: null, labels } } },
        "ls",
      ),
    ).toBe(labels);
    expect(resolveEffectiveLabels({}, "ls")).toBeNull();
    expect(resolveEffectiveLabels({}, undefined)).toBeNull();
  });

  it("particleSourceNodeId reads only particle streams on the `in` port", () => {
    expect(particleSourceNodeId(new Map([["in", [particle()]]]))).toBe("ls");
    expect(particleSourceNodeId(new Map([["in", [trajectory]]]))).toBeUndefined();
    expect(particleSourceNodeId(new Map())).toBeUndefined();
  });
});

// ─── Per-executor dispatch ───────────────────────────────────────────

describe("per-node executors", () => {
  it("load_structure resolves the per-node snapshot before the global one", () => {
    const perNode = snapshot({ nAtoms: 2 });
    const r = run("load_structure", {
      id: "ls",
      ctx: {
        snapshot: snapshot({ nAtoms: 5 }),
        nodeSnapshots: { ls: { snapshot: perNode, frames: null, meta: null, labels: null } },
      },
    });
    expect((r.result.outputs!.get("particle") as ParticleData).source).toBe(perNode);
    expect(r.errors).toEqual([]);
    expect(messages(run("load_structure"))).toEqual(["No structure data available"]);
  });

  it("load_structure surfaces edit-op warnings unless edits are bypassed", () => {
    const params = { edits: [{ op: "set_cell" as const, box: [1, 2, 3] }] };
    const ctx = { snapshot: snapshot() };
    expect(messages(run("load_structure", { params, ctx }))).toEqual([
      "set_cell: box must have 9 values (skipped)",
    ]);
    expect(
      messages(run("load_structure", { params, ctx: { ...ctx, editsBypassed: true } })),
    ).toEqual([]);
  });

  it("load_trajectory in structure mode reads the first loader's channels", () => {
    const loader: Node<PipelineNodeData> = {
      id: "ls",
      position: { x: 0, y: 0 },
      data: { params: defaultParams("load_structure"), enabled: true },
    };
    const frames = [{ frameId: 0, nAtoms: 1, positions: new Float32Array(3) }];
    const meta = { nFrames: 1, timestepPs: 1, nAtoms: 1 } as TrajectoryData["meta"];
    const withLoader = run("load_trajectory", {
      params: { source: "structure" },
      nodes: [loader],
      ctx: {
        nodeSnapshots: { ls: { snapshot: snapshot(), frames, meta, labels: null } },
      },
    });
    expect(withLoader.result.outputs).toBeInstanceOf(Map);
    // No loader node at all falls back to the global channels.
    const noLoader = run("load_trajectory", { params: { source: "structure" } });
    expect(noLoader.result.outputs).toBeInstanceOf(Map);
    expect(noLoader.errors).toEqual([]);
  });

  it("streaming warns until the stream delivers a snapshot", () => {
    expect(messages(run("streaming"))).toEqual(["No streaming data available"]);
    const r = run("streaming", {
      id: "s",
      ctx: {
        nodeStreamingData: { s: { snapshot: snapshot(), streamProvider: null } },
      },
    });
    expect(r.errors).toEqual([]);
  });

  it("add_bond distinguishes missing input, empty structures and no bonds", () => {
    expect(messages(run("add_bond"))).toEqual([NO_INPUT]);
    expect(
      messages(run("add_bond", { inputs: { particle: [particle(snapshot({ nAtoms: 0 }))] } })),
    ).toEqual([]);
    expect(messages(run("add_bond", { inputs: { particle: [particle()] } }))).toEqual([
      "No bonds found",
    ]);
  });

  it("coordination_generator warns on missing input and on no pairs", () => {
    expect(messages(run("coordination_generator"))).toEqual([NO_INPUT]);
    expect(messages(run("coordination_generator", { inputs: { particle: [particle()] } }))).toEqual(
      ["No coordination pairs found"],
    );
  });

  it("boundary_completion needs both particle and bond inputs", () => {
    expect(messages(run("boundary_completion"))).toEqual([
      "Particle and bond inputs are both required",
    ]);
  });

  it("filter warns on missing input and on an empty selection", () => {
    expect(messages(run("filter"))).toEqual([NO_INPUT]);
    expect(
      messages(run("filter", { inputs: { in: [particle(snapshot(), new Uint32Array(0))] } })),
    ).toEqual(["Filter returned 0 atoms"]);
    expect(messages(run("filter", { inputs: { in: [particle()] } }))).toEqual([]);
  });

  it("modify / color / representation warn when nothing is wired into `in`", () => {
    for (const t of ["modify", "color", "representation"] as const) {
      expect(messages(run(t))).toEqual([NO_INPUT]);
      expect(messages(run(t, { inputs: { in: [particle()] } }))).toEqual([]);
    }
  });

  it("label_generator / surface_mesh warn without a particle input", () => {
    for (const t of ["label_generator", "surface_mesh"] as const) {
      expect(messages(run(t))).toEqual([NO_INPUT]);
    }
  });

  it("vector_overlay warns without a vector input", () => {
    expect(messages(run("vector_overlay"))).toEqual([NO_INPUT]);
  });

  it("symmetry reports missing cell and trajectory conflicts only when ops exist", () => {
    expect(messages(run("symmetry"))).toEqual([NO_INPUT]);
    const ops = ["x,y,z", "-x,-y,-z"];
    expect(
      messages(
        run("symmetry", { inputs: { particle: [particle(snapshot({ symmetryOps: ops }))] } }),
      ),
    ).toEqual(["Symmetry expansion requires a unit cell"]);
    expect(
      messages(
        run("symmetry", {
          inputs: {
            particle: [particle(snapshot({ symmetryOps: ops, box: true }))],
            trajectory: [trajectory],
          },
        }),
      ),
    ).toEqual(["Symmetry expansion skipped: trajectory input present"]);
    expect(messages(run("symmetry", { inputs: { particle: [particle()] } }))).toEqual([]);
  });

  it("wrap needs a cell unless its mode is none", () => {
    expect(messages(run("wrap"))).toEqual([NO_INPUT]);
    expect(messages(run("wrap", { inputs: { particle: [particle()] } }))).toEqual([]);
    expect(
      messages(run("wrap", { params: { mode: "wrap" }, inputs: { particle: [particle()] } })),
    ).toEqual(["Wrap / Unwrap requires a unit cell"]);
  });

  it("replicate needs a cell only when a count exceeds one", () => {
    expect(messages(run("replicate"))).toEqual([NO_INPUT]);
    expect(messages(run("replicate", { inputs: { particle: [particle()] } }))).toEqual([]);
    expect(
      messages(run("replicate", { params: { nx: 2 }, inputs: { particle: [particle()] } })),
    ).toEqual(["Replicate requires a unit cell"]);
  });

  it("drawing_boundary needs a particle input with a cell", () => {
    expect(messages(run("drawing_boundary"))).toEqual([NO_INPUT]);
    expect(messages(run("drawing_boundary", { inputs: { particle: [particle()] } }))).toEqual([
      "Drawing Boundary requires a unit cell",
    ]);
  });

  it("polyhedron_generator warns on missing input and on hull-less coordination", () => {
    expect(messages(run("polyhedron_generator"))).toEqual([NO_INPUT]);
    const p = particle();
    const coordination: CoordinationData = {
      type: "coordination",
      sourceNodeId: "c",
      particleRef: p,
      bondIndices: new Uint32Array(0),
      nBonds: 0,
      positions: p.source.positions,
      elements: p.source.elements,
      nAtoms: 1,
      outsideBoundaryImages: null,
    };
    expect(
      messages(run("polyhedron_generator", { inputs: { coordination: [coordination] } })),
    ).toEqual(["Coordination has no hull with at least four neighbor sites"]);
  });

  it("load_spectrum / spectrum_plot / load_volumetric warn when empty", () => {
    expect(messages(run("load_spectrum"))).toEqual(["No spectrum loaded"]);
    const plot = run("spectrum_plot");
    expect(messages(plot)).toEqual(["No spectrum input"]);
    expect(plot.result.outputs!.size).toBe(0);
    expect(messages(run("load_volumetric"))).toEqual(["No volumetric data loaded"]);
  });

  it("isosurface warns on a missing volume and on an unwired color volume", () => {
    expect(messages(run("isosurface"))).toEqual(["No volumetric input"]);
    expect(messages(run("isosurface", { params: { colorMode: "volume" } }))).toEqual([
      "No volumetric input",
      "Color by volume needs a volume connected to the Color Volume input",
    ]);
  });
});
