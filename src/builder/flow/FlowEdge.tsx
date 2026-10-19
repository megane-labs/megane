/**
 * A wire in the Flow graph: xyflow's bezier edge with a × at its midpoint
 * while the wire is hovered or selected, as in the viewer's pipeline editor
 * (`components/DeletableEdge.tsx`, which is bound to the viewer's store).
 */

import { memo, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useScopedFlowStore } from "../BuilderStores";

export const FlowEdge = memo(function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  selected,
}: EdgeProps) {
  const removeEdges = useScopedFlowStore((s) => s.removeEdges);
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const active = hovered || !!selected;
  return (
    <>
      <g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={24}
          style={{ ...style, strokeWidth: active ? 3 : 2 }}
        />
      </g>
      {active && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan"
            data-testid={`builder-flow-edge-delete-${id}`}
            aria-label="Delete wire"
            title="Delete wire"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={(e) => {
              e.stopPropagation();
              removeEdges([id]);
            }}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              width: 20,
              height: 20,
              padding: 0,
              borderRadius: "50%",
              border: "1px solid var(--megane-border-strong, #cbd5e1)",
              background: "var(--megane-surface-solid, #fff)",
              color: "var(--megane-danger-text, #b91c1c)",
              fontSize: 14,
              lineHeight: "18px",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const flowEdgeTypes = { deletable: FlowEdge };
