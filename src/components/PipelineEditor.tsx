/**
 * Pipeline editor panel using xyflow.
 * Typed data-flow pipeline with color-coded handles per data type.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useReactFlow,
} from "@xyflow/react";
import { useThemeStore } from "../stores/useThemeStore";
import {
  useScopedPipelineStore,
  useScopedPipelineUIStore,
  usePipelineStoreApi,
} from "../stores/MeganeProvider";
import type { Connection, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../pipeline/execute";
import "@xyflow/react/dist/style.css";
import { downloadBlob } from "../renderer/RenderCapture";
import { shareCurrentPipeline } from "../pipeline/shareLink";
import type { NodeError, PipelineNodeType } from "../pipeline/types";
import {
  NODE_TYPE_LABELS,
  canConnect,
  DATA_TYPE_COLORS,
  NODE_PORTS,
  NODE_CATEGORY_COLORS,
} from "../pipeline/types";
import { NODE_CATEGORY } from "../pipeline/types";
import { summarizeNodeParams } from "../pipeline/nodeSummary";
import { allNodesMeasured } from "../pipeline/layout";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { LoadStructureNode } from "./nodes/LoadStructureNode";
import { LoadTrajectoryNode } from "./nodes/LoadTrajectoryNode";
import { AddBondNode } from "./nodes/AddBondNode";
import { ViewportNode } from "./nodes/ViewportNode";
import { FilterNode } from "./nodes/FilterNode";
import { ModifyNode } from "./nodes/ModifyNode";
import { SymmetryNode } from "./nodes/SymmetryNode";
import { WrapNode } from "./nodes/WrapNode";
import { ReplicateNode } from "./nodes/ReplicateNode";
import { DrawingBoundaryNode } from "./nodes/DrawingBoundaryNode";
import { BoundaryCompletionNode } from "./nodes/BoundaryCompletionNode";
import { CoordinationGeneratorNode } from "./nodes/CoordinationGeneratorNode";
import { ColorNode } from "./nodes/ColorNode";
import { RepresentationNode } from "./nodes/RepresentationNode";
import { LabelGeneratorNode } from "./nodes/LabelGeneratorNode";
import { PolyhedronGeneratorNode } from "./nodes/PolyhedronGeneratorNode";
import { SurfaceMeshNode } from "./nodes/SurfaceMeshNode";
import { LoadVectorNode } from "./nodes/LoadVectorNode";
import { VectorOverlayNode } from "./nodes/VectorOverlayNode";
import { StreamingNode } from "./nodes/StreamingNode";
import { LoadVolumetricNode } from "./nodes/LoadVolumetricNode";
import { LoadSpectrumNode } from "./nodes/LoadSpectrumNode";
import { SpectrumPlotNode } from "./nodes/SpectrumPlotNode";
import { IsosurfaceNode } from "./nodes/IsosurfaceNode";
import { NodeShellModeContext } from "./nodes/NodeShell";
import { CATEGORY_ICONS } from "./nodes/categoryIcons";
import { NODE_CARD_CSS } from "./nodes/NodeCard";
import { PipelineChatBox } from "./PipelineChatBox";
import { PipelineInspector } from "./PipelineInspector";
import { RenderModal } from "./RenderModal";
import { ShareDialog } from "./ShareDialog";
import { startTour, startPipelineTutorial } from "../tour/MeganeTour";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { PipelineRail } from "./PipelineRail";
import type { PipelinePanelMode } from "../stores/usePipelineUIStore";

const nodeTypes = {
  load_structure: LoadStructureNode,
  load_trajectory: LoadTrajectoryNode,
  load_vector: LoadVectorNode,
  streaming: StreamingNode,
  add_bond: AddBondNode,
  coordination_generator: CoordinationGeneratorNode,
  viewport: ViewportNode,
  filter: FilterNode,
  modify: ModifyNode,
  symmetry: SymmetryNode,
  wrap: WrapNode,
  replicate: ReplicateNode,
  drawing_boundary: DrawingBoundaryNode,
  boundary_completion: BoundaryCompletionNode,
  color: ColorNode,
  representation: RepresentationNode,
  label_generator: LabelGeneratorNode,
  polyhedron_generator: PolyhedronGeneratorNode,
  surface_mesh: SurfaceMeshNode,
  vector_overlay: VectorOverlayNode,
  load_volumetric: LoadVolumetricNode,
  load_spectrum: LoadSpectrumNode,
  spectrum_plot: SpectrumPlotNode,
  isosurface: IsosurfaceNode,
};

const MODE_LABELS: Record<PipelinePanelMode, string> = {
  editor: "Editor",
  inspector: "Inspector",
  chat: "Chat",
};

const MIN_WIDTH = 320;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 480;

const resizeHandleStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 5,
  cursor: "col-resize",
  zIndex: 20,
  background: "transparent",
};

/**
 * Determine edge color from the source handle's data type.
 */
