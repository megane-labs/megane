/**
 * The Flow panel: megane Builder's node-graph editor, built from the same
 * kit as the viewer's Pipeline panel (`components/graph/`) — the resizable
 * panel with its rail on the left, the graph canvas, the AI assistant's
 * prompt bar (`FlowChatBox`), the draggable split, and the selected block's
 * pane under it. It takes the place of the Details
 * and History panels on the right of the view while the Builder is in Flow
 * mode.
 *
 * Loaded on demand (`React.lazy` in `BuilderApp`), so a Builder that never
 * leaves Manual mode does not load the graph editor.
 *
 * The Builder's own shortcuts are off in Flow mode, so the panel has its own
 * Undo and Redo keys (`useFlowUndoKeys`), live while the focus — or the last
 * click — is in the panel and not in a text field.
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import { FIT_VIEW_OPTIONS, GraphCanvas, styleEdges } from "../../components/graph/GraphCanvas";
import {
  GraphEditorPanel,
  SplitSeparator,
  useSplitFraction,
} from "../../components/graph/GraphEditorPanel";
import { NODE_CARD_WIDTH } from "../../components/graph/NodeCardView";
import { getLayoutedElements } from "../../pipeline/layout";
import { allMolecules, useLibraryStore } from "../library/store";
import type { BuilderToolInfo } from "../tools/contract";
import {
  useBuilderStoreApi,
  useFlowStoreApi,
  useScopedFlowStore,
  useScopedToolsStore,
} from "../BuilderStores";
import { isTypingTarget } from "../shortcuts";
import { defaultBuiltinParams } from "./builtins";
import { STRUCTURE_COLOR, blockColor } from "./describe";
import { wouldCycle, type FlowDeps } from "./engine";
import { FlowChatBox } from "./FlowChatBox";
import { flowNodeTypes } from "./FlowNodeCard";
import { FlowProperties } from "./FlowProperties";
import { FlowRail, addMenuItems, type FlowActions } from "./FlowRail";
import { blockPorts, initialToolParams } from "./ports";
import { confirmReplaceFlow } from "./shared";
import type { FlowNode } from "./store";
import { FLOW_TEMPLATES } from "./templates";
import type { FlowParams } from "./types";

/** Vertical step between a new block and one already where it would land. */
const STACK_STEP = 110;

export interface FlowPanelProps {
  deps: FlowDeps;
  /** Run, Stop and the flow file's actions. */
  actions: FlowActions;
  /** The host reaches tool servers: the Add menu lists their tools. */
  hasTools: boolean;
  /** Show the tool server form in the pane instead of the selected block. */
  serverOpen: boolean;
  onOpenServer: () => void;
  onCloseServer: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onWidthChange?: (width: number) => void;
  bottom?: number | string;
}

/** `pos`, moved down until no block sits there. */
function freePosition(pos: { x: number; y: number }, nodes: FlowNode[]) {
  const out = { ...pos };
  while (
    nodes.some((n) => Math.abs(n.position.x - out.x) < 40 && Math.abs(n.position.y - out.y) < 40)
  ) {
    out.y += STACK_STEP;
  }
  return out;
}

/**
 * Ctrl/⌘+Z undoes the last change to the graph, Ctrl/⌘+Shift+Z and Ctrl+Y
 * redo it, while the focus is inside `rootRef` (or on the page itself after
 * a click in it, as a click on the graph's background leaves it) and not in
 * a text field, whose own undo the keys keep.
 */
