/**
 * Load Volumetric node.
 * Loads a scalar grid (Gaussian CUBE or OpenDX) and outputs VolumetricData.
 */

import { useCallback, useRef } from "react";
import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LoadVolumetricParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { smallBtnStyle, fileNameStyle } from "../ui";
import {
  VOLUMETRIC_ACCEPT,
  isVolumetricFileName,
  parseVolumetric,
} from "../../pipeline/executors/parseVolumetric";

export function LoadVolumetricNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as LoadVolumetricParams;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!isVolumetricFileName(file.name)) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        try {
          const vol = parseVolumetric(file.name, text);
          updateNodeParams(id, { fileName: file.name, volumetricData: vol, parseError: null });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("Failed to parse volumetric file:", err);
          updateNodeParams(id, {
            fileName: file.name,
            volumetricData: null,
            parseError: message,
          });
        }
      };
      reader.readAsText(file);
    },
    [id, updateNodeParams],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const match = files.find((f) => isVolumetricFileName(f.name));
      if (match) handleFile(match);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const hasData = !!params.volumetricData;

  return (
    <NodeShell id={id} nodeType="load_volumetric" enabled={data.enabled}>
      <div data-testid="load-volumetric-dropzone" onDrop={handleDrop} onDragOver={handleDragOver}>
        {params.fileName ? (
          <div style={fileNameStyle}>{params.fileName}</div>
        ) : (
          <div style={{ fontSize: 20, color: "#94a3b8", fontStyle: "italic" }}>
            No volumetric file loaded
          </div>
        )}
        {params.fileName && !hasData && (
          <div
            data-testid="load-volumetric-error"
            style={{ fontSize: 14, color: "#ef4444", marginTop: 4 }}
          >
            {params.parseError ?? "Parse error — check file format"}
          </div>
        )}
        {hasData && params.volumetricData && (
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
            {params.volumetricData.nx}×{params.volumetricData.ny}×{params.volumetricData.nz} voxels
          </div>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          style={{ ...smallBtnStyle, marginTop: 6, width: "100%" }}
        >
          Load volumetric file...
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={VOLUMETRIC_ACCEPT}
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
