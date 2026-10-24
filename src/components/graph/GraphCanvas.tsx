/**
 * The node-graph canvas every editor draws its graph on: React Flow with the
 * same chrome everywhere — dotted background, minimap, zoom controls, the
 * theme's colour mode, deletable typed edges, Backspace / Delete to delete,
 * and the node-card hover rules. The viewer's pipeline editor and megane
 * Builder's Flow mode both use it, so their graphs look and behave alike;
 * each passes its own nodes, edges, node types and callbacks.
 */

import type { Ref } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowProps,
} from "@xyflow/react";
import { useThemeStore } from "../../stores/useThemeStore";
import { DeletableEdge, EdgeActionsContext, type EdgeActions } from "./DeletableEdge";
import { NODE_CARD_CSS } from "./NodeCardView";
import { REACT_FLOW_CSS } from "./reactFlowCss";

/** Backspace (macOS habit) and Delete (Windows/Linux habit) both delete. */
export const DELETE_KEY_CODES = ["Backspace", "Delete"];

/** How far `fitView` zooms, here and wherever an editor re-fits the graph. */
export const FIT_VIEW_OPTIONS = { padding: 0.1, maxZoom: 1.95 };

export const graphEdgeTypes = { deletable: DeletableEdge };

/** Neutral edge colour for an edge whose data type is unknown. */
export const DEFAULT_EDGE_COLOR = "#94a3b8";

/**
 * Animated edges march their dashes by animating `stroke-dashoffset`, which
 * the browser cannot hand to the compositor: every frame repaints the graph
 * on the main thread, for as long as the editor is on screen. They run while
 * the pointer is over the graph (someone is looking at it) and hold still
 * otherwise, and not at all for anyone who asked for reduced motion.
 */
export const EDGE_ANIMATION_CSS = `
.megane-split-editor .react-flow__edge.animated path { animation-play-state: paused; }
.megane-split-editor:hover .react-flow__edge.animated path { animation-play-state: running; }
@media (prefers-reduced-motion: reduce) {
  .megane-split-editor .react-flow__edge.animated path { animation: none; }
}
`;

/** Edges as every editor draws them: deletable, animated, in their data type's colour. */
export function styleEdges(edges: Edge[], colorOf: (edge: Edge) => string): Edge[] {
  return edges.map((edge) => ({
    ...edge,
    type: "deletable",
    animated: true,
    style: { stroke: colorOf(edge), strokeWidth: 2 },
  }));
}

type FixedProps =
  | "edgeTypes"
  | "deleteKeyCode"
  | "fitView"
  | "fitViewOptions"
  | "minZoom"
  | "maxZoom"
  | "defaultEdgeOptions"
  | "proOptions"
  | "colorMode"
  | "style"
  | "children";

export type GraphCanvasProps<N extends Node> = Omit<ReactFlowProps<N, Edge>, FixedProps> & {
  /** What deleting an edge does in this editor. */
  edgeActions: EdgeActions;
  /** The minimap's colour for a node (its category's). */
  miniMapNodeColor: (node: N) => string;
  containerRef?: Ref<HTMLDivElement>;
  testId?: string;
};

export function GraphCanvas<N extends Node>({
  edgeActions,
  miniMapNodeColor,
  containerRef,
  testId,
  ...flowProps
}: GraphCanvasProps<N>) {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className="megane-split-editor"
      style={{ flex: 1, position: "relative", minHeight: 0 }}
    >
      <style>{REACT_FLOW_CSS + NODE_CARD_CSS + EDGE_ANIMATION_CSS}</style>
      <EdgeActionsContext.Provider value={edgeActions}>
        <ReactFlow<N, Edge>
          {...flowProps}
          edgeTypes={graphEdgeTypes}
          deleteKeyCode={DELETE_KEY_CODES}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.3}
          maxZoom={2}
          defaultEdgeOptions={{
            type: "deletable",
            animated: true,
            style: { stroke: DEFAULT_EDGE_COLOR, strokeWidth: 3 },
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
          <MiniMap<N>
            style={{
              background: "var(--megane-surface-solid)",
              border: "1px solid var(--megane-border-solid)",
              borderRadius: 6,
              width: 72,
              height: 52,
            }}
            nodeColor={miniMapNodeColor}
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
      </EdgeActionsContext.Provider>
    </div>
  );
}