function getEdgeColor(sourceNodeType: string | undefined, sourceHandle: string | null): string {
  if (!sourceNodeType || !sourceHandle) return "#94a3b8";
  const ports = NODE_PORTS[sourceNodeType as PipelineNodeType];
  if (!ports) return "#94a3b8";
  const port = ports.outputs.find((p) => p.name === sourceHandle);
  if (!port) return "#94a3b8";
  return DATA_TYPE_COLORS[port.dataType];
}

type NodeFormComponent = React.ComponentType<{
  id: string;
  data: PipelineNodeData;
  type: string;
}>;

/**
 * One node's form in the properties pane. Every node keeps its form mounted
 * (only the selected one is shown) so a half-typed query survives a change of
 * selection and the loaders' file inputs stay in the document. Memoised so
 * dragging a card — which replaces the node object, not its data — does not
 * re-render every form.
 */
const NodeForm = memo(function NodeForm({
  id,
  type,
  data,
  visible,
}: {
  id: string;
  type: PipelineNodeType;
  data: PipelineNodeData;
  visible: boolean;
}) {
  const Component = nodeTypes[type] as unknown as NodeFormComponent | undefined;
  if (!Component) return null;
  return (
    <div style={visible ? undefined : { display: "none" }}>
      <Component id={id} data={data} type={type} />
    </div>
  );
});

/**
 * The selected node's header and form, shown under the graph. The graph's
 * cards stay compact; parameters are edited here.
 */
