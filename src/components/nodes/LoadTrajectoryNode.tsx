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
import { FileDrop } from "./form";
import { errorTextStyle } from "./formStyles";
import { useRemoteFilePick } from "./useRemoteFilePick";
import { useRef, useCallback } from "react";
import { TRAJECTORY_ACCEPT, TRAJECTORY_EXTS } from "../../parsers/fileNames";

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

  const acceptName = useCallback(
    (name: string) => TRAJECTORY_EXTS.some((ext) => name.toLowerCase().endsWith(ext)),
    [],
  );

  const handleFile = useCallback(
    (file: File) => {
      if (!acceptName(file.name)) return;
      updateNodeParams(id, { fileName: file.name, source: "file" });
      loadHandlers.trajectory?.(file);
    },
    [id, updateNodeParams, loadHandlers, acceptName],
  );

  const remote = useRemoteFilePick({
    kind: "trajectory",
    extensions: TRAJECTORY_EXTS,
    accept: acceptName,
    title: "Open trajectory",
    onFile: handleFile,
  });

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const match = files.find((f) => acceptName(f.name));
      if (match) handleFile(match);
    },
    [handleFile, acceptName],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <NodeShell id={id} nodeType="load_trajectory" enabled={data.enabled}>
      <FileDrop
        // The frames come from the structure file itself (multi-frame
        // XYZ/PDB/.traj). Shown here — instead of removing the node — so the
        // routing decision stays visible; loading a trajectory file switches
        // back to it.
        fileName={params.source === "structure" ? "Frames from structure file" : params.fileName}
        emptyText="No trajectory loaded"
        buttonLabel="Load trajectory..."
        nameTestId="load-trajectory-filename"
        onPick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        remote={remote.button && { ...remote.button, testId: "load-trajectory-remote" }}
        fileInput={
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
        }
      >
        {remote.error && (
          <div data-testid="load-trajectory-remote-error" style={errorTextStyle}>
            {remote.error}
          </div>
        )}
        {remote.dialog}
      </FileDrop>
    </NodeShell>
  );
}
