import type { Frame, Snapshot, TrajectoryMeta } from "../../types";
import type { PipelineData, TrajectoryData, LoadTrajectoryParams, FrameProvider } from "../types";
import { MemoryFrameProvider } from "../types";
import { buildStructureTrajectory } from "./loadStructure";

/** Structure-file channels forwarded when `params.source === "structure"`. */
export interface StructureTrajectorySource {
  snapshot: Snapshot | null;
  frames: Frame[] | null;
  meta: TrajectoryMeta | null;
  provider: FrameProvider | null;
}

export function executeLoadTrajectory(
  params: LoadTrajectoryParams,
  _inputs: Map<string, PipelineData[]>,
  fileFrames: Frame[] | null,
  fileMeta: TrajectoryMeta | null,
  fileProvider: FrameProvider | null = null,
  structure: StructureTrajectorySource | null = null,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();

  // "structure" mode: the frames live in the structure file itself
  // (multi-frame XYZ/PDB/.traj). Forward them through the same builder the
  // load_structure executor uses, so both routes emit identical trajectories.
  if (params.source === "structure") {
    if (structure?.snapshot) {
      const trajectory = buildStructureTrajectory(
        structure.snapshot,
        structure.frames,
        structure.meta,
        structure.provider,
      );
      if (trajectory) {
        outputs.set("trajectory", trajectory);
      }
    }
    return outputs;
  }

  // A pre-built provider (lazy/streaming XTC) takes precedence over eager frames.
  if (fileProvider) {
    const trajectory: TrajectoryData = {
      type: "trajectory",
      provider: fileProvider,
      meta: fileProvider.meta,
      source: "file",
    };
    outputs.set("trajectory", trajectory);
  } else if (fileFrames && fileFrames.length > 0 && fileMeta) {
    const provider = new MemoryFrameProvider(fileFrames, fileMeta);
    const trajectory: TrajectoryData = {
      type: "trajectory",
      provider,
      meta: fileMeta,
      source: "file",
    };
    outputs.set("trajectory", trajectory);
  }

  return outputs;
}
