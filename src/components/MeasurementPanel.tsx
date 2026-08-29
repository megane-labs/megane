/**
 * Panel showing selected atoms and geometric measurement results.
 */

import type { SelectionState, Measurement } from "../types";
import { getElementSymbol } from "../constants";
import { useScopedMeasurementStore } from "../stores/MeganeProvider";
import { MEASUREMENT_BOTTOM_DEFAULT } from "./overlayLayout";

interface MeasurementPanelProps {
  selection: SelectionState;
  measurement: Measurement | null;
  elements: Uint8Array | null;
  onClear: () => void;
  /**
   * Distance from the viewer's bottom edge in px. Defaults to
   * {@link MEASUREMENT_BOTTOM_DEFAULT}; hosts that hide the Timeline pass a
   * smaller value so the panel doesn't float above an empty band.
   */
  bottom?: number;
}

const MEASUREMENT_LABELS: Record<string, string> = {
  distance: "Distance",
  angle: "Angle",
  dihedral: "Dihedral",
};

export function MeasurementPanel({
  selection,
  measurement,
  elements,
  onClear,
  bottom = MEASUREMENT_BOTTOM_DEFAULT,
}: MeasurementPanelProps) {
  const addMeasurement = useScopedMeasurementStore((s) => s.addMeasurement);

  if (selection.atoms.length === 0) return null;

  const handlePin = () => {
    if (measurement) addMeasurement(measurement);
  };

  return (
    <div
      data-testid="measurement-panel"
      data-selection-count={selection.atoms.length}
      style={{
        position: "absolute",
        bottom,
        right: 12,
        background: "rgba(255, 255, 255, 0.92)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderRadius: 10,
        padding: "12px 16px",
        fontSize: 13,
        color: "#1e293b",
        boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
        border: "1px solid rgba(226,232,240,0.6)",
        zIndex: 15,
        minWidth: 180,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <strong style={{ letterSpacing: "-0.01em" }}>Selection</strong>
        <div style={{ display: "flex", gap: 4 }}>
          {measurement && (
            <button
              onClick={handlePin}
              data-testid="measurement-pin"
              title="Add to list"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#10b981",
                fontSize: 12,
                fontWeight: 500,
                padding: "2px 4px",
              }}
            >
              Pin
            </button>
          )}
          <button
            onClick={onClear}
            data-testid="measurement-clear"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#3b82f6",
              fontSize: 12,
              fontWeight: 500,
              padding: "2px 4px",
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div style={{ marginBottom: 6, fontSize: 12, color: "#64748b" }}>
        {selection.atoms.map((idx, i) => (
          <span key={idx}>
            {i > 0 && " — "}
            <strong>{elements ? getElementSymbol(elements[idx]) : "?"}</strong>
            {idx}
          </span>
        ))}
      </div>
      {measurement && (
        <div
          style={{
            padding: "6px 0",
            borderTop: "1px solid #e2e8f0",
            fontSize: 14,
            fontWeight: 600,
            color: "#3b82f6",
          }}
        >
          {MEASUREMENT_LABELS[measurement.type]}: {measurement.label}
        </div>
      )}
      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
        Right-click atoms to select (max 4)
      </div>
    </div>
  );
}
