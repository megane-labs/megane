/**
 * Load Vector node.
 * Loads an external vector file (.vec JSON Lines format).
 * Outputs: vector.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LoadVectorParams } from "../../pipeline/types";
import { useScopedPipelineStore, useLoadHandlers } from "../../stores/MeganeProvider";
import { globalLoadHandlers, type VectorLoadHandler } from "../../stores/loadHandlers";
import { NodeShell } from "./NodeShell";
import { Field, FileDrop, FormStack } from "./form";
import { selectStyle } from "./formStyles";
import { useRef, useCallback } from "react";

const VECTOR_ACCEPT = ".vec";
const VECTOR_EXTS = [".vec"];

/**
 * Event bus for vector loading.
 * MeganeViewer listens for these events to trigger actual file parsing.
 */
export type { VectorLoadHandler };

/**
 * Legacy module-global registration, kept so provider-less hosts and any
 * existing embedder keep working. It writes the process-global slots; a
 * viewer inside a <MeganeProvider> uses that provider's own slots instead.
 */
export function setVectorLoadHandler(handler: VectorLoadHandler | null) {
  globalLoadHandlers.setVector(handler);
}

export function LoadVectorNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const loadHandlers = useLoadHandlers();
  const embeddedChannels = useScopedPipelineStore((s) => s.embeddedVectorChannels);
  const activeEmbedded = useScopedPipelineStore((s) => s.activeEmbeddedVectorChannel);
  const activateEmbeddedVectorChannel = useScopedPipelineStore(
    (s) => s.activateEmbeddedVectorChannel,
  );
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
      loadHandlers.vector?.(file);
    },
    [id, updateNodeParams, loadHandlers],
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
      <FormStack>
        <FileDrop
          fileName={params.fileName}
          emptyText="No vector file loaded"
          buttonLabel="Load vectors..."
          onPick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          fileInput={
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
          }
        />
        {embeddedChannels && embeddedChannels.length > 0 && (
          <Field label="Embedded">
            <select
              aria-label="Embedded vector channel"
              value={activeEmbedded ?? ""}
              onChange={(e) => handleEmbeddedSelect(e.target.value)}
              style={selectStyle}
            >
              <option value="">Embedded channel: off</option>
              {embeddedChannels.map((ch) => (
                <option key={ch.name} value={ch.name}>
                  {ch.name} ({ch.frames.length} frame{ch.frames.length === 1 ? "" : "s"})
                </option>
              ))}
            </select>
          </Field>
        )}
      </FormStack>
    </NodeShell>
  );
}
