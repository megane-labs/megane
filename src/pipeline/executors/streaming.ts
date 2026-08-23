/**
 * Streaming node executor.
 * Source node for WebSocket-streamed molecular data.
 * Outputs particle, trajectory, and cell data from the streaming connection.
 */

import type { Snapshot } from "../../types";
import type {
  PipelineData,
  ParticleData,
  BondData,
  CellData,
  TrajectoryData,
  FrameProvider,
} from "../types";

export interface NodeStreamingData {
  snapshot: Snapshot;
  streamProvider: FrameProvider | null;
}

export function executeStreaming(
  nodeId: string,
  streamingData: NodeStreamingData | undefined,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  if (!streamingData) return outputs;

  const { snapshot, streamProvider } = streamingData;

  // Output particle data
  const particle: ParticleData = {
    type: "particle",
    source: snapshot,
    sourceNodeId: nodeId,
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
  };
  outputs.set("particle", particle);

  // Output bond data if bonds are available in the snapshot
  if (snapshot.nBonds > 0) {
    const bond: BondData = {
      type: "bond",
      sourceNodeId: nodeId,
      bondIndices: snapshot.bonds,
      bondOrders: snapshot.bondOrders,
      nBonds: snapshot.nBonds,
      scale: 1.0,
      opacity: 1.0,
      positions: null,
      elements: null,
      nAtoms: snapshot.nAtoms,
      atomElements: snapshot.elements,
      selectedBondIndices: null,
      bondOpacityOverrides: null,
    };
    outputs.set("bond", bond);
  }

  // Output trajectory data if stream provider is available
  if (streamProvider) {
    const trajectory: TrajectoryData = {
      type: "trajectory",
      provider: streamProvider,
      meta: streamProvider.meta,
      source: "stream",
    };
    outputs.set("trajectory", trajectory);
  }

  // Output cell data if box is available (geometry only; visibility is a
  // Viewport/appearance decision).
  if (snapshot.box) {
    const cell: CellData = {
      type: "cell",
      sourceNodeId: nodeId,
      box: snapshot.box,
    };
    outputs.set("cell", cell);
  }

  return outputs;
}
