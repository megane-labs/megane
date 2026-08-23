/**
 * Load Vector node.
 * Loads an external vector file (.vec JSON Lines format).
 * Outputs: vector.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LoadVectorParams } from "../../pipeline/types";
import { usePipelineStore } from "../../pipeline/store";
import { NodeShell } from "./NodeShell";
import { smallBtnStyle, fileNameStyle } from "../ui";
import { useRef, useCallback } from "react";

const VECTOR_ACCEPT = ".vec";
const VECTOR_EXTS = [".vec"];

/**
 * Event bus for vector loading.
 * MeganeViewer listens for these events to trigger actual file parsing.
 */
export type VectorLoadHandler = (file: File) => void;
let _onVectorLoad: VectorLoadHandler | null = null;
export function setVectorLoadHandler(handler: VectorLoadHandler | null) {
  _onVectorLoad = handler;
}

export function LoadVectorNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = usePipelineStore((s) => s.updateNodeParams);
  const embeddedChannels = usePipelineStore((s) => s.embeddedVectorChannels);
  const activeEmbedded = usePipelineStore((s) => s.activeEmbeddedVectorChannel);
  const activateEmbeddedVectorChannel = usePipelineStore((s) => s.activateEmbeddedVectorChannel);
  const params = data.params as LoadVectorParams;
  const inputRef = useRef<HTMLInputElement>(null);

  // Embedded channels are offered by the loaded structure/trajectory file;
  // nothing renders until the user picks one here.
  const handleEmbeddedSelect = useCallback(
    (name: string) => {
      if (name === "") {
        activateEmbeddedVectorChannel(null);
        updateNodeParams(id, { fileName: "" });
        return;
      }
      activateEmbeddedVectorChannel(name);
      updateNodeParams(id, { fileName: `[embedded] ${name}` });
    },
    [id, activateEmbeddedVectorChannel, updateNodeParams],
  );

  const handleFile = useCallback(
    (file: File) => {
      const lower = file.name.toLowerCase();
      if (!VECTOR_EXTS.some((ext) => lower.endsWith(ext))) return;
      updateNodeParams(id, { fileName: file.name });
      _onVectorLoad?.(file);
    },
    [id, updateNodeParams],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const match = files.find((f) =>
        VECTOR_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
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
    <NodeShell id={id} nodeType="load_vector" enabled={data.enabled}>
      <div onDrop={handleDrop} onDragOver={handleDragOver}>
        {params.fileName ? (
          <div style={fileNameStyle}>{params.fileName}</div>
        ) : (
          <div style={{ fontSize: 20, color: "#94a3b8", fontStyle: "italic" }}>
            No vector file loaded
          </div>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          style={{ ...smallBtnStyle, marginTop: 6, width: "100%" }}
        >
          Load vectors...
        </button>
        {embeddedChannels && embeddedChannels.length > 0 && (
          <select
            aria-label="Embedded vector channel"
            value={activeEmbedded ?? ""}
            onChange={(e) => handleEmbeddedSelect(e.target.value)}
            style={{ marginTop: 6, width: "100%", fontSize: 18 }}
          >
            <option value="">Embedded channel: off</option>
            {embeddedChannels.map((ch) => (
              <option key={ch.name} value={ch.name}>
                {ch.name} ({ch.frames.length} frame{ch.frames.length === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={VECTOR_ACCEPT}
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
