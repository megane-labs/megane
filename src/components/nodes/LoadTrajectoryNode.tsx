/**
 * Load Trajectory node.
 * Loads an external trajectory file (e.g. XTC).
 * Requires particle input (for nAtoms validation).
 * Outputs: trajectory.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LoadTrajectoryParams } from "../../pipeline/types";
import { useScopedPipelineStore, useLoadHandlers } from "../../stores/MeganeProvider";
import { globalLoadHandlers, type TrajectoryLoadHandler } from "../../stores/loadHandlers";
import { NodeShell } from "./NodeShell";
import { smallBtnStyle, fileNameStyle } from "../ui";
import { useRef, useCallback } from "react";

const TRAJECTORY_ACCEPT = ".xtc,.lammpstrj,.dump,.trj,.dcd,.nc";
const TRAJECTORY_EXTS = [".xtc", ".lammpstrj", ".dump", ".trj", ".dcd", ".nc"];

/**
 * Event bus for trajectory loading.
 * MeganeViewer listens for these events to trigger actual file parsing.
 */
export type { TrajectoryLoadHandler };

/**
 * Legacy module-global registration, kept so provider-less hosts and any
 * existing embedder keep working. It writes the process-global slots; a
 * viewer inside a <MeganeProvider> uses that provider's own slots instead.
 */
export function setTrajectoryLoadHandler(handler: TrajectoryLoadHandler | null) {
  globalLoadHandlers.setTrajectory(handler);
}

export function LoadTrajectoryNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const loadHandlers = useLoadHandlers();
  const params = data.params as LoadTrajectoryParams;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      const lower = file.name.toLowerCase();
      if (!TRAJECTORY_EXTS.some((ext) => lower.endsWith(ext))) return;
      updateNodeParams(id, { fileName: file.name, source: "file" });
      loadHandlers.trajectory?.(file);
    },
    [id, updateNodeParams, loadHandlers],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const match = files.find((f) =>
        TRAJECTORY_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
      );
      if (match) handleFile(match);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <NodeShell id={id} nodeType="load_trajectory" enabled={data.enabled}>
      <div onDrop={handleDrop} onDragOver={handleDragOver}>
        {params.source === "structure" ? (
          // The frames come from the structure file itself (multi-frame
          // XYZ/PDB/.traj). Shown here — instead of removing the node — so
          // the routing decision stays visible; loading a trajectory file
          // switches back to it.
          <div data-testid="load-trajectory-filename" style={fileNameStyle}>
            Frames from structure file
          </div>
        ) : params.fileName ? (
          <div data-testid="load-trajectory-filename" style={fileNameStyle}>
            {params.fileName}
          </div>
        ) : (
          <div
            data-testid="load-trajectory-filename"
            style={{ fontSize: 20, color: "#94a3b8", fontStyle: "italic" }}
          >
            No trajectory loaded
          </div>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          style={{ ...smallBtnStyle, marginTop: 6, width: "100%" }}
        >
          Load trajectory...
        </button>
        <input
          ref={inputRef}
          data-testid="load-trajectory-input"
          type="file"
          accept={TRAJECTORY_ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
          style={{ display: "none" }}
        />
      </div>
    </NodeShell>
  );
}
