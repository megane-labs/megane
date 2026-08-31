/**
 * Pipeline editor panel using xyflow.
 * Typed data-flow pipeline with color-coded handles per data type.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { Theme } from "../stores/useThemeStore";
import {
  useScopedPipelineStore,
  useScopedPipelineUIStore,
  usePipelineStoreApi,
} from "../stores/MeganeProvider";
import type { PipelinePanelMode } from "../stores/usePipelineUIStore";
import { TabSelector } from "./ui";
import type { Connection } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { downloadBlob } from "../renderer/RenderCapture";
import { shareCurrentPipeline } from "../pipeline/shareLink";
import type { PipelineNodeType } from "../pipeline/types";
import {
  NODE_TYPE_LABELS,
  canConnect,
  DATA_TYPE_COLORS,
  NODE_PORTS,
  NODE_CATEGORY_COLORS,
} from "../pipeline/types";
import type { NodeCategory } from "../pipeline/types";
import { PIPELINE_TEMPLATES } from "../pipeline/templates";
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
import { PipelineChatBox } from "./PipelineChatBox";
import { PipelineInspector } from "./PipelineInspector";
import { RenderModal } from "./RenderModal";
import { ShareDialog } from "./ShareDialog";
import { startTour, startPipelineTutorial } from "../tour/MeganeTour";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";

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

const ADD_NODE_GROUPS: { category: NodeCategory; label: string; types: PipelineNodeType[] }[] = [
  {
    category: "data_load",
    label: "Data Load",
    types: ["load_structure", "load_trajectory", "load_vector", "streaming"],
  },
  {
    category: "data_load",
    label: "Volumetric",
    types: ["load_volumetric"],
  },
  {
    category: "data_load",
    label: "Spectrum",
    types: ["load_spectrum", "spectrum_plot"],
  },
  { category: "bond", label: "Bond", types: ["add_bond", "coordination_generator"] },
  { category: "filter", label: "Filter", types: ["filter"] },
  {
    category: "modify",
    label: "Modify",
    types: [
      "modify",
      "color",
      "representation",
      "symmetry",
      "wrap",
      "replicate",
      "drawing_boundary",
      "boundary_completion",
    ],
  },
  {
    category: "overlay",
    label: "Overlay",
    types: ["label_generator", "polyhedron_generator", "vector_overlay", "isosurface"],
  },
];

/* ── Inline SVG Icons (12×12, currentColor) ────────────────────────── */

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
  focusable: "false" as const,
  style: { flexShrink: 0, width: 12, height: 12 } as React.CSSProperties,
};

const IconRender = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconLayout = (
  <svg {...iconProps}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const IconExport = (
  <svg {...iconProps}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const IconImport = (
  <svg {...iconProps}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const IconTemplates = (
  <svg {...iconProps}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

const IconPlus = (
  <svg {...iconProps} strokeWidth="2.5">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconShare = (
  <svg {...iconProps}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);

const IconGuide = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12" y2="17" />
  </svg>
);

const IconTutorial = (
  <svg {...iconProps}>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ),
  dark: (
    <svg {...iconProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  system: (
    <svg {...iconProps}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
};

/* Category icons for Add Node dropdown */
const CATEGORY_ICONS: Record<NodeCategory, React.ReactNode> = {
  data_load: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  bond: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  filter: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  ),
  modify: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  ),
  overlay: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  ),
  viewport: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
};

/* ── Toolbar styles ────────────────────────────────────────────────── */

const MIN_WIDTH = 320;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 480;

/** Shared base for icon+text buttons */
const textBtnBase: React.CSSProperties = {
  borderRadius: 5,
  padding: "3px 6px",
  cursor: "pointer",
  fontSize: 10.5,
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  whiteSpace: "nowrap",
  lineHeight: 1,
};

const addBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(59, 130, 246, 0.08)",
  border: "1px solid rgba(59, 130, 246, 0.25)",
  color: "#3b82f6",
};

const renderBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(245, 158, 11, 0.08)",
  border: "1px solid rgba(245, 158, 11, 0.25)",
  color: "#f59e0b",
};

const templateBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(139, 92, 246, 0.08)",
  border: "1px solid rgba(139, 92, 246, 0.25)",
  color: "#8b5cf6",
};

const layoutBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(16, 185, 129, 0.08)",
  border: "1px solid rgba(16, 185, 129, 0.25)",
  color: "#10b981",
};

const exportBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(6, 182, 212, 0.08)",
  border: "1px solid rgba(6, 182, 212, 0.25)",
  color: "#06b6d4",
};

const importBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(99, 102, 241, 0.08)",
  border: "1px solid rgba(99, 102, 241, 0.25)",
  color: "#6366f1",
};

const shareBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(16, 185, 129, 0.08)",
  border: "1px solid rgba(16, 185, 129, 0.25)",
  color: "#059669",
};

const guideBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(100, 116, 139, 0.08)",
  border: "1px solid rgba(100, 116, 139, 0.3)",
  color: "#64748b",
};

const tutorialBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(59, 130, 246, 0.08)",
  border: "1px solid rgba(59, 130, 246, 0.3)",
  color: "#1d4ed8",
};

const themeBtnStyle: React.CSSProperties = {
  ...textBtnBase,
  background: "rgba(148, 163, 184, 0.08)",
  border: "1px solid rgba(148, 163, 184, 0.3)",
  color: "var(--megane-text-secondary)",
};

const dropdownStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: 4,
  background: "var(--megane-surface-solid)",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  boxShadow: "0 4px 12px var(--megane-shadow)",
  zIndex: 100,
  minWidth: 180,
  padding: "4px 0",
};

const dropdownItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  background: "none",
  border: "none",
  padding: "6px 14px 6px 20px",
  cursor: "pointer",
  fontSize: 12,
  color: "var(--megane-text)",
  textAlign: "left",
};

const groupHeaderStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--megane-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "6px 14px 2px",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const templateItemDescStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--megane-text-muted)",
  marginTop: 1,
};

const toolbarRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexBasis: "100%",
  flexWrap: "wrap",
  rowGap: 4,
};

const toolbarCategoryLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: "var(--megane-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginRight: 2,
  width: 64,
  flexShrink: 0,
};

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

