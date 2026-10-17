/**
 * Shared shell for all pipeline node components.
 *
 * A node component renders its parameter form as the shell's children. Where
 * the component is mounted decides what the shell draws:
 *
 * - inside the editor graph (`NodeShellModeContext` = "card") it draws the
 *   compact `NodeCard` — category icon, title, one-line summary and typed
 *   handles — and drops the form;
 * - anywhere else ("properties", the default) it draws only the form. The
 *   editor's properties pane mounts every node this way and shows the
 *   selected one.
 */

import { createContext, useContext } from "react";
import type { PipelineNodeType } from "../../pipeline/types";
import { NodeCard } from "./NodeCard";

interface NodeShellProps {
  id: string;
  nodeType: PipelineNodeType;
  enabled: boolean;
  children: React.ReactNode;
  /** Port names that should be visually disabled (no data on them). */
  disabledPorts?: Set<string>;
}

export type NodeShellMode = "card" | "properties";
export const NodeShellModeContext = createContext<NodeShellMode>("properties");

export function NodeShell({ id, nodeType, enabled, children, disabledPorts }: NodeShellProps) {
  const mode = useContext(NodeShellModeContext);
  if (mode === "card") {
    return <NodeCard id={id} nodeType={nodeType} enabled={enabled} disabledPorts={disabledPorts} />;
  }
  return (
    <div data-testid="pipeline-properties-form" data-node-id={id}>
      {children}
    </div>
  );
}
