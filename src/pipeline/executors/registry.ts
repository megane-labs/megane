/**
 * Node executor registry.
 *
 * `executePipeline()` (src/pipeline/execute.ts) walks the graph in topological
 * order and, for every enabled node, looks its type up here. Each entry adapts
 * one node type: it pulls the node's typed params and inputs out of the shared
 * {@link NodeExecutorContext}, calls the pure executor from this directory,
 * records the node's warnings through `addError`, and returns the outputs that
 * flow onward along the node's edges (or, for the Viewport node, the assembled
 * `ViewportState`).
 *
 * The table is typed as {@link NodeExecutorRegistry} — a mapped type over every
 * `PipelineNodeType` — so `tsc` refuses to build until a new node type has an
 * entry, the same compile-time guardrail `NODE_PORTS` / `NODE_TYPE_LABELS` use.
 */

import type { Node } from "@xyflow/react";
import type {
  FrameProvider,
  NodeError,
  ParticleData,
  PipelineData,
  PipelineNodeParams,
  PipelineNodeType,
  ViewportState,
} from "../types";
import type { Frame, Snapshot, TrajectoryMeta } from "../../types";
import type { PipelineExecutionContext, PipelineNodeData } from "../execute";
import { executeStreaming } from "./streaming";
import { executeLoadStructure } from "./loadStructure";
import { executeLoadTrajectory } from "./loadTrajectory";
import { executeAddBond } from "./addBond";
import { executeFilter } from "./filter";
import { executeModify } from "./modify";
import { executeSymmetry } from "./symmetry";
import { executeWrap } from "./wrap";
import { executeReplicate } from "./replicate";
import { executeDrawingBoundary } from "./drawingBoundary";
import { executeBoundaryCompletion } from "./boundaryCompletion";
import { executeCoordinationGenerator } from "./coordinationGenerator";
import { executeColor } from "./color";
import { executeRepresentation } from "./representation";
import { executeLabelGenerator } from "./labelGenerator";
import { executePolyhedronGenerator } from "./polyhedronGenerator";
import { executeSurfaceMesh } from "./surfaceMesh";
import { executeLoadVector } from "./loadVector";
import { executeVectorOverlay } from "./vectorOverlay";
import { executeLoadVolumetric } from "./loadVolumetric";
import { executeLoadSpectrum, selectPlottedSpectrum } from "./spectrum";
import { executeIsosurface } from "./isosurface";
import { executeViewport } from "./viewport";

/** The params interface whose `type` discriminant is `T`. */
export type NodeParamsOf<T extends PipelineNodeType> = Extract<PipelineNodeParams, { type: T }>;

/** Everything a node executor may read while one node runs. */
export interface NodeExecutorContext<T extends PipelineNodeType = PipelineNodeType> {
  /** Id of the node being executed. */
  id: string;
  /** The node's params, narrowed to its type. */
  params: NodeParamsOf<T>;
  /** Upstream data per input port (`collectInputs()` output). */
  inputs: Map<string, PipelineData[]>;
  /** Every node in the graph (Load Trajectory's "structure" mode finds the loader). */
  nodes: Node<PipelineNodeData>[];
  /** The caller-supplied execution context (snapshots, frames, providers, …). */
  ctx: PipelineExecutionContext;
  /** Record a warning/error against this node. */
  addError: (error: NodeError) => void;
}

/**
 * What a node produced. `outputs` becomes the node's entry in the edge-output
 * map; when it is absent the node publishes nothing (Viewport). `viewportState`
 * replaces the pipeline's resulting `ViewportState`.
 */
export interface NodeExecutorResult {
  outputs?: Map<string, PipelineData>;
  viewportState?: ViewportState;
}

export type NodeExecutor<T extends PipelineNodeType = PipelineNodeType> = (
  c: NodeExecutorContext<T>,
) => NodeExecutorResult;

/** One executor per node type; a missing entry is a compile error. */
export type NodeExecutorRegistry = { readonly [T in PipelineNodeType]: NodeExecutor<T> };

/** The shared "nothing is wired into this node" warning (a fresh object per call). */
function noInput(): NodeError {
  return { message: "No input data (check upstream nodes)", severity: "warning" };
}

