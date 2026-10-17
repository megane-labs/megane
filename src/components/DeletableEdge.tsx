/**
 * Pipeline editor edge with an inline delete button.
 *
 * The edge is drawn like xyflow's bezier edge, but hovering it (or selecting
 * it with a click) reveals a small × button at its midpoint that removes the
 * connection. A wide invisible hit area makes the 2px stroke easy to target.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { useScopedPipelineStore } from "../stores/MeganeProvider";

/** Width (px) of the invisible stroke that receives hover/click. */
export const EDGE_INTERACTION_WIDTH = 24;

/**
 * Grace period before hiding the button on mouse leave, so the pointer can
 * travel from the edge stroke onto the button (rendered in a separate HTML
 * layer) without it disappearing.
 */
const HIDE_DELAY_MS = 150;

export const DeletableEdge = memo(function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  markerStart,
  selected,
}: EdgeProps) {
  const removeEdge = useScopedPipelineStore((s) => s.removeEdge);
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHovered(true);
  }, []);

  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHovered(false), HIDE_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const active = hovered || !!selected;
  const strokeWidth = Number(style?.strokeWidth ?? 2);

  return (
    <>
      <g onMouseEnter={show} onMouseLeave={hide}>
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          markerStart={markerStart}
          interactionWidth={EDGE_INTERACTION_WIDTH}
          style={active ? { ...style, strokeWidth: strokeWidth + 1.5 } : style}
        />
      </g>
      {active && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan"
            data-testid={`pipeline-edge-delete-${id}`}
            aria-label="Delete connection"
            title="Delete connection"
            onMouseEnter={show}
            onMouseLeave={hide}
            onClick={(e) => {
              e.stopPropagation();
              removeEdge(id);
            }}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              width: 20,
              height: 20,
              padding: 0,
              borderRadius: "50%",
              border: "1px solid var(--megane-border-strong)",
              background: "var(--megane-surface-solid)",
              color: "var(--megane-danger-text)",
              fontSize: 14,
              lineHeight: "18px",
              cursor: "pointer",
              boxShadow: "var(--megane-shadow)",
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { deletable: DeletableEdge };
