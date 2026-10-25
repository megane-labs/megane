/**
 * Pipeline editor panel using xyflow.
 * Typed data-flow pipeline with color-coded handles per data type.
 *
 * The panel, the canvas, the node cards, the edges and the properties pane
 * are the shared node-graph kit (`components/graph/`), which megane
 * Builder's Flow mode is built from too; this file wires the pipeline store
 * into them.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import {
  useScopedPipelineStore,
  useScopedPipelineUIStore,
  usePipelineStoreApi,
} from "../stores/MeganeProvider";
import type { Connection, Edge, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../pipeline/execute";
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
import { DEFAULT_EDGE_COLOR, FIT_VIEW_OPTIONS, GraphCanvas, styleEdges } from "./graph/GraphCanvas";
import { GraphEditorPanel, SplitSeparator, useSplitFraction } from "./graph/GraphEditorPanel";
import {
  NodeMessages,
  PropertiesEmpty,
  PropertiesHeader,
  PropertiesPaneView,
} from "./graph/GraphProperties";
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
import { PipelineChatBox } from "./PipelineChatBox";
import { PipelineInspector } from "./PipelineInspector";
import { RenderModal } from "./RenderModal";
import { ShareDialog } from "./ShareDialog";
import { startTour, startPipelineTutorial } from "../tour/lazyTour";
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
};

/**
 * Determine edge color from the source handle's data type.
 */
function getEdgeColor(sourceNodeType: string | undefined, sourceHandle: string | null): string {
  if (!sourceNodeType || !sourceHandle) return DEFAULT_EDGE_COLOR;
  const ports = NODE_PORTS[sourceNodeType as PipelineNodeType];
  if (!ports) return DEFAULT_EDGE_COLOR;
  const port = ports.outputs.find((p) => p.name === sourceHandle);
  if (!port) return DEFAULT_EDGE_COLOR;
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
    <PropertiesPaneView
      height={height}
      bodyVisible={!!selected}
      scrollKey={selected?.id ?? null}
      // A node that is off keeps its settings; they are shown faded.
      bodyFaded={!!selected && !selected.data.enabled}
      head={
        selected && (
          <>
            <PipelinePropertiesHeader
              node={selected}
              onToggle={() => toggleNode(selected.id)}
              onRemove={() => removeNode(selected.id)}
            />
            {errors.length > 0 && <NodeMessages messages={errors} />}
          </>
        )
      }
      empty={<PropertiesEmpty text="Select a node to edit its parameters" />}
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
    </PropertiesPaneView>
  );
}

const NO_ERRORS: NodeError[] = [];

/** The properties pane's header for a pipeline node. */
function PipelinePropertiesHeader({
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
  return (
    <PropertiesHeader
      icon={CATEGORY_ICONS[category]}
      color={NODE_CATEGORY_COLORS[category]}
      title={NODE_TYPE_LABELS[type]}
      summary={summarizeNodeParams(node.data.params)}
      enabled={node.data.enabled}
      onToggle={onToggle}
      onRemove={type !== "viewport" ? onRemove : undefined}
    />
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
  const removeEdge = useScopedPipelineStore((s) => s.removeEdge);
  const reconnectEdge = useScopedPipelineStore((s) => s.reconnectEdge);
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
  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  // Share of the editor tab given to the properties pane (dragged by the
  // separator above it).
  const [paneFraction, handleSplitMouseDown] = useSplitFraction();
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const mode = useScopedPipelineUIStore((s) => s.mode);
  const setMode = useScopedPipelineUIStore((s) => s.setMode);

  // When the panel switches back to the editor the ReactFlow viewport may have
  // just been un-hidden, so we re-fit. Two RAFs give the layout/resize-observer
  // a chance to pick up the new dimensions before fitView reads them.
  useEffect(() => {
    if (mode !== "editor") return;
    let rafA = 0;
    let rafB = 0;
    rafA = window.requestAnimationFrame(() => {
      rafB = window.requestAnimationFrame(() => {
        fitView({ ...FIT_VIEW_OPTIONS, duration: 300 });
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
      fitView(FIT_VIEW_OPTIONS);
    });
  }, [layoutPending, nodesMeasured, autoLayout, fitView]);

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
  const styledEdges = useMemo(
    () =>
      styleEdges(edges, (edge) =>
        getEdgeColor(nodes.find((n) => n.id === edge.source)?.type, edge.sourceHandle ?? null),
      ),
    [edges, nodes],
  );
  const edgeActions = useMemo(
    () => ({ remove: removeEdge, testIdPrefix: "pipeline-edge-delete-" }),
    [removeEdge],
  );

  // Dragging an edge's endpoint off its handle and dropping it on empty
  // canvas disconnects it; dropping it on another valid handle rewires it.
  const reconnectSucceeded = useRef(true);
  const onReconnectStart = useCallback(() => {
    reconnectSucceeded.current = false;
  }, []);
  const onReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      reconnectSucceeded.current = true;
      reconnectEdge(oldEdge, connection);
    },
    [reconnectEdge],
  );
  const onReconnectEnd = useCallback(
    (_: MouseEvent | TouchEvent, edge: Edge) => {
      if (!reconnectSucceeded.current) removeEdge(edge.id);
      reconnectSucceeded.current = true;
    },
    [removeEdge],
  );

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
      fitView({ ...FIT_VIEW_OPTIONS, duration: 300 });
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
            throw new Error("Not a valid Megane pipeline JSON (version 3 required)");
          }
          deserialize(parsed);
          window.requestAnimationFrame(() => {
            fitView({ ...FIT_VIEW_OPTIONS, duration: 300 });
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

  return (
    <GraphEditorPanel
      title="Pipeline"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      onWidthChange={onWidthChange}
      bottom={bottom}
      subtitle={MODE_LABELS[mode]}
      rail={
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
          onGuide={() => void startTour()}
          onTutorial={() => void startPipelineTutorial()}
        />
      }
      extra={
        <>
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
        </>
      }
    >
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
          <NodeShellModeContext.Provider value="card">
            <GraphCanvas<Node<PipelineNodeData>>
              containerRef={flowContainerRef}
              nodes={nodes}
              edges={styledEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onReconnectStart={onReconnectStart}
              onReconnect={onReconnect}
              onReconnectEnd={onReconnectEnd}
              isValidConnection={isValidConnection}
              nodeTypes={memoizedNodeTypes}
              edgeActions={edgeActions}
              miniMapNodeColor={(n) =>
                n.type
                  ? NODE_CATEGORY_COLORS[NODE_CATEGORY[n.type as PipelineNodeType]]
                  : "var(--megane-primary)"
              }
            />
          </NodeShellModeContext.Provider>
          {/* The assistant sits between the graph it edits and the
                  selected node's properties; its conversation and settings
                  open over the bottom of the canvas. */}
          <PipelineChatBox />
          <SplitSeparator onMouseDown={handleSplitMouseDown} />
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
      </div>
    </GraphEditorPanel>
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
