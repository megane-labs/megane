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
import { FormStack } from "./form";
import { fileMetaStyle, hintStyle } from "./formStyles";

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
      <FormStack>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: connected ? "#22c55e" : "#ef4444",
              boxShadow: connected
                ? "0 0 0 3px rgba(34, 197, 94, 0.18)"
                : "0 0 0 3px rgba(239, 68, 68, 0.18)",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: connected ? "var(--megane-success-text)" : "var(--megane-danger)",
            }}
          >
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <div style={hintStyle}>WebSocket: same origin /ws</div>
        {hasSnapshot && (
          <div style={fileMetaStyle}>
            {nodeStreamingData!.snapshot.nAtoms} atoms
            {hasBond && `, ${nodeStreamingData!.snapshot.nBonds} bonds`}
            {hasTrajectory && `, ${nodeStreamingData!.streamProvider!.meta.nFrames} frames`}
          </div>
        )}
      </FormStack>
    </NodeShell>
  );
}
