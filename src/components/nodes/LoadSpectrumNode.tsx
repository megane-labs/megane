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
import { smallBtnStyle, fileNameStyle } from "../ui";
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
      <div data-testid="load-spectrum-dropzone" onDrop={handleDrop} onDragOver={handleDragOver}>
        {params.fileName ? (
          <div data-testid="load-spectrum-filename" style={fileNameStyle}>
            {params.fileName}
          </div>
        ) : (
          <div
            data-testid="load-spectrum-filename"
            style={{ fontSize: 20, color: "#94a3b8", fontStyle: "italic" }}
          >
            No spectrum loaded
          </div>
        )}
        {params.fileName && !spectrum && (
          <div
            data-testid="load-spectrum-error"
            style={{ fontSize: 14, color: "#ef4444", marginTop: 4 }}
          >
            {params.parseError ?? "Parse error — check file format"}
          </div>
        )}
        {spectrum && (
          <div
            data-testid="load-spectrum-summary"
            style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}
          >
            {spectrum.dataType || "spectrum"} · {spectrum.x.length} points
            {spectrum.xUnits ? ` · ${spectrum.xUnits}` : ""}
          </div>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          style={{ ...smallBtnStyle, marginTop: 6, width: "100%" }}
        >
          Load spectrum...
        </button>
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
      </div>
    </NodeShell>
  );
}