function PipelineEditorInner({
  collapsed,
  onToggleCollapse,
  onWidthChange,
  rendererRef,
  totalFrames,
  currentFrame,
  onSeek,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onWidthChange?: (width: number) => void;
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
  const deserialize = useScopedPipelineStore((s) => s.deserialize);
  const { fitView } = useReactFlow();

  const { screenToFlowPosition } = useReactFlow();
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
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
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const { theme, setTheme } = useThemeStore();
  const THEME_CYCLE: Theme[] = ["light", "dark", "system"];
  const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Auto" };
  const handleCycleTheme = useCallback(() => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
    setTheme(next);
  }, [theme, setTheme]);

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
      // Place the new node at the center of the current viewport
      const container = flowContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const centerPosition = screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        addNode(type, centerPosition);
      } else {
        addNode(type);
      }
      setShowAddMenu(false);
    },
    [addNode, screenToFlowPosition],
  );

  const handleApplyTemplate = useCallback(
    (templateId: string) => {
      applyTemplate(templateId);
      setShowTemplateMenu(false);
    },
    [applyTemplate],
  );

  const handleAutoLayout = useCallback(() => {
    autoLayout();
    window.requestAnimationFrame(() => {
      fitView({ padding: 0.1, maxZoom: 1.95, duration: 300 });
    });
  }, [autoLayout, fitView]);

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

  // Toolbar row that lives inside the Editor tab — its actions only make
  // sense while the user can see the graph. Hidden on the Chat tab.
  // `toolbarRowStyle.flexBasis: "100%"` exists for the wrap-row parent in
  // the panel header; here the parent is `flex-direction: column`, so a
  // 100% basis would claim the entire column main axis (height) and leave
  // a tall band of empty space around the buttons. Override to `auto` and
  // pin `flexShrink: 0` so the toolbar takes only its content height and
  // the ReactFlow canvas keeps the rest.
  const editorToolbar = (
    <div
      data-testid="pipeline-editor-row"
      style={{
        ...toolbarRowStyle,
        padding: "5px 8px",
        flexBasis: "auto",
        flexShrink: 0,
      }}
    >
      <span style={toolbarCategoryLabelStyle}>Pipeline</span>
      <div style={{ position: "relative" }}>
        <button
          onClick={() => {
            setShowAddMenu(!showAddMenu);
            setShowTemplateMenu(false);
          }}
          style={addBtnStyle}
          title="Add Node"
        >
          {IconPlus} Add Node
        </button>
        {showAddMenu && (
          <div style={{ ...dropdownStyle, right: "auto", left: 0 }}>
            {ADD_NODE_GROUPS.map((group) => (
              <div key={group.category}>
                <div style={{ ...groupHeaderStyle, color: NODE_CATEGORY_COLORS[group.category] }}>
                  {CATEGORY_ICONS[group.category]}
                  <span style={{ color: "#94a3b8" }}>{group.label}</span>
                </div>
                {group.types.map((type) => (
                  <button
                    key={type}
                    onClick={() => handleAddNode(type)}
                    style={dropdownItemStyle}
                    onMouseEnter={(e) => {
                      (e.target as HTMLElement).style.background = "rgba(59,130,246,0.06)";
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLElement).style.background = "none";
                    }}
                  >
                    {NODE_TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={handleAutoLayout}
        style={layoutBtnStyle}
        title="Auto Layout"
        aria-label="Auto Layout"
      >
        {IconLayout} Layout
      </button>
      <div style={{ position: "relative" }}>
        <button
          data-testid="pipeline-editor-templates"
          onClick={() => {
            setShowTemplateMenu(!showTemplateMenu);
            setShowAddMenu(false);
          }}
          style={templateBtnStyle}
          title="Templates"
        >
          {IconTemplates} Templates
        </button>
        {showTemplateMenu && (
          <div style={{ ...dropdownStyle, right: "auto", left: 0 }}>
            {PIPELINE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                data-testid={`pipeline-template-${template.id}`}
                onClick={() => handleApplyTemplate(template.id)}
                style={{ ...dropdownItemStyle, padding: "8px 14px" }}
                onMouseEnter={(e) => {
                  (e.target as HTMLElement).style.background = "rgba(139,92,246,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.target as HTMLElement).style.background = "none";
                }}
              >
                <div style={{ fontWeight: 500 }}>{template.label}</div>
                <div style={templateItemDescStyle}>{template.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const TAB_OPTIONS: { value: PipelinePanelMode; label: string }[] = [
    { value: "editor", label: "Editor" },
    { value: "inspector", label: "Inspector" },
    { value: "chat", label: "Chat" },
  ];

  const headerExtra = (
    <>
      {/* Tabs: anchor at the top so the visual hierarchy reads
          Title → Tabs → tab-relevant toolbars → pane content. */}
      <div style={{ flexBasis: "100%" }}>
        <TabSelector<PipelinePanelMode>
          options={TAB_OPTIONS}
          value={mode}
          onChange={setMode}
          ariaLabel="Pipeline panel mode"
          tabIdFor={(v) => `pipeline-tab-${v}`}
          panelIdFor={(v) => `pipeline-tabpanel-${v}`}
          testIdFor={(v) => `pipeline-editor-tab-${v}`}
          size="compact"
        />
      </div>
      {/* I/O: exchange and execute (visible from both tabs — operates on the
          current pipeline regardless of which pane is showing). */}
      <div style={toolbarRowStyle}>
        <span style={toolbarCategoryLabelStyle}>I/O</span>
        <button
          onClick={handleExport}
          style={exportBtnStyle}
          title="Export Pipeline"
          aria-label="Export Pipeline"
        >
          {IconExport} Export
        </button>
        <button
          onClick={handleImportClick}
          style={importBtnStyle}
          title="Import Pipeline"
          aria-label="Import Pipeline"
        >
          {IconImport} Import
        </button>
        <button
          data-testid="pipeline-editor-share"
          onClick={() => void handleShare()}
          style={shareBtnStyle}
          title="Copy shareable link"
          aria-label="Copy shareable link"
        >
          {IconShare} Share
        </button>
        <button
          data-testid="pipeline-editor-render"
          onClick={() => setShowRenderModal(true)}
          style={renderBtnStyle}
          title="Render"
        >
          {IconRender} Render
        </button>
      </div>
      {/* Others: editor-side help & appearance. Hidden on the Chat tab so the
          chat input gets more vertical room and the header stays compact. */}
      {mode === "editor" && (
        <div style={toolbarRowStyle} data-testid="pipeline-editor-others-row">
          <span style={toolbarCategoryLabelStyle}>Others</span>
          <button
            data-testid="pipeline-editor-guide"
            onClick={() => startTour()}
            style={guideBtnStyle}
            title="Show user guide"
            aria-label="Show user guide"
          >
            {IconGuide} Guide
          </button>
          <button
            data-testid="pipeline-editor-tutorial"
            onClick={() => startPipelineTutorial()}
            style={tutorialBtnStyle}
            title="Walk through how to build a pipeline"
            aria-label="Open pipeline tutorial"
          >
            {IconTutorial} Tutorial
          </button>
          <button
            data-testid="pipeline-editor-theme"
            onClick={handleCycleTheme}
            style={themeBtnStyle}
            title={`Theme: ${THEME_LABELS[theme]} (click to cycle)`}
            aria-label={`Switch theme, current: ${THEME_LABELS[theme]}`}
          >
            {THEME_ICONS[theme]} {THEME_LABELS[theme]}
          </button>
        </div>
      )}
    </>
  );

  const appliedNoticeBanner = pendingNotice && mode === "editor" && (
    <div
      role="status"
      data-testid="pipeline-editor-applied-notice"
      style={{
        padding: "4px 10px",
        background: "rgba(16, 185, 129, 0.1)",
        color: "#059669",
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
      headerExtra={headerExtra}
      containerExtra={resizeHandle}
    >
      {appliedNoticeBanner}
      {/* Both tabpanels share the same absolute-positioned area inside a
          relative wrapper, and we toggle `visibility` rather than `display`
          or unmounting. That keeps ReactFlow's container measured at all
          times — the graph never collapses to 0×0 when the user comes back
          to the Editor tab — while still being treated as "hidden" by
          Playwright/`toBeHidden` and inert to keyboard focus. */}
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
          {editorToolbar}
          <div ref={flowContainerRef} style={{ flex: 1, position: "relative", minHeight: 0 }}>
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
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={16}
                size={1}
                color="var(--megane-border-solid)"
              />
              <MiniMap
                style={{
                  background: "var(--megane-surface-solid)",
                  border: "1px solid var(--megane-border-solid)",
                  borderRadius: 6,
                  width: 100,
                  height: 70,
                }}
                nodeColor="var(--megane-primary)"
                maskColor="rgba(59,130,246,0.05)"
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
          </div>
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
  rendererRef,
  totalFrames = 0,
  currentFrame = 0,
  onSeek,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onWidthChange?: (width: number) => void;
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
        rendererRef={rendererRef}
        totalFrames={totalFrames}
        currentFrame={currentFrame}
        onSeek={onSeek ?? noopSeek}
      />
    </ReactFlowProvider>
  );
}