function PropertiesPane({ height }: { height: string }) {
  const nodes = useScopedPipelineStore((s) => s.nodes);
  const toggleNode = useScopedPipelineStore((s) => s.toggleNode);
  const removeNode = useScopedPipelineStore((s) => s.removeNode);
  const selected = nodes.find((n) => n.selected && n.type);
  const errors = useScopedPipelineStore((s) =>
    selected ? (s.nodeErrors[selected.id] ?? NO_ERRORS) : NO_ERRORS,
  );
  return (
    <div
      data-testid="pipeline-properties"
      style={{
        flex: `0 0 ${height}`,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--megane-surface-solid)",
      }}
    >
      {selected ? (
        <>
          <PropertiesHeader
            node={selected}
            onToggle={() => toggleNode(selected.id)}
            onRemove={() => removeNode(selected.id)}
          />
          {errors.length > 0 && <NodeMessages errors={errors} />}
        </>
      ) : (
        <div
          data-testid="pipeline-properties-empty"
          style={{
            margin: "auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--megane-text-muted)",
            textAlign: "center",
            padding: 16,
            lineHeight: 1.5,
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="13" height="8" rx="2" />
            <path d="M6.5 8h6" />
            <path d="M14 14l6 2.2-2.6 1.1-1.1 2.6z" />
          </svg>
          Select a node to edit its parameters
        </div>
      )}
      <div
        data-testid="pipeline-properties-body"
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 14px 14px",
          display: selected ? "block" : "none",
          // A node that is off keeps its settings; they are shown faded.
          opacity: selected && !selected.data.enabled ? 0.55 : 1,
        }}
      >
        {nodes.map((n) =>
          n.type ? (
            <NodeForm
              key={n.id}
              id={n.id}
              type={n.type as PipelineNodeType}
              data={n.data}
              visible={n.id === selected?.id}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

const NO_ERRORS: NodeError[] = [];

/** The selected node's errors and warnings, under its header. */
function NodeMessages({ errors }: { errors: NodeError[] }) {
  return (
    <div
      data-testid="pipeline-properties-messages"
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 14px 0" }}
    >
      {errors.map((e, i) => {
        const isError = e.severity === "error";
        const rgb = isError ? "239, 68, 68" : "245, 158, 11";
        return (
          <div
            key={i}
            role={isError ? "alert" : "status"}
            style={{
              display: "flex",
              gap: 6,
              alignItems: "flex-start",
              fontSize: 11.5,
              lineHeight: 1.4,
              padding: "5px 8px",
              borderRadius: 6,
              background: `rgba(${rgb}, 0.08)`,
              border: `1px solid rgba(${rgb}, 0.3)`,
              color: isError ? "var(--megane-danger-text)" : "var(--megane-warning-text)",
            }}
          >
            <span aria-hidden="true" style={{ fontWeight: 700 }}>
              {isError ? "!" : "⚠"}
            </span>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{e.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The header's icon buttons: square, muted until hovered. */
const headerIconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  flexShrink: 0,
  display: "grid",
  placeItems: "center",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  color: "var(--megane-text-muted)",
  padding: 0,
};

function PropertiesHeader({
  node,
  onToggle,
  onRemove,
}: {
  node: Node<PipelineNodeData>;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const type = node.type as PipelineNodeType;
  const category = NODE_CATEGORY[type];
  const color = NODE_CATEGORY_COLORS[category];
  const enabled = node.data.enabled;
  const summary = summarizeNodeParams(node.data.params);
  return (
    <div
      data-testid="pipeline-properties-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 10px 10px 14px",
        borderBottom: "1px solid var(--megane-border)",
        background: `color-mix(in srgb, ${color} 5%, transparent)`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          color,
          background: `color-mix(in srgb, ${color} 15%, transparent)`,
        }}
      >
        {CATEGORY_ICONS[category]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 13,
            letterSpacing: "-0.01em",
            color: "var(--megane-text)",
          }}
        >
          {NODE_TYPE_LABELS[type]}
        </div>
        <div
          title={summary}
          style={{
            fontSize: 11,
            color: "var(--megane-text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </div>
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          color: enabled ? "var(--megane-primary-text)" : "var(--megane-text-muted)",
          cursor: "pointer",
        }}
      >
        {enabled ? "On" : "Off"}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? "Disable node" : "Enable node"}
          title={enabled ? "Disable node" : "Enable node"}
          onClick={onToggle}
          style={{
            width: 30,
            height: 17,
            flexShrink: 0,
            borderRadius: 9,
            border: "none",
            padding: 0,
            cursor: "pointer",
            position: "relative",
            background: enabled ? "var(--megane-primary)" : "var(--megane-border-strong)",
            transition: "background 0.15s",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: enabled ? 15 : 2,
              width: 13,
              height: 13,
              borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
              transition: "left 0.15s",
            }}
          />
        </button>
      </label>
      {type !== "viewport" && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove node"
          aria-label="Remove node"
          style={headerIconButtonStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--megane-danger)";
            e.currentTarget.style.background = "rgba(239, 68, 68, 0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--megane-text-muted)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      )}
    </div>
  );
}

function PipelineEditorInner({
  collapsed,
  onToggleCollapse,
  onWidthChange,
  bottom,
  rendererRef,
  totalFrames,
  currentFrame,
  onSeek,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onWidthChange?: (width: number) => void;
  /** Bottom offset of the panel (default: clear of the Timeline). */
  bottom?: number | string;
  rendererRef: React.RefObject<MoleculeRenderer | null>;
  totalFrames: number;
  currentFrame: number;
  onSeek: (frame: number) => void;
}) {
  const pipelineApi = usePipelineStoreApi();
  const nodes = useScopedPipelineStore((s) => s.nodes);
  const edges = useScopedPipelineStore((s) => s.edges);
  const onNodesChange = useScopedPipelineStore((s) => s.onNodesChange);
  const onEdgesChange = useScopedPipelineStore((s) => s.onEdgesChange);
  const onConnect = useScopedPipelineStore((s) => s.onConnect);
  const addNode = useScopedPipelineStore((s) => s.addNode);
  const applyTemplate = useScopedPipelineStore((s) => s.applyTemplate);
  const autoLayout = useScopedPipelineStore((s) => s.autoLayout);
  const selectNode = useScopedPipelineStore((s) => s.selectNode);
  const layoutPending = useScopedPipelineStore((s) => s.layoutPending);
  const nodesMeasured = useScopedPipelineStore((s) => allNodesMeasured(s.nodes));
  const deserialize = useScopedPipelineStore((s) => s.deserialize);
  const { fitView } = useReactFlow();

  const { screenToFlowPosition } = useReactFlow();
  const [showRenderModal, setShowRenderModal] = useState(false);
  const [shareDialog, setShareDialog] = useState<{
    url: string;
    tooLong: boolean;
  } | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // The parent mirrors this width to size the renderer's frustum inset, but
  // `panelWidth` is local state that resets whenever the panel unmounts (e.g.
  // `ui.pipelineEditor` toggled off and back on) while the parent's mirror
  // keeps the last dragged value. Reporting on mount keeps the two in sync.
  useEffect(() => {
    onWidthChange?.(panelWidth);
  }, [panelWidth, onWidthChange]);
  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  // Share of the editor tab given to the properties pane (dragged by the
  // separator above it).
  const [paneFraction, setPaneFraction] = useState(0.34);
  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const column = (e.currentTarget as HTMLElement).parentElement;
    if (!column) return;
    const rect = column.getBoundingClientRect();
    if (rect.height <= 0) return;
    const onMove = (ev: MouseEvent) => {
      const fraction = (rect.bottom - ev.clientY) / rect.height;
      setPaneFraction(Math.max(0.15, Math.min(0.7, fraction)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  const mode = useScopedPipelineUIStore((s) => s.mode);
  const setMode = useScopedPipelineUIStore((s) => s.setMode);
  const pendingNotice = useScopedPipelineUIStore((s) => s.pendingNotice);
  const dismissNotice = useScopedPipelineUIStore((s) => s.dismissNotice);

  // When the panel switches back to the editor (e.g. after the chat assistant
  // applies a generated pipeline) the ReactFlow viewport may have just been
  // un-hidden, so we re-fit. Two RAFs give the layout/resize-observer a chance
  // to pick up the new dimensions before fitView reads them.
  useEffect(() => {
    if (mode !== "editor") return;
    let rafA = 0;
    let rafB = 0;
    rafA = window.requestAnimationFrame(() => {
      rafB = window.requestAnimationFrame(() => {
        fitView({ padding: 0.1, maxZoom: 1.95, duration: 300 });
      });
    });
    return () => {
      window.cancelAnimationFrame(rafA);
      window.cancelAnimationFrame(rafB);
    };
  }, [mode, fitView]);

  // A template, the initial graph, or a chat pipeline is laid out before
  // React has drawn it, from estimated node sizes. Once xyflow has measured
  // every node, lay it out again with the real sizes and re-fit; the RAF lets
  // ReactFlow adopt the new positions before fitView reads them. No cleanup
  // cancels that frame: `autoLayout` clears `layoutPending`, which re-runs
  // this effect right away and would cancel the fit it just scheduled.
  useEffect(() => {
    if (!layoutPending || !nodesMeasured) return;
    autoLayout();
    window.requestAnimationFrame(() => {
      fitView({ padding: 0.1, maxZoom: 1.95 });
    });
  }, [layoutPending, nodesMeasured, autoLayout, fitView]);

  // Auto-dismiss the "pipeline applied" notice after a short delay.
  useEffect(() => {
    if (!pendingNotice) return;
    const handle = window.setTimeout(() => dismissNotice(), 3000);
    return () => window.clearTimeout(handle);
  }, [pendingNotice, dismissNotice]);

  // Resize drag handling
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: panelWidth };

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Panel is on the right: dragging left increases width
        const newWidth = dragRef.current.startWidth - (ev.clientX - dragRef.current.startX);
        const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));
        setPanelWidth(clamped);
        onWidthChange?.(clamped);
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [panelWidth, onWidthChange],
  );

  // Connection validation using typed port matching
  const isValidConnection = useCallback(
    (
      connection:
        | Connection
        | {
            source: string;
            target: string;
            sourceHandle?: string | null;
            targetHandle?: string | null;
          },
    ) => {
      if (connection.source === connection.target) return false;
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode?.type || !targetNode?.type) return false;
      return canConnect(
        sourceNode.type as PipelineNodeType,
        (connection as Connection).sourceHandle ?? null,
        targetNode.type as PipelineNodeType,
        (connection as Connection).targetHandle ?? null,
      );
    },
    [nodes],
  );

  // Color edges based on data type
  const styledEdges = useMemo(() => {
    return edges.map((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const color = getEdgeColor(sourceNode?.type, edge.sourceHandle ?? null);
      return {
        ...edge,
        animated: true,
        style: {
          stroke: color,
          strokeWidth: 2,
        },
      };
    });
  }, [edges, nodes]);

  const handleAddNode = useCallback(
    (type: PipelineNodeType) => {
      // Place the new node at the center of the current viewport and select
      // it, so its form opens in the properties pane right away.
      const container = flowContainerRef.current;
      let id: string;
      if (container) {
        const rect = container.getBoundingClientRect();
        const centerPosition = screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        id = addNode(type, centerPosition);
      } else {
        id = addNode(type);
      }
      selectNode(id);
      setMode("editor");
    },
    [addNode, selectNode, screenToFlowPosition, setMode],
  );

  const handleApplyTemplate = useCallback(
    (templateId: string) => {
      applyTemplate(templateId);
      setMode("editor");
    },
    [applyTemplate, setMode],
  );

  const handleAutoLayout = useCallback(() => {
    autoLayout();
    setMode("editor");
    window.requestAnimationFrame(() => {
      fitView({ padding: 0.1, maxZoom: 1.95, duration: 300 });
    });
  }, [autoLayout, fitView, setMode]);

  const handleExport = useCallback(() => {
    const serialized = pipelineApi.getState().serialize();
    const blob = new Blob([JSON.stringify(serialized, null, 2)], { type: "application/json" });
    downloadBlob(blob, "pipeline.megane.json");
  }, [pipelineApi]);

  const handleImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result as string);
          if (parsed.version !== 3) {
            throw new Error("Not a valid megane pipeline JSON (version 3 required)");
          }
          deserialize(parsed);
          window.requestAnimationFrame(() => {
            fitView({ padding: 0.1, maxZoom: 1.95, duration: 300 });
          });
        } catch (err) {
          window.alert("Failed to load pipeline: " + (err as Error).message);
        }
        e.target.value = "";
      };
      reader.onerror = () => {
        window.alert("Failed to read file: " + (reader.error?.message ?? "unknown error"));
        e.target.value = "";
      };
      reader.readAsText(file);
    },
    [deserialize, fitView],
  );

  const handleShare = useCallback(async () => {
    try {
      const serialized = pipelineApi.getState().serialize();
      const { url, tooLong } = await shareCurrentPipeline(serialized);
      setShareDialog({ url, tooLong });
    } catch (err) {
      console.error("Share failed:", err);
      window.alert("Share failed: " + (err as Error).message);
    }
  }, [pipelineApi]);

  const memoizedNodeTypes = useMemo(() => nodeTypes, []);

  const appliedNoticeBanner = pendingNotice && mode === "editor" && (
    <div
      role="status"
      data-testid="pipeline-editor-applied-notice"
      style={{
        padding: "4px 10px",
        background: "rgba(16, 185, 129, 0.1)",
        color: "var(--megane-success-text)",
        fontSize: 11,
        fontWeight: 500,
        borderBottom: "1px solid var(--megane-border)",
      }}
    >
      Pipeline updated from chat
    </div>
  );

  const resizeHandle = (
    <div
      style={resizeHandleStyle}
      onMouseDown={handleResizeMouseDown}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "rgba(59,130,246,0.15)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    />
  );

  return (
    <CollapsiblePanel
      title="Pipeline"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      width={panelWidth}
      bottom={bottom}
      subtitle={MODE_LABELS[mode]}
      containerExtra={resizeHandle}
    >
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <PipelineRail
          mode={mode}
          onModeChange={setMode}
          onAddNode={handleAddNode}
          onApplyTemplate={handleApplyTemplate}
          onAutoLayout={handleAutoLayout}
          onImport={handleImportClick}
          onExport={handleExport}
          onShare={() => void handleShare()}
          onRender={() => setShowRenderModal(true)}
          onGuide={() => startTour()}
          onTutorial={() => startPipelineTutorial()}
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {appliedNoticeBanner}
          {/* The tabpanels share one absolute-positioned area inside a
              relative wrapper, and we toggle `visibility` rather than
              `display` or unmounting. That keeps ReactFlow's container
              measured at all times — the graph never collapses to 0×0 when
              the user comes back to the Editor tab — while still being
              treated as "hidden" by Playwright/`toBeHidden` and inert to
              keyboard focus. */}
          <div
            style={{
              position: "relative",
              flex: 1,
              minHeight: 0,
            }}
          >
            <div
              role="tabpanel"
              id="pipeline-tabpanel-editor"
              aria-labelledby="pipeline-tab-editor"
              aria-hidden={mode !== "editor"}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                visibility: mode === "editor" ? "visible" : "hidden",
              }}
            >
              <div
                ref={flowContainerRef}
                className="megane-split-editor"
                style={{ flex: 1, position: "relative", minHeight: 0 }}
              >
                <style>{NODE_CARD_CSS}</style>
                <NodeShellModeContext.Provider value="card">
                  <ReactFlow
                    nodes={nodes}
                    edges={styledEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    isValidConnection={isValidConnection}
                    nodeTypes={memoizedNodeTypes}
                    fitView
                    fitViewOptions={{ padding: 0.1, maxZoom: 1.95 }}
                    minZoom={0.3}
                    maxZoom={2}
                    defaultEdgeOptions={{
                      type: "bezier",
                      animated: true,
                      style: { stroke: "#94a3b8", strokeWidth: 3 },
                    }}
                    proOptions={{ hideAttribution: true }}
                    colorMode={resolvedTheme}
                    // xyflow's dark mode paints its own #141414 canvas; let the
                    // panel's themed surface show through instead.
                    style={{ background: "transparent" }}
                  >
                    <Background
                      variant={BackgroundVariant.Dots}
                      gap={16}
                      size={1}
                      color="var(--megane-border-solid)"
                      bgColor="transparent"
                    />
                    <MiniMap
                      style={{
                        background: "var(--megane-surface-solid)",
                        border: "1px solid var(--megane-border-solid)",
                        borderRadius: 6,
                        width: 72,
                        height: 52,
                      }}
                      nodeColor={(n) =>
                        n.type
                          ? NODE_CATEGORY_COLORS[NODE_CATEGORY[n.type as PipelineNodeType]]
                          : "var(--megane-primary)"
                      }
                      nodeBorderRadius={6}
                      maskColor="rgba(100,116,139,0.08)"
                    />
                    <Controls
                      showInteractive={false}
                      style={{
                        border: "1px solid var(--megane-border-solid)",
                        borderRadius: 6,
                        boxShadow: "none",
                      }}
                    />
                  </ReactFlow>
                </NodeShellModeContext.Provider>
              </div>
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize properties pane"
                onMouseDown={handleSplitMouseDown}
                style={{
                  flex: "0 0 7px",
                  cursor: "row-resize",
                  borderTop: "1px solid var(--megane-border-solid)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 3,
                    borderRadius: 2,
                    background: "var(--megane-border-strong)",
                  }}
                />
              </div>
              <PropertiesPane height={`${Math.round(paneFraction * 100)}%`} />
            </div>
            <div
              role="tabpanel"
              id="pipeline-tabpanel-inspector"
              aria-labelledby="pipeline-tab-inspector"
              aria-hidden={mode !== "inspector"}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                background: "var(--megane-surface-solid)",
                visibility: mode === "inspector" ? "visible" : "hidden",
              }}
            >
              <PipelineInspector />
            </div>
            <div
              role="tabpanel"
              id="pipeline-tabpanel-chat"
              aria-labelledby="pipeline-tab-chat"
              aria-hidden={mode !== "chat"}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                background: "var(--megane-surface-solid)",
                visibility: mode === "chat" ? "visible" : "hidden",
              }}
            >
              <PipelineChatBox />
            </div>
          </div>
        </div>
      </div>
      <input
        ref={importInputRef}
        type="file"
        accept=".megane.json,.json,application/json"
        style={{ display: "none" }}
        onChange={handleImportFile}
      />
      <RenderModal
        open={showRenderModal}
        onClose={() => setShowRenderModal(false)}
        rendererRef={rendererRef}
        totalFrames={totalFrames}
        currentFrame={currentFrame}
        onSeek={onSeek}
      />
      <ShareDialog
        open={shareDialog !== null}
        url={shareDialog?.url ?? ""}
        tooLong={shareDialog?.tooLong ?? false}
        onClose={() => setShareDialog(null)}
      />
    </CollapsiblePanel>
  );
}

export function PipelineEditor({
  collapsed,
  onToggleCollapse,
  onWidthChange,
  bottom,
  rendererRef,
  totalFrames = 0,
  currentFrame = 0,
  onSeek,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onWidthChange?: (width: number) => void;
  /** Bottom offset of the panel (default: clear of the Timeline). */
  bottom?: number | string;
  rendererRef: React.RefObject<MoleculeRenderer | null>;
  totalFrames?: number;
  currentFrame?: number;
  onSeek?: (frame: number) => void;
}) {
  const noopSeek = useCallback((_f: number) => {}, []);
  return (
    <ReactFlowProvider>
      <PipelineEditorInner
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        onWidthChange={onWidthChange}
        bottom={bottom}
        rendererRef={rendererRef}
        totalFrames={totalFrames}
        currentFrame={currentFrame}
        onSeek={onSeek ?? noopSeek}
      />
    </ReactFlowProvider>
  );
}
