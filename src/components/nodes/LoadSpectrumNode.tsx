/**
 * Load Spectrum node.
 * Source node — decodes a JCAMP-DX file (.jdx / .jcamp) into SpectrumData.
 */

import { useCallback, useRef } from "react";
import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LoadSpectrumParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { FileDrop } from "./form";
import { errorTextStyle, fileMetaStyle } from "./formStyles";
import { SPECTRUM_ACCEPT, isSpectrumFileName, parseSpectrum } from "../../parsers/spectrum";

export function LoadSpectrumNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as LoadSpectrumParams;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!isSpectrumFileName(file.name)) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = e.target?.result as string;
        try {
          const spectrum = await parseSpectrum(text);
          updateNodeParams(id, {
            fileName: file.name,
            spectrumData: spectrum,
            parseError: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("Failed to parse spectrum file:", err);
          updateNodeParams(id, {
            fileName: file.name,
            spectrumData: null,
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
      const match = Array.from(e.dataTransfer.files).find((f) => isSpectrumFileName(f.name));
      if (match) handleFile(match);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const spectrum = params.spectrumData;

  return (
    <NodeShell id={id} nodeType="load_spectrum" enabled={data.enabled}>
      <FileDrop
        testId="load-spectrum-dropzone"
        fileName={params.fileName}
        emptyText="No spectrum loaded"
        buttonLabel="Load spectrum..."
        nameTestId="load-spectrum-filename"
        onPick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        fileInput={
          <input
            ref={inputRef}
            data-testid="load-spectrum-input"
            type="file"
            accept={SPECTRUM_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
        }
      >
        {params.fileName && !spectrum && (
          <div data-testid="load-spectrum-error" style={errorTextStyle}>
            {params.parseError ?? "Parse error — check file format"}
          </div>
        )}
        {spectrum && (
          <div data-testid="load-spectrum-summary" style={fileMetaStyle}>
            {spectrum.dataType || "spectrum"} · {spectrum.x.length} points
            {spectrum.xUnits ? ` · ${spectrum.xUnits}` : ""}
          </div>
        )}
      </FileDrop>
    </NodeShell>
  );
}