export function useFlowUndoKeys(
  rootRef: RefObject<HTMLElement | null>,
  undo: () => void,
  redo: () => void,
): void {
  useEffect(() => {
    let clickedInside = false;
    const onPointerDown = (e: PointerEvent) => {
      clickedInside = !!rootRef.current?.contains(e.target as Node | null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const root = rootRef.current;
      const target = e.target as Node | null;
      if (!root || isTypingTarget(target)) return;
      const onPage = !target || target === document.body || target === document.documentElement;
      if (!root.contains(target) && !(onPage && clickedInside)) return;
      const key = e.key.toLowerCase();
      const action = key === "z" ? (e.shiftKey ? redo : undo) : key === "y" ? redo : null;
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rootRef, undo, redo]);
}

function FlowEditor({
  deps,
  actions,
  hasTools,
  serverOpen,
  onOpenServer,
  onCloseServer,
  collapsed,
  onToggleCollapse,
  onWidthChange,
  bottom,
}: FlowPanelProps) {
  const flowApi = useFlowStoreApi();
  const builderApi = useBuilderStoreApi();
  const nodes = useScopedFlowStore((s) => s.nodes);
  const edges = useScopedFlowStore((s) => s.edges);
  const setNodes = useScopedFlowStore((s) => s.setNodes);
  const setEdges = useScopedFlowStore((s) => s.setEdges);
  const removeNodes = useScopedFlowStore((s) => s.removeNodes);
  const removeEdges = useScopedFlowStore((s) => s.removeEdges);
  const connect = useScopedFlowStore((s) => s.connect);
  const undo = useScopedFlowStore((s) => s.undo);
  const redo = useScopedFlowStore((s) => s.redo);
  const canUndo = useScopedFlowStore((s) => s.past.length > 0);
  const canRedo = useScopedFlowStore((s) => s.future.length > 0);
  const toolsStatus = useScopedToolsStore((s) => s.status);
  const connection = useScopedToolsStore((s) => s.connection);
  const toolServers = useScopedToolsStore((s) => s.servers);
  const setToolServer = useScopedToolsStore((s) => s.setUrl);
  const connectToolServer = useScopedToolsStore((s) => s.connect);
  const user = useLibraryStore((s) => s.user);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [paneFraction, handleSplitMouseDown] = useSplitFraction();
  useFlowUndoKeys(rootRef, undo, redo);

  // A new block lands in the middle of the graph's view, selected, so its
  // settings open in the pane right away (as the viewer's Add Node does).
  const addBlock = useCallback(
    (params: FlowParams) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const center = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : null;
      const position = center
        ? freePosition(
            { x: center.x - NODE_CARD_WIDTH / 2, y: center.y - 26 },
            flowApi.getState().nodes,
          )
        : undefined;
      flowApi.getState().addNode(params, position);
      onCloseServer();
    },
    [flowApi, screenToFlowPosition, onCloseServer],
  );

  const addItems = addMenuItems({
    addSmiles: () =>
      addBlock({ type: "molecule", source: "smiles", smiles: "", libraryId: "", name: "" }),
    addLibrary: () =>
      addBlock({
        type: "molecule",
        source: "library",
        smiles: "",
        libraryId: allMolecules({ user })[0]?.id ?? "",
        name: "",
      }),
    addDocument: () => addBlock({ type: "document" }),
    addBuiltin: (type) => addBlock(defaultBuiltinParams(type)),
    addTool: (tool: BuilderToolInfo) => addBlock(initialToolParams(tool)),
    openServer: onOpenServer,
    tools: hasTools
      ? {
          status: toolsStatus,
          connection,
          servers: toolServers,
          setUrl: setToolServer,
          connect: connectToolServer,
        }
      : undefined,
  });

  const handleAutoLayout = useCallback(() => {
    flowApi.getState().checkpoint();
    const { nodes: laidOut } = getLayoutedElements(
      flowApi.getState().nodes,
      flowApi.getState().edges,
    );
    setNodes(laidOut);
    window.requestAnimationFrame(() => {
      void fitView({ ...FIT_VIEW_OPTIONS, duration: 300 });
    });
  }, [flowApi, setNodes, fitView]);

  // A template replaces the flow (asking first when it has blocks), then the
  // view fits the new blocks.
  const handleApplyTemplate = useCallback(
    async (templateId: string) => {
      const template = FLOW_TEMPLATES.find((t) => t.id === templateId);
      if (!template) return;
      const ok = await confirmReplaceFlow(
        builderApi,
        flowApi,
        `The template “${template.label}”`,
        "Use template",
      );
      if (!ok) return;
      flowApi.getState().load(template.create(), { name: template.id });
      onCloseServer();
      window.requestAnimationFrame(() => {
        void fitView({ ...FIT_VIEW_OPTIONS, duration: 300 });
      });
    },
    [flowApi, builderApi, fitView, onCloseServer],
  );

  // Deletions go through the store, which also drops the wires and marks
  // what was downstream stale (and refuses while a run is in progress, as
  // the pane's remove button does); everything else is xyflow's own
  // bookkeeping.
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

  // A tool block from a template (or an older file) takes the tool's
  // defaults for the settings it does not set, once the tool is there.
  useEffect(() => {
    if (!toolIds || !connection) return;
    flowApi
      .getState()
      .completeTools((name) => connection.listing.tools.find((t) => t.name === name) ?? null);
  }, [flowApi, connection, toolIds]);

  // Every Flow wire carries a structure: drawn as the viewer draws particle data.
  const styledEdges = useMemo(() => styleEdges(edges, () => STRUCTURE_COLOR), [edges]);
  const edgeActions = useMemo(
    () => ({
      remove: (id: string) => removeEdges([id]),
      testIdPrefix: "builder-flow-edge-delete-",
    }),
    [removeEdges],
  );

  return (
    // `display: contents`: a box for the Undo keys to find the focus in, not one that lays out.
    <div ref={rootRef} data-testid="builder-flow-root" style={{ display: "contents" }}>
      <GraphEditorPanel
        title="Flow"
        subtitle={`${nodes.length} block${nodes.length === 1 ? "" : "s"}`}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        onWidthChange={onWidthChange}
        bottom={bottom}
        testId="builder-flow-panel"
        rail={
          <FlowRail
            addItems={addItems}
            onApplyTemplate={(id) => void handleApplyTemplate(id)}
            onAutoLayout={handleAutoLayout}
            hasTools={hasTools}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            {...actions}
          />
        }
      >
        <GraphCanvas<FlowNode>
          testId="builder-flow-graph"
          containerRef={containerRef}
          nodes={nodes}
          edges={styledEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          nodeTypes={flowNodeTypes}
          edgeActions={edgeActions}
          miniMapNodeColor={(n) => blockColor(n.data.params)}
        />
        {/* The assistant sits between the graph it edits and the selected
            block's pane, as in the viewer's pipeline editor. */}
        <FlowChatBox deps={deps} hasTools={hasTools} />
        <SplitSeparator onMouseDown={handleSplitMouseDown} />
        <FlowProperties
          deps={deps}
          height={`${Math.round(paneFraction * 100)}%`}
          serverOpen={serverOpen}
          onCloseServer={onCloseServer}
          hasTools={hasTools}
          onOpenServer={onOpenServer}
        />
      </GraphEditorPanel>
    </div>
  );
}

export default function FlowPanel(props: FlowPanelProps) {
  return (
    <ReactFlowProvider>
      <FlowEditor {...props} />
    </ReactFlowProvider>
  );
}
