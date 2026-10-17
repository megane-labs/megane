/**
 * Load Structure node.
 * Source node in the pipeline — file upload only, no bond selection.
 * Outputs: particle, trajectory (if present), cell (if present).
 * Ports without data are grayed out.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LoadStructureParams } from "../../pipeline/types";
import { useScopedPipelineStore, useLoadHandlers } from "../../stores/MeganeProvider";
import { globalLoadHandlers, type StructureLoadHandler } from "../../stores/loadHandlers";
import { NodeShell } from "./NodeShell";
import { FileDrop } from "./form";
import { fileMetaStyle } from "./formStyles";
import { useRef, useCallback } from "react";
// The file-dialog filter can only express extensions, so VASP contributes
// `.vasp` there. Its extensionless spellings (POSCAR / CONTCAR / XDATCAR) are
// still accepted on drag-drop via `matchesStructureName`.
import { matchesStructureName, STRUCTURE_ACCEPT, STRUCTURE_EXTS } from "../../parsers/fileNames";

/**
 * Event bus for structure loading.
 * MeganeViewer listens for these events to trigger actual file parsing.
 */
export type { StructureLoadHandler };

/**
 * Legacy module-global registration, kept so provider-less hosts and any
 * existing embedder keep working. It writes the process-global slots; a
 * viewer inside a <MeganeProvider> uses that provider's own slots instead.
 */
export function setStructureLoadHandler(handler: StructureLoadHandler | null) {
  globalLoadHandlers.setStructure(handler);
}

export function LoadStructureNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const loadHandlers = useLoadHandlers();
  const params = data.params as LoadStructureParams;
  const inputRef = useRef<HTMLInputElement>(null);
  const editCount = Array.isArray(params.edits) ? params.edits.length : 0;

  const handleFile = useCallback(
    (file: File) => {
      if (!matchesStructureName(file.name, STRUCTURE_EXTS)) return;
      updateNodeParams(id, { fileName: file.name });
      loadHandlers.structure?.(id, file);
    },
    [id, updateNodeParams, loadHandlers],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const match = files.find((f) => matchesStructureName(f.name, STRUCTURE_EXTS));
      if (match) handleFile(match);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Determine which output ports are disabled (no data available)
  const disabledPorts = new Set<string>();
  if (!params.hasTrajectory) disabledPorts.add("trajectory");
  if (!params.hasCell) disabledPorts.add("cell");

  return (
    <NodeShell
      id={id}
      nodeType="load_structure"
      enabled={data.enabled}
      disabledPorts={disabledPorts}
    >
      <FileDrop
        fileName={params.fileName}
        emptyText="No structure loaded"
        buttonLabel="Load structure..."
        nameTestId="load-structure-filename"
        onPick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        fileInput={
          <input
            ref={inputRef}
            data-testid="load-structure-input"
            type="file"
            accept={STRUCTURE_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
        }
      >
        {/* An edit history (from the Builder, the chat, or a builder script)
            rides on this node: it edits the input, not the view, so the graph
            shows only a count. */}
        {editCount > 0 && (
          <div
            data-testid="load-structure-edits"
            style={{ ...fileMetaStyle, color: "var(--megane-success-text)" }}
          >
            {editCount} edit{editCount === 1 ? "" : "s"}
          </div>
        )}
      </FileDrop>
    </NodeShell>
  );
}
