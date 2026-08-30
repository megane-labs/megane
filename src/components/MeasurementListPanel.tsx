/**
 * Panel listing all pinned measurements with hide/show, rename, delete, and export actions.
 */

import { useState } from "react";
import { useScopedMeasurementStore } from "../stores/MeganeProvider";
import { MEASUREMENT_BOTTOM_DEFAULT } from "./overlayLayout";
import { exportToCSV, exportToJSON, downloadFile } from "../utils/measurementExport";
import { getElementSymbol } from "../constants";

const TYPE_ICON: Record<string, string> = {
  distance: "↔",
  angle: "∠",
  dihedral: "⟳",
};

interface MeasurementListPanelProps {
  elements: Uint8Array | null;
  /**
   * Distance from the viewer's bottom edge in px. Defaults to
   * {@link MEASUREMENT_BOTTOM_DEFAULT}; hosts that hide the Timeline pass a
   * smaller value so the panel doesn't float above an empty band.
   */
  bottom?: number;
}

interface RowProps {
  id: string;
  name: string;
  type: string;
  label: string;
  atoms: number[];
  hidden: boolean;
  elements: Uint8Array | null;
}

function MeasurementRow({ id, name, type, label, atoms, hidden, elements }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const { renameMeasurement, toggleVisibility, removeMeasurement } = useScopedMeasurementStore();

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed) renameMeasurement(id, trimmed);
    else setDraft(name);
    setEditing(false);
  };

  const atomLabels = atoms
    .map((idx) => (elements ? getElementSymbol(elements[idx]) : "?") + idx)
    .join(" — ");

  return (
    <div
      data-testid="measurement-list-row"
      data-measurement-id={id}
      style={{
        padding: "6px 0",
        borderBottom: "1px solid #e2e8f0",
        opacity: hidden ? 0.45 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 14, minWidth: 18, color: "#3b82f6" }}>{TYPE_ICON[type]}</span>
        {editing ? (
          <input
            data-testid="measurement-rename-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(name);
                setEditing(false);
              }
            }}
            style={{
              flex: 1,
              fontSize: 12,
              fontWeight: 600,
              border: "1px solid #3b82f6",
              borderRadius: 3,
              padding: "1px 4px",
              outline: "none",
            }}
          />
        ) : (
          <span
            data-testid="measurement-name"
            title="Double-click to rename"
            onDoubleClick={() => {
              setDraft(name);
              setEditing(true);
            }}
            style={{ flex: 1, fontSize: 12, fontWeight: 600, cursor: "text", userSelect: "none" }}
          >
            {name}
          </span>
        )}
        <span
          data-testid="measurement-value"
          style={{ fontSize: 12, color: "#3b82f6", fontWeight: 600, marginRight: 4 }}
        >
          {label}
        </span>
        <button
          data-testid="measurement-toggle-visibility"
          title={hidden ? "Show" : "Hide"}
          onClick={() => toggleVisibility(id)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            padding: 2,
          }}
        >
          {hidden ? "○" : "●"}
        </button>
        <button
          data-testid="measurement-delete"
          title="Delete"
          onClick={() => removeMeasurement(id)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            color: "#ef4444",
            padding: 2,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginLeft: 22 }}>{atomLabels}</div>
    </div>
  );
}

export function MeasurementListPanel({
  elements,
  bottom = MEASUREMENT_BOTTOM_DEFAULT,
}: MeasurementListPanelProps) {
  const { measurements, clearAll } = useScopedMeasurementStore();

  if (measurements.length === 0) return null;

  const handleExportCSV = () => {
    downloadFile(exportToCSV(measurements), "measurements.csv", "text/csv");
  };

  const handleExportJSON = () => {
    downloadFile(exportToJSON(measurements), "measurements.json", "application/json");
  };

  return (
    <div
      data-testid="measurement-list-panel"
      style={{
        position: "absolute",
        bottom,
        left: 12,
        background: "rgba(255, 255, 255, 0.92)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderRadius: 10,
        padding: "12px 14px",
        fontSize: 13,
        color: "#1e293b",
        boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
        border: "1px solid rgba(226,232,240,0.6)",
        zIndex: 15,
        minWidth: 220,
        maxWidth: 300,
        maxHeight: 340,
        overflowY: "auto",
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
        <strong style={{ letterSpacing: "-0.01em" }}>Measurements ({measurements.length})</strong>
        <button
          data-testid="measurement-list-clear"
          onClick={clearAll}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#94a3b8",
            fontSize: 11,
            padding: "2px 4px",
          }}
        >
          Clear all
        </button>
      </div>

      {measurements.map((m) => (
        <MeasurementRow key={m.id} {...m} elements={elements} />
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button
          data-testid="measurement-export-csv"
          onClick={handleExportCSV}
          style={{
            flex: 1,
            fontSize: 11,
            padding: "4px 0",
            background: "#f1f5f9",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            cursor: "pointer",
            color: "#374151",
          }}
        >
          CSV
        </button>
        <button
          data-testid="measurement-export-json"
          onClick={handleExportJSON}
          style={{
            flex: 1,
            fontSize: 11,
            padding: "4px 0",
            background: "#f1f5f9",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            cursor: "pointer",
            color: "#374151",
          }}
        >
          JSON
        </button>
      </div>
    </div>
  );
}
