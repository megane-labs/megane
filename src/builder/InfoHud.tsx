/**
 * The info line over the top of the view, where the viewer shows its atom
 * and bond counts: the document (its name and how many edits it carries) and
 * the structure on screen (formula, atoms and bonds, molar mass, cell). It
 * reports only — nothing on it is a control — so it lets clicks through to
 * the view. While a Structure dialog previews an operation, it describes the
 * preview (the status line says so).
 */

import { useMemo } from "react";
import type { Snapshot } from "../types";
import { overlayButtonStyle } from "../components/toolbarStyles";
import { cellSummary, structureSummary } from "./summary";
import { monoStyle } from "./styles";
import { hasCellBox } from "./crystal/structure";

export interface InfoHudProps {
  /** The document's name, or null before anything is open. */
  fileName: string | null;
  /** Edit steps in the document's history. */
  steps: number;
  /** What the view draws (the document, or a Structure dialog's preview). */
  viewed: Snapshot | null;
  /** Left edge, clear of Reset View. */
  left: number;
  /** Right edge, clear of the panels. */
  right: number;
}

export function InfoHud({ fileName, steps, viewed, left, right }: InfoHudProps) {
  const summary = useMemo(() => (viewed ? structureSummary(viewed) : null), [viewed]);
  const sep = <span style={{ color: "var(--megane-text-faint, #cbd5e1)" }}>·</span>;
  return (
    <div
      data-testid="builder-info"
      style={{
        position: "absolute",
        top: 12,
        left,
        zIndex: 10,
        pointerEvents: "none",
        display: "flex",
        justifyContent: "flex-start",
        maxWidth: `calc(100% - ${left + right}px)`,
      }}
    >
      <div
        style={{
          ...overlayButtonStyle,
          cursor: "default",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 6,
          rowGap: 4,
          lineHeight: 1.2,
          fontVariantNumeric: "tabular-nums",
          minWidth: 0,
        }}
      >
        <span
          data-testid="builder-file-name"
          style={{ fontWeight: 600, color: "var(--megane-text, #1e293b)" }}
        >
          {fileName ?? "No structure"}
          {steps > 0 && ` · ${steps} edit${steps === 1 ? "" : "s"}`}
        </span>
        {viewed && summary && (
          <>
            {sep}
            <span data-testid="builder-inspector-formula" style={monoStyle}>
              {summary.formula || "—"}
            </span>
            {sep}
            <span data-testid="builder-status-atoms">
              {viewed.nAtoms} atoms · {viewed.nBonds} bonds
            </span>
            {sep}
            <span>
              <span data-testid="builder-inspector-mass">{summary.mass.toFixed(2)}</span> g/mol
            </span>
            {sep}
            <span data-testid="builder-crystal-cell-summary">
              {hasCellBox(viewed.box) ? cellSummary(viewed.box!) : "No cell"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
