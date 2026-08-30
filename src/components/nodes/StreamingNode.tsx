/**
 * Streaming node.
 * Source node for WebSocket-streamed molecular data.
 * Shows connection status. Outputs: particle, trajectory, cell.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { StreamingParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

export function StreamingNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const params = data.params as StreamingParams;
  const nodeStreamingData = useScopedPipelineStore((s) => s.nodeStreamingData[id]);

  const connected = params.connected;
  const hasSnapshot = !!nodeStreamingData?.snapshot;
  const hasTrajectory = !!nodeStreamingData?.streamProvider;
  const hasBond = !!nodeStreamingData?.snapshot?.nBonds;
  const hasCell = !!nodeStreamingData?.snapshot?.box;

  const disabledPorts = new Set<string>();
  if (!hasBond) disabledPorts.add("bond");
  if (!hasTrajectory) disabledPorts.add("trajectory");
  if (!hasCell) disabledPorts.add("cell");

  return (
    <NodeShell id={id} nodeType="streaming" enabled={data.enabled} disabledPorts={disabledPorts}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: connected ? "#22c55e" : "#ef4444",
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 19, fontWeight: 500, color: connected ? "#22c55e" : "#ef4444" }}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#94a3b8", fontStyle: "italic" }}>
          WebSocket: same origin /ws
        </div>
        {hasSnapshot && (
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
            {nodeStreamingData!.snapshot.nAtoms} atoms
            {hasBond && `, ${nodeStreamingData!.snapshot.nBonds} bonds`}
            {hasTrajectory && `, ${nodeStreamingData!.streamProvider!.meta.nFrames} frames`}
          </div>
        )}
      </div>
    </NodeShell>
  );
}
