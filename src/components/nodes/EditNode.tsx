/**
 * Edit node — the serializable record of the structure edits made in the
 * Build panel. The node body summarizes the op list (counts per kind), lets
 * the user undo the last op or clear the history, and links to the Build tab
 * where the actual clicking happens.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { EditOp, EditParams } from "../../pipeline/types";
import { useScopedPipelineStore, useScopedPipelineUIStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 17,
  fontWeight: 500,
  color: "#64748b",
  padding: "3px 0",
};

const buttonStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#334155",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  padding: "3px 8px",
  cursor: "pointer",
};

const OP_LABELS: Record<EditOp["op"], string> = {
  add_atom: "add atom",
  delete_atoms: "delete",
  move_atoms: "move",
  set_element: "element",
  add_bond: "add bond",
  delete_bond: "delete bond",
  add_fragment: "fragment",
  set_cell: "cell",
};

/** Human summary of an op list, e.g. `3 add atom · 1 delete`. */
export function summarizeEditOps(ops: EditOp[]): string {
  if (ops.length === 0) return "No edits";
  const counts = new Map<string, number>();
  for (const op of ops) {
    const label = OP_LABELS[op.op] ?? String(op.op);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(" · ");
}

export function EditNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const setBuildOpen = useScopedPipelineUIStore((s) => s.setBuildOpen);
  const params = data.params as EditParams;
  const ops = Array.isArray(params.ops) ? params.ops : [];

  return (
    <NodeShell id={id} nodeType="edit" enabled={data.enabled}>
      <div style={rowStyle}>
        <span data-testid="edit-node-summary">{summarizeEditOps(ops)}</span>
        <span data-testid="edit-node-count">{ops.length} ops</span>
      </div>
      <div style={{ ...rowStyle, gap: 6, justifyContent: "flex-end" }}>
        <button
          type="button"
          className="nodrag"
          data-testid="edit-node-undo"
          style={buttonStyle}
          disabled={ops.length === 0}
          onClick={() => updateNodeParams(id, { ops: ops.slice(0, -1) })}
        >
          Undo last
        </button>
        <button
          type="button"
          className="nodrag"
          data-testid="edit-node-clear"
          style={buttonStyle}
          disabled={ops.length === 0}
          onClick={() => updateNodeParams(id, { ops: [] })}
        >
          Clear
        </button>
        <button
          type="button"
          className="nodrag"
          data-testid="edit-node-open-build"
          style={buttonStyle}
          onClick={() => setBuildOpen(true)}
        >
          Open Build
        </button>
      </div>
    </NodeShell>
  );
}