/**
 * Resolve the atom labels used for selection / coloring / text labels (e.g.
 * `resname == "HOH"`, color-by-residue, Label Generator's "resname" source).
 * The user-selected *display* label source wins when set (`ctx.atomLabels`);
 * otherwise we use the residue labels parsed from the structure file, which
 * the load_structure node attached to the stream's snapshot
 * (`Snapshot.atomLabels`).
 *
 * This keeps `resname` selections and residue coloring working out of the box
 * without forcing the user to switch the display label source — and without
 * turning on on-screen atom text labels, which are driven by a separate path
 * (the label_generator node / `LabelData`), not by these labels.
 *
 * Reading them off the stream's own snapshot means multi-loader graphs each
 * resolve to their own structure's labels, and labels stay aligned with the
 * atoms after Replicate, Symmetry and structure edits copy or reorder them.
 */
export function resolveEffectiveLabels(
  ctx: PipelineExecutionContext,
  particle: ParticleData | undefined,
): string[] | null {
  if (ctx.atomLabels) return ctx.atomLabels;
  return particle?.source.atomLabels ?? null;
}

/** The particle stream on a node's `in` port, if that is what is wired in. */
export function inputParticle(inputs: Map<string, PipelineData[]>): ParticleData | undefined {
  const inData = inputs.get("in")?.[0];
  return inData?.type === "particle" ? (inData as ParticleData) : undefined;
}

/** Structure channels a load_structure node resolves for itself. */
interface StructureSource {
  snapshot: Snapshot | null;
  frames: Frame[] | null;
  meta: TrajectoryMeta | null;
  provider: FrameProvider | null;
  /** The file's residue labels, when the node has its own parse. */
  labels: string[] | null;
}

/** The graph's primary loader: the first load_structure node. */
function primaryLoaderId(nodes: readonly Node<PipelineNodeData>[]): string | undefined {
  return nodes.find((n) => n.data.params.type === "load_structure")?.id;
}

/**
 * Per-node snapshot takes priority; fall back to the global snapshot for
 * backward compat. A lazy structure provider applies only when the node has no
 * eager frames of its own (mirrors executeLoadTrajectory's provider precedence).
 *
 * The global structure-frame channels (eager frames, lazy provider) belong to
 * the primary loader, the only one `applyStructureToPipeline` gives them to. A
 * second loader that holds a structure of its own without frames must not
 * play the primary's; one with no data at all still falls back to every
 * global channel, as before.
 */
function resolveStructureSource(
  ctx: PipelineExecutionContext,
  loaderId: string | undefined,
  nodes: readonly Node<PipelineNodeData>[],
): StructureSource {
  const nodeData = loaderId ? ctx.nodeSnapshots?.[loaderId] : undefined;
  const primary = primaryLoaderId(nodes);
  const ownsGlobalFrames = !nodeData || primary === undefined || primary === loaderId;
  return {
    snapshot: nodeData?.snapshot ?? ctx.snapshot ?? null,
    frames: nodeData?.frames ?? (ownsGlobalFrames ? (ctx.structureFrames ?? null) : null),
    meta: nodeData?.meta ?? (ownsGlobalFrames ? (ctx.structureMeta ?? null) : null),
    provider: nodeData?.frames || !ownsGlobalFrames ? null : (ctx.structureProvider ?? null),
    labels: nodeData?.labels ?? null,
  };
}

