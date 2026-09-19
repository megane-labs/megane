import type { Snapshot, Frame, TrajectoryMeta } from "../../types";
import type {
  PipelineData,
  ParticleData,
  CellData,
  TrajectoryData,
  LoadStructureParams,
  FrameProvider,
} from "../types";
import { MemoryFrameProvider } from "../types";
import { applyEditOps } from "./edit";

/**
 * Trajectory carried by the structure file itself (multi-frame XYZ/PDB/.traj).
 * A pre-built provider (lazy/streaming) takes precedence over eager frames;
 * its frame 0 is the eager snapshot (basePositions baked into the provider),
 * matching the MemoryFrameProvider convention. Shared with the
 * `load_trajectory` executor's `source: "structure"` mode so both nodes
 * forward identical frames.
 */
export function buildStructureTrajectory(
  snapshot: Snapshot,
  structureFrames: Frame[] | null,
  structureMeta: TrajectoryMeta | null,
  structureProvider: FrameProvider | null,
): TrajectoryData | null {
  if (structureProvider) {
    return {
      type: "trajectory",
      provider: structureProvider,
      meta: structureProvider.meta,
      source: "structure",
    };
  }
  if (structureFrames && structureFrames.length > 0 && structureMeta) {
    const provider = new MemoryFrameProvider(structureFrames, structureMeta, snapshot.positions);
    return {
      type: "trajectory",
      provider,
      meta: structureMeta,
      source: "structure",
    };
  }
  return null;
}

/**
 * Loader executor. `params.edits` (an edit history in megane Builder's format) is replayed on
 * the loaded snapshot so the `particle` / `cell` outputs carry the *edited*
 * structure; `opts.editsBypassed` shows the file as loaded instead (a "show
 * original" preview). Per-op problems go to `opts.warnings` so the
 * dispatcher can surface them on the node. The trajectory output always
 * follows the file: its frames index the atoms as loaded, so an edited atom
 * count could not be played back anyway.
 */
export function executeLoadStructure(
  params: LoadStructureParams,
  snapshot: Snapshot | null,
  structureFrames: Frame[] | null,
  structureMeta: TrajectoryMeta | null,
  sourceNodeId: string,
  structureProvider: FrameProvider | null = null,
  opts: { editsBypassed?: boolean; warnings?: string[] } = {},
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  if (!snapshot) return outputs;

  const edits = Array.isArray(params.edits) ? params.edits : [];
  let shown = snapshot;
  if (edits.length > 0 && !opts.editsBypassed) {
    const result = applyEditOps(snapshot, edits);
    shown = result.snapshot;
    opts.warnings?.push(...result.warnings);
  }

  const particle: ParticleData = {
    type: "particle",
    source: shown,
    sourceNodeId,
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
  };
  outputs.set("particle", particle);

  const trajectory = buildStructureTrajectory(
    snapshot,
    structureFrames,
    structureMeta,
    structureProvider,
  );
  if (trajectory) {
    outputs.set("trajectory", trajectory);
  }

  // Cell data carries geometry only; whether the cell (and its axes) are
  // drawn is a Viewport/appearance decision, not loader output.
  if (shown.box) {
    const cell: CellData = {
      type: "cell",
      sourceNodeId,
      box: shown.box,
    };
    outputs.set("cell", cell);
  }

  return outputs;
}
