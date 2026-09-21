/**
 * "New structure": the one place a document starts from scratch, as an
 * empty cubic cell or a bulk crystal. Both replace whatever is open, which
 * the dialog says once instead of every form repeating it.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { BulkSpec } from "../crystal/bulk";
import { BulkForm } from "./crystal/BulkForm";
import { NumberField } from "./crystal/NumberField";
import { buttonStyle, hintStyle, rowStyle, segmentGroupStyle, segmentStyle } from "./styles";

/** Default edge of a new cell, in Å. */
export const DEFAULT_NEW_CELL_EDGE = 10;

export type NewStructureKind = "cell" | "bulk";

const KINDS: { value: NewStructureKind; label: string }[] = [
  { value: "cell", label: "Empty cell" },
  { value: "bulk", label: "Bulk crystal" },
];

export interface NewStructureDialogProps {
  initialKind?: NewStructureKind;
  /** Whether a document is open (the dialog then warns that it is replaced). */
  hasDocument: boolean;
  onNewCell: (edge: number) => void;
  onNewBulk: (spec: BulkSpec) => void;
  onClose: () => void;
}

export function NewStructureDialog({
  initialKind = "cell",
  hasDocument,
  onNewCell,
  onNewBulk,
  onClose,
}: NewStructureDialogProps) {
  const [kind, setKind] = useState<NewStructureKind>(initialKind);
  const [edge, setEdge] = useState(DEFAULT_NEW_CELL_EDGE);
  const [error, setError] = useState<string | null>(null);
  const edgeValid = Number.isFinite(edge) && edge > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      data-testid="builder-new-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="New structure"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(520px, 94vw)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 16,
          borderRadius: 10,
          background: "var(--megane-surface-solid, #fff)",
          color: "var(--megane-text, #1e293b)",
          border: "1px solid var(--megane-border-solid, #e2e8f0)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700 }}>New structure</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="builder-new-close"
            style={buttonStyle()}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div style={segmentGroupStyle} role="tablist">
          {KINDS.map((k) => (
            <span
              key={k.value}
              role="tab"
              aria-selected={kind === k.value}
              data-testid={`builder-new-kind-${k.value}`}
              style={segmentStyle(kind === k.value)}
              onClick={() => {
                setKind(k.value);
                setError(null);
              }}
            >
              {k.label}
            </span>
          ))}
        </div>
        {kind === "cell" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={hintStyle}>
              An atom-less cubic cell to build into. The cell is what the camera frames and what
              free atoms are placed against.
            </div>
            <div style={rowStyle}>
              <NumberField
                label="Edge"
                value={edge}
                onChange={setEdge}
                testId="builder-new-cell-edge"
                min={0.1}
                width={64}
              />
              <span style={hintStyle}>Å</span>
              <button
                type="button"
                data-testid="builder-new-cell"
                style={buttonStyle("primary", !edgeValid)}
                disabled={!edgeValid}
                onClick={() => {
                  onNewCell(edge);
                  onClose();
                }}
              >
                Create empty cell
              </button>
            </div>
          </div>
        ) : (
          <BulkForm
            onCreate={(spec) => {
              onNewBulk(spec);
              onClose();
            }}
            onError={setError}
          />
        )}
        {error && (
          <div
            data-testid="builder-new-error"
            role="alert"
            style={{ ...hintStyle, color: "#b91c1c" }}
          >
            {error}
          </div>
        )}
        {hasDocument && (
          <div style={{ ...hintStyle, color: "#b45309" }} data-testid="builder-new-replaces">
            This replaces the open structure and its history.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
