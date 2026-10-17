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
import { FileDrop } from "./form";
import { errorTextStyle, fileMetaStyle } from "./formStyles";
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
      <FileDrop
        testId="load-volumetric-dropzone"
        fileName={params.fileName}
        emptyText="No volumetric file loaded"
        buttonLabel="Load volumetric file..."
        onPick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        fileInput={
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
        }
      >
        {params.fileName && !hasData && (
          <div data-testid="load-volumetric-error" style={errorTextStyle}>
            {params.parseError ?? "Parse error — check file format"}
          </div>
        )}
        {hasData && params.volumetricData && (
          <div style={fileMetaStyle}>
            {params.volumetricData.nx}×{params.volumetricData.ny}×{params.volumetricData.nz} voxels
          </div>
        )}
      </FileDrop>
    </NodeShell>
  );
}
