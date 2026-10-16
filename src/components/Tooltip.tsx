/**
 * Hover tooltip for atoms and bonds.
 */

import { useLayoutEffect, useRef } from "react";
import type { HoverInfo } from "../types";
import { getElementSymbol, BOND_ORDER_NAMES } from "../constants";

/** Gap between the cursor and the tooltip's nearest corner, in CSS pixels. */
const CURSOR_OFFSET = 14;

/** Axis-aligned box in viewport (client) coordinates. */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Compute the `left`/`top` that put a `position: fixed` tooltip next to the
 * cursor.
 *
 * `HoverInfo.screenX/Y` are viewport (`clientX/Y`) coordinates, but a fixed
 * element is only positioned against the viewport when none of its ancestors
 * establishes a containing block for it. Hosts do: JupyterLab panels use CSS
 * containment, notebook output areas and VSCode webviews can sit under
 * `transform`/`filter`/`will-change`, and any of those turns `left: clientX`
 * into an offset from that ancestor — the tooltip then lands a sidebar's or a
 * cell's distance away from the cursor. So instead of assuming the viewport,
 * the caller measures where `left: 0; top: 0` actually renders (`origin`, which
 * is the containing block's corner in client coordinates and the tooltip's
 * rendered size) together with the layout size (`layoutWidth/Height`, which
 * transforms do not scale), and this maps the desired client position back
 * into that containing block.
 *
 * The tooltip flips to the other side of the cursor when it would run past the
 * right or bottom edge of `bounds` (the visible viewport), and is clamped so
 * its top-left corner never leaves it.
 */
export function computeTooltipPosition(
  cursorX: number,
  cursorY: number,
  origin: ClientBox,
  layoutWidth: number,
  layoutHeight: number,
  bounds: ClientBox,
): { left: number; top: number } {
  const scaleX = layoutWidth > 0 && origin.width > 0 ? origin.width / layoutWidth : 1;
  const scaleY = layoutHeight > 0 && origin.height > 0 ? origin.height / layoutHeight : 1;

  let x = cursorX + CURSOR_OFFSET;
  if (x + origin.width > bounds.left + bounds.width) {
    x = cursorX - CURSOR_OFFSET - origin.width;
  }
  x = Math.max(x, bounds.left);

  // Default placement keeps the original look: the tooltip's top edge sits just
  // above the cursor, so it reads beside the pointer rather than under it.
  let y = cursorY - CURSOR_OFFSET;
  if (y + origin.height > bounds.top + bounds.height) {
    y = cursorY - CURSOR_OFFSET - origin.height;
  }
  y = Math.max(y, bounds.top);

  return {
    left: (x - origin.left) / scaleX,
    top: (y - origin.top) / scaleY,
  };
}

interface TooltipProps {
  info: HoverInfo;
}

export function Tooltip({ info }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Runs after every render, before paint: the content (and thus the size)
  // changes with the hovered atom, and the host's containing block can move
  // between hovers (scrolling a notebook, resizing a panel).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !info) return;
    el.style.left = "0px";
    el.style.top = "0px";
    const origin = el.getBoundingClientRect();
    const doc = el.ownerDocument;
    const view = doc.defaultView;
    const bounds: ClientBox = {
      left: 0,
      top: 0,
      width: doc.documentElement.clientWidth || view?.innerWidth || Infinity,
      height: doc.documentElement.clientHeight || view?.innerHeight || Infinity,
    };
    const { left, top } = computeTooltipPosition(
      info.screenX,
      info.screenY,
      origin,
      el.offsetWidth,
      el.offsetHeight,
      bounds,
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  if (!info) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    // Provisional placement for the first paint-free layout pass; the layout
    // effect above replaces it with the measured, containing-block-aware one.
    left: info.screenX + CURSOR_OFFSET,
    top: info.screenY - CURSOR_OFFSET,
    background: "rgba(15, 23, 42, 0.92)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    color: "#fff",
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontFamily: "system-ui, -apple-system, monospace",
    pointerEvents: "none",
    zIndex: 100,
    whiteSpace: "nowrap",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  };

  if (info.kind === "atom") {
    return (
      <div ref={ref} style={style} data-testid="megane-tooltip">
        <div style={{ fontWeight: 600 }}>
          {info.elementSymbol} (#{info.atomIndex})
        </div>
        <div style={{ opacity: 0.7, fontSize: 11 }}>
          ({info.position[0].toFixed(2)}, {info.position[1].toFixed(2)},{" "}
          {info.position[2].toFixed(2)}) {"Å"}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} style={style} data-testid="megane-tooltip">
      <div style={{ fontWeight: 600 }}>
        {getElementSymbol(0)
          ? `Atom ${info.atomA} — Atom ${info.atomB}`
          : `${info.atomA} — ${info.atomB}`}
      </div>
      <div style={{ opacity: 0.7, fontSize: 11 }}>
        {BOND_ORDER_NAMES[info.bondOrder] ?? "Bond"} | {info.bondLength.toFixed(2)} {"Å"}
      </div>
    </div>
  );
}
