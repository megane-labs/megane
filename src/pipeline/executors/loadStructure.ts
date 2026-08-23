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

  // A pre-built provider (lazy/streaming multi-frame XYZ/PDB) takes precedence
  // over eager frames. Its frame 0 is the eager snapshot (basePositions baked
  // into the provider), matching the MemoryFrameProvider convention below.
  if (structureProvider) {
    const trajectory: TrajectoryData = {
      type: "trajectory",
      provider: structureProvider,
      meta: structureProvider.meta,
      source: "structure",
    };
    outputs.set("trajectory", trajectory);
  } else if (structureFrames && structureFrames.length > 0 && structureMeta) {
    const provider = new MemoryFrameProvider(structureFrames, structureMeta, snapshot.positions);
    const trajectory: TrajectoryData = {
      type: "trajectory",
      provider,
      meta: structureMeta,
      source: "structure",
    };
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