export const NODE_EXECUTORS: NodeExecutorRegistry = {
  load_structure: ({ id, params, nodes, ctx, addError }) => {
    const { snapshot, frames, meta, provider, labels } = resolveStructureSource(ctx, id, nodes);
    const editWarnings: string[] = [];
    const outputs = executeLoadStructure(params, snapshot, frames, meta, id, provider, {
      editsBypassed: ctx.editsBypassed,
      warnings: editWarnings,
      labels,
    });
    if (!snapshot) {
      addError({ message: "No structure data available", severity: "warning" });
    }
    for (const message of editWarnings) {
      addError({ message, severity: "warning" });
    }
    return { outputs };
  },

  load_vector: ({ params, ctx }) => ({
    outputs: executeLoadVector(params, ctx.fileVectors ?? null),
  }),

  load_trajectory: ({ params, inputs, nodes, ctx }) => {
    // "structure" mode forwards the structure file's own frames; resolve
    // them exactly like load_structure does, for the loader wired to this
    // node's particle input (the graph's first loader when nothing is wired).
    let structureSource: StructureSource | null = null;
    if (params.source === "structure") {
      const wiredId = (inputs.get("particle")?.[0] as ParticleData | undefined)?.sourceNodeId;
      const isLoader = (n: Node<PipelineNodeData>) => n.data.params.type === "load_structure";
      const loader =
        nodes.find((n) => n.id === wiredId && isLoader(n)) ?? nodes.find((n) => isLoader(n));
      structureSource = resolveStructureSource(ctx, loader?.id, nodes);
    }
    const outputs = executeLoadTrajectory(
      params,
      inputs,
      ctx.fileFrames ?? null,
      ctx.fileMeta ?? null,
      ctx.fileProvider ?? null,
      structureSource,
    );
    return { outputs };
  },

  streaming: ({ id, ctx, addError }) => {
    const streamingData = ctx.nodeStreamingData?.[id];
    const outputs = executeStreaming(id, streamingData);
    if (!streamingData?.snapshot) {
      addError({ message: "No streaming data available", severity: "warning" });
    }
    return { outputs };
  },

  add_bond: ({ params, inputs, addError }) => {
    const outputs = executeAddBond(params, inputs);
    const bondInput = inputs.get("particle")?.[0] as ParticleData | undefined;
    // An atom-less structure (an empty cell to build into) has no bonds to
    // find; warning about it would only flag the starting point as broken.
    if (bondInput && bondInput.source.nAtoms > 0 && !outputs.has("bond")) {
      addError({ message: "No bonds found", severity: "warning" });
    } else if (!bondInput) {
      addError(noInput());
    }
    return { outputs };
  },

  coordination_generator: ({ params, inputs, addError }) => {
    const outputs = executeCoordinationGenerator(params, inputs);
    if (!inputs.get("particle")?.length) {
      addError(noInput());
    } else if (!outputs.has("coordination")) {
      addError({ message: "No coordination pairs found", severity: "warning" });
    }
    return { outputs };
  },

  boundary_completion: ({ params, inputs, addError }) => {
    const outputs = executeBoundaryCompletion(params, inputs);
    if (!inputs.get("particle")?.length || !inputs.get("bond")?.length) {
      addError({ message: "Particle and bond inputs are both required", severity: "warning" });
    }
    return { outputs };
  },

  filter: ({ params, inputs, ctx, addError }) => {
    const labels = resolveEffectiveLabels(ctx, inputParticle(inputs));
    const outputs = executeFilter(params, inputs, labels);
    const outData = outputs.get("out");
    if (!inputs.get("in")?.length) {
      addError(noInput());
    } else if (outData && outData.type === "particle") {
      const particle = outData as ParticleData;
      if (particle.indices !== null && particle.indices.length === 0) {
        addError({ message: "Filter returned 0 atoms", severity: "warning" });
      }
    }
    return { outputs };
  },

  modify: ({ params, inputs, addError }) => {
    const outputs = executeModify(params, inputs);
    if (!inputs.get("in")?.length) addError(noInput());
    return { outputs };
  },

  symmetry: ({ params, inputs, addError }) => {
    const outputs = executeSymmetry(params, inputs);
    const particleIn = inputs.get("particle")?.[0] as ParticleData | undefined;
    const hasOps = (particleIn?.source.symmetryOps?.length ?? 0) > 0;
    if (!particleIn) {
      addError(noInput());
    } else if (params.mode === "expand" && hasOps && !particleIn.source.box) {
      addError({ message: "Symmetry expansion requires a unit cell", severity: "warning" });
    } else if (params.mode === "expand" && hasOps && inputs.get("trajectory")?.length) {
      addError({
        message: "Symmetry expansion skipped: trajectory input present",
        severity: "warning",
      });
    }
    return { outputs };
  },

  wrap: ({ params, inputs, addError }) => {
    const outputs = executeWrap(params, inputs);
    const particleIn = inputs.get("particle")?.[0] as ParticleData | undefined;
    if (!particleIn) {
      addError(noInput());
    } else if (params.mode !== "none" && !particleIn.source.box) {
      addError({ message: "Wrap / Unwrap requires a unit cell", severity: "warning" });
    }
    return { outputs };
  },

  replicate: ({ params, inputs, addError }) => {
    const outputs = executeReplicate(params, inputs);
    const particleIn = inputs.get("particle")?.[0] as ParticleData | undefined;
    const counts = [params.nx, params.ny, params.nz];
    const wantsReplication = counts.some((n) => Math.floor(n) > 1);
    if (!particleIn) {
      addError(noInput());
    } else if (wantsReplication && !particleIn.source.box) {
      addError({ message: "Replicate requires a unit cell", severity: "warning" });
    }
    return { outputs };
  },

  drawing_boundary: ({ params, inputs, addError }) => {
    const outputs = executeDrawingBoundary(params, inputs);
    const particle = inputs.get("particle")?.[0] as ParticleData | undefined;
    if (!particle) {
      addError(noInput());
    } else if (!particle.source.box) {
      addError({ message: "Drawing Boundary requires a unit cell", severity: "warning" });
    }
    return { outputs };
  },

  color: ({ params, inputs, ctx, addError }) => {
    const labels = resolveEffectiveLabels(ctx, inputParticle(inputs));
    const outputs = executeColor(params, inputs, labels);
    if (!inputs.get("in")?.length) addError(noInput());
    return { outputs };
  },

  representation: ({ params, inputs, addError }) => {
    const outputs = executeRepresentation(params, inputs);
    if (!inputs.get("in")?.length) addError(noInput());
    return { outputs };
  },

  label_generator: ({ params, inputs, ctx, addError }) => {
    // Same label resolution as Filter / Color, read off the `particle` port.
    const particle = inputs.get("particle")?.[0] as ParticleData | undefined;
    const labels = resolveEffectiveLabels(ctx, particle);
    const outputs = executeLabelGenerator(params, inputs, labels);
    if (!inputs.get("particle")?.length) addError(noInput());
    return { outputs };
  },

  polyhedron_generator: ({ params, inputs, addError }) => {
    const outputs = executePolyhedronGenerator(params, inputs);
    if (!inputs.get("coordination")?.length) {
      addError(noInput());
    } else if (!outputs.has("mesh")) {
      addError({
        message: "Coordination has no hull with at least four neighbor sites",
        severity: "warning",
      });
    }
    return { outputs };
  },

  surface_mesh: ({ params, inputs, addError }) => {
    const outputs = executeSurfaceMesh(params, inputs);
    if (!inputs.get("particle")?.length) addError(noInput());
    return { outputs };
  },

  vector_overlay: ({ params, inputs, addError }) => {
    const outputs = executeVectorOverlay(params, inputs);
    if (!inputs.get("vector")?.length) addError(noInput());
    return { outputs };
  },

  load_spectrum: ({ params, addError }) => {
    const outputs = executeLoadSpectrum(params);
    if (!outputs.has("spectrum")) {
      addError({ message: "No spectrum loaded", severity: "warning" });
    }
    return { outputs };
  },

  spectrum_plot: ({ inputs, addError }) => {
    // Terminal: a spectrum has no geometry, so nothing flows onward. The
    // node component draws the chart from its own resolved input.
    if (!selectPlottedSpectrum(inputs)) {
      addError({ message: "No spectrum input", severity: "warning" });
    }
    return { outputs: new Map() };
  },

  load_volumetric: ({ params, addError }) => {
    const outputs = executeLoadVolumetric(params);
    if (!outputs.has("volumetric")) {
      addError({ message: "No volumetric data loaded", severity: "warning" });
    }
    return { outputs };
  },

  isosurface: ({ params, inputs, addError }) => {
    const outputs = executeIsosurface(params, inputs);
    if (!inputs.get("volumetric")?.length) {
      addError({ message: "No volumetric input", severity: "warning" });
    }
    if (params.colorMode === "volume" && !inputs.get("colorVolumetric")?.length) {
      addError({
        message: "Color by volume needs a volume connected to the Color Volume input",
        severity: "warning",
      });
    }
    return { outputs };
  },

  // The Viewport node publishes no edge outputs; it yields the ViewportState.
  viewport: ({ params, inputs }) => ({ viewportState: executeViewport(params, inputs) }),
};

/**
 * Look up the executor for a node type, or `undefined` when the type is not a
 * known `PipelineNodeType` (e.g. a stale type in hand-edited JSON). Only own
 * keys count, so `"toString"` / `"__proto__"` never resolve to a prototype member.
 */
export function getNodeExecutor(type: string): NodeExecutor | undefined {
  return Object.prototype.hasOwnProperty.call(NODE_EXECUTORS, type)
    ? (NODE_EXECUTORS[type as PipelineNodeType] as NodeExecutor)
    : undefined;
}
