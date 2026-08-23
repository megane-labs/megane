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

export function executeLoadStructure(
  params: LoadStructureParams,
  snapshot: Snapshot | null,
  structureFrames: Frame[] | null,
  structureMeta: TrajectoryMeta | null,
  sourceNodeId: string,
  structureProvider: FrameProvider | null = null,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  if (!snapshot) return outputs;

  const particle: ParticleData = {
    type: "particle",
    source: snapshot,
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
  if (snapshot.box) {
    const cell: CellData = {
      type: "cell",
      sourceNodeId,
      box: snapshot.box,
    };
    outputs.set("cell", cell);
  }

  return outputs;
}
