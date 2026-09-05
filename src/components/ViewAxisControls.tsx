/**
 * Camera axis-alignment buttons (issue #661).
 *
 * Two rows of six buttons: the crystallographic axes (±a, ±b, ±c), shown only
 * while the structure carries a cell, and the Cartesian axes (±x, ±y, ±z).
 * Each turns the camera to look straight along that axis from the named side
 * — "+a" puts the +a end of the cell toward the viewer — keeping the current
 * zoom, so the view can be flipped between faces without re-fitting. The
 * math lives in `src/renderer/cameraOrientation.ts`.
 *
 * Purely presentational: the parent owns the renderer and passes `onAlign`.
 */

import {
  CARTESIAN_VIEW_AXES,
  LATTICE_VIEW_AXES,
  type ViewAxis,
} from "../renderer/cameraOrientation";

export interface ViewAxisControlsProps {
  /** Whether the current structure has a usable cell (shows the a/b/c row). */
  hasCell: boolean;
  onAlign: (axis: ViewAxis) => void;
}

const AXIS_DESCRIPTION: Record<string, string> = {
  a: "crystal a axis",
  b: "crystal b axis",
  c: "crystal c axis",
  x: "x axis",
  y: "y axis",
  z: "z axis",
};

function axisTitle(axis: ViewAxis): string {
  const sign = axis[0] === "-" ? "−" : "+";
  return `View along the ${AXIS_DESCRIPTION[axis[1]]} from its ${sign} side`;
}

/** Button label: a real minus sign reads better than a hyphen at 11px. */
function axisLabel(axis: ViewAxis): string {
  return axis.replace("-", "−");
}

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 2,
};

const BUTTON_STYLE: React.CSSProperties = {
  padding: "4px 0",
  width: 24,
  fontSize: 11,
  lineHeight: 1,
  fontVariantNumeric: "tabular-nums",
  background: "rgba(255,255,255,0.85)",
  border: "1px solid rgba(0,0,0,0.15)",
  borderRadius: 4,
  cursor: "pointer",
  color: "#374151",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
  userSelect: "none",
};

function AxisRow({
  axes,
  testid,
  onAlign,
}: {
  axes: readonly ViewAxis[];
  testid: string;
  onAlign: (axis: ViewAxis) => void;
}) {
  return (
    <div data-testid={testid} role="group" style={ROW_STYLE}>
      {axes.map((axis) => (
        <button
          key={axis}
          type="button"
          data-testid={`view-axis-${axis}`}
          data-axis={axis}
          title={axisTitle(axis)}
          aria-label={axisTitle(axis)}
          onClick={() => onAlign(axis)}
          style={BUTTON_STYLE}
        >
          {axisLabel(axis)}
        </button>
      ))}
    </div>
  );
}

export function ViewAxisControls({ hasCell, onAlign }: ViewAxisControlsProps) {
  return (
    <div
      data-testid="view-axis-controls"
      style={{ display: "flex", flexDirection: "column", gap: 2, zIndex: 10 }}
    >
      {hasCell && (
        <AxisRow axes={LATTICE_VIEW_AXES} testid="view-axis-row-lattice" onAlign={onAlign} />
      )}
      <AxisRow axes={CARTESIAN_VIEW_AXES} testid="view-axis-row-cartesian" onAlign={onAlign} />
    </div>
  );
}
