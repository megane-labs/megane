/**
 * The sidebar's cell card: what the cell is, read-only, with a way into the
 * Structure menu's Cell dialog. Editing the cell, supercells, slabs and
 * vacuum live in that menu (`CrystalDialog`); the card only reports, plus the
 * one-time offer to expand a file's symmetry operations, which matters right
 * after opening a CIF.
 */

import { useBuilderStore, canEdit, shownSnapshot } from "../store";
import { buttonStyle, hintStyle, rowStyle, sectionStyle, sectionTitleStyle } from "../styles";
import { newFragmentId } from "../library/fragment";
import { cellSummary, type CrystalDialogKind } from "./CrystalDialog";
import { hasCellBox, symmetryOpsAvailable } from "./structure";

export function CellCard({ onOpen }: { onOpen: (kind: CrystalDialogKind) => void }) {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const pushOp = useBuilderStore((s) => s.pushOp);

  const shown = shownSnapshot({ source, result, showOriginal });
  const editable = canEdit({ source, result, showOriginal });
  const hasCell = hasCellBox(shown?.box);
  const symOps = symmetryOpsAvailable(source, edits);

  return (
    <div style={sectionStyle} data-testid="builder-crystal">
      <div style={{ ...rowStyle, justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span style={sectionTitleStyle}>Cell</span>
        <span style={hintStyle} data-testid="builder-crystal-cell-summary">
          {shown && hasCell ? cellSummary(shown.box!) : "No cell"}
        </span>
      </div>
      {symOps > 0 && (
        <div
          style={{
            ...rowStyle,
            padding: "6px 8px",
            borderRadius: 6,
            background: "rgba(59, 130, 246, 0.08)",
          }}
          data-testid="builder-crystal-symmetry"
        >
          <span style={hintStyle}>
            This file lists {symOps} symmetry operation{symOps === 1 ? "" : "s"} for its asymmetric
            unit.
          </span>
          <button
            type="button"
            data-testid="builder-crystal-expand-symmetry"
            style={buttonStyle("primary", !editable)}
            disabled={!editable}
            onClick={() => pushOp({ op: "expand_symmetry", id: newFragmentId("symmetry") })}
            title="Fill the unit cell with the symmetry-equivalent atoms (as the viewer's Symmetry node does)"
          >
            Expand symmetry
          </button>
        </div>
      )}
      {shown && (
        <div style={rowStyle}>
          <button
            type="button"
            data-testid="builder-cell-edit"
            style={buttonStyle()}
            onClick={() => onOpen("cell")}
          >
            {hasCell ? "Edit cell…" : "Set cell…"}
          </button>
          <span style={hintStyle}>Supercell, slab and vacuum: Structure menu.</span>
        </div>
      )}
    </div>
  );
}
