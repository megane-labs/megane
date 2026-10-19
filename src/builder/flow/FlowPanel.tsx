/**
 * The Flow panel: the graph of blocks on top, the picked block's settings
 * under it. It takes the place of the Details and History panels on the
 * right of the view while the Builder is in Flow mode.
 *
 * Loaded on demand (`React.lazy` in `BuilderApp`), so a Builder that never
 * leaves Manual mode does not load the graph editor.
 */

import { useCallback, useEffect } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import { useThemeStore } from "../../stores/useThemeStore";
import { useFlowStoreApi, useScopedFlowStore, useScopedToolsStore } from "../BuilderStores";
import { ToolServerDialog } from "../tools/ToolServer";
import { wouldCycle, type FlowDeps } from "./engine";
import { flowEdgeTypes } from "./FlowEdge";
import { FLOW_CARD_CSS, flowNodeTypes } from "./FlowNodeCard";
import { FlowProperties } from "./FlowProperties";
import { blockPorts } from "./ports";
import { REACT_FLOW_BASE_CSS } from "./reactFlowCss";
import type { FlowNode } from "./store";

/** Backspace (macOS habit) and Delete (Windows/Linux habit) both delete. */
const DELETE_KEY_CODES = ["Backspace", "Delete"];

const EDGE_OPTIONS = {
  type: "deletable",
  style: { stroke: "#94a3b8", strokeWidth: 2 },
};

export interface FlowPanelProps {
  deps: FlowDeps;
  /** Show the tool server form under the graph instead of the picked block. */
  serverOpen: boolean;
  onCloseServer: () => void;
}

function FlowGraph() {
  const nodes = useScopedFlowStore((s) => s.nodes);
  const edges = useScopedFlowStore((s) => s.edges);
  const setNodes = useScopedFlowStore((s) => s.setNodes);
  const setEdges = useScopedFlowStore((s) => s.setEdges);
  const removeNodes = useScopedFlowStore((s) => s.removeNodes);
  const removeEdges = useScopedFlowStore((s) => s.removeEdges);
  const connect = useScopedFlowStore((s) => s.connect);
  const flowApi = useFlowStoreApi();
  const connection = useScopedToolsStore((s) => s.connection);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  const portsOf = useCallback(
    (node: FlowNode | undefined) => {
      if (!node) return [];
      const params = node.data.params;
      const tool =
        params.type === "tool"
          ? (connection?.listing.tools.find((t) => t.name === params.tool) ?? null)
          : null;
      const wired = edges.filter((e) => e.target === node.id).map((e) => e.targetHandle ?? "");
      return blockPorts(params, tool, wired);
    },
    [connection, edges],
  );

  // Deletions go through the store, which also drops the wires and marks
  // what was downstream stale; everything else is xyflow's own bookkeeping.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      removeNodes(changes.flatMap((c) => (c.type === "remove" ? [c.id] : [])));
      const rest = changes.filter((c) => c.type !== "remove");
      if (rest.length > 0) setNodes(applyNodeChanges(rest, flowApi.getState().nodes));
    },
    [flowApi, removeNodes, setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      removeEdges(changes.flatMap((c) => (c.type === "remove" ? [c.id] : [])));
      const rest = changes.filter((c) => c.type !== "remove");
      if (rest.length > 0) setEdges(applyEdgeChanges(rest, flowApi.getState().edges));
    },
    [flowApi, removeEdges, setEdges],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (c: Edge | Connection) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      const target = nodes.find((n) => n.id === c.target);
      if (!portsOf(target).some((p) => p.key === c.targetHandle)) return false;
      return !wouldCycle({ nodes, edges }, c.source, c.target);
    },
    [nodes, edges, portsOf],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const port = portsOf(nodes.find((n) => n.id === c.target)).find(
        (p) => p.key === c.targetHandle,
      );
      if (port) connect(c, port.multiple);
    },
    [nodes, portsOf, connect],
  );

  // A tool server (dis)connecting adds or removes a tool block's input
  // handles; xyflow only measures handles when told to.
  const updateNodeInternals = useUpdateNodeInternals();
  const toolIds = nodes
    .filter((n) => n.data.params.type === "tool")
    .map((n) => n.id)
    .join(",");
  useEffect(() => {
    if (toolIds) updateNodeInternals(toolIds.split(","));
  }, [connection, toolIds, updateNodeInternals]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      nodeTypes={flowNodeTypes}
      edgeTypes={flowEdgeTypes}
      defaultEdgeOptions={EDGE_OPTIONS}
      deleteKeyCode={DELETE_KEY_CODES}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      colorMode={resolvedTheme}
      style={{ background: "transparent" }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={16}
        size={1}
        color="var(--megane-border-solid)"
        bgColor="transparent"
      />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

export default function FlowPanel({ deps, serverOpen, onCloseServer }: FlowPanelProps) {
  return (
    <div
      data-testid="builder-flow-panel"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <style>{REACT_FLOW_BASE_CSS + FLOW_CARD_CSS}</style>
      <div
        className="megane-flow-editor"
        data-testid="builder-flow-graph"
        style={{
          flex: "1 1 55%",
          minHeight: 160,
          position: "relative",
          borderBottom: "1px solid var(--megane-border-solid, #e2e8f0)",
        }}
      >
        <ReactFlowProvider>
          <FlowGraph />
        </ReactFlowProvider>
      </div>
      <div
        style={{
          flex: "1 1 45%",
          minHeight: 0,
          overflowY: "auto",
          padding: 10,
          fontSize: 13,
          color: "var(--megane-text, #1e293b)",
        }}
      >
        {serverOpen ? <ToolServerDialog onClose={onCloseServer} /> : <FlowProperties deps={deps} />}
      </div>
    </div>
  );
}
